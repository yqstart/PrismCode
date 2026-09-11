<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import {
  ArrowDown,
  ArrowUp,
  CloudDownload,
  GitBranch,
  RefreshCw,
  Search,
  Tag,
  X,
} from "lucide-vue-next";
import { PLAIN_INPUT_ATTRS } from "@/shared/plainInput";
import { joinPath } from "@/shared/fs";
import {
  gitBranchSides,
  gitCommitFiles,
  type GitCommitInfo,
  type GitFileChange,
  type GitStashEntry,
} from "@/shared/gitApi";
import { useGitLogStore } from "@/stores/gitLog";
import { useGitStore } from "@/stores/git";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import { useI18n } from "@/i18n";
import { layoutGitGraph, type GraphRowLayout } from "@/features/git/gitGraph";
import {
  childCommitId,
  parentCommitId,
  preferredVisibleCommitId,
} from "@/features/git/gitLogNavigation";

type RowKind = "stash" | "commit";

interface GraphRow {
  kind: RowKind;
  key: string;
  /** commit / stash oid */
  id?: string;
  stashIndex?: number;
  summary: string;
  author?: string;
  time?: string;
  refs?: string[];
  files?: string[];
  changes?: GitFileChange[];
  body?: string;
  unpushed?: boolean;
  merge?: boolean;
  graph?: GraphRowLayout;
}

type CtxTarget =
  | { kind: "commit"; id: string }
  | { kind: "stash"; index: number }
  | { kind: "ref"; name: string; isRemote: boolean; isTag: boolean };

const { t } = useI18n();
const git = useGitStore();
const gitLog = useGitLogStore();
const workspace = useWorkspaceStore();
const settings = useSettingsStore();
const {
  log,
  loading,
  snapshot,
  stashes,
  changelistEntries,
  branches,
  tags,
} = storeToRefs(git);
const {
  selectedId,
  open: logOpen,
  isFocused: logFocused,
} = storeToRefs(gitLog);

const filter = ref("");
const filterOpen = ref(false);
const showRemote = ref(true);
const showTags = ref(true);
const showStashes = ref(true);
const showDate = ref(true);
const showAuthor = ref(true);
const showCommit = ref(true);
const branchScope = ref<"all" | "current" | "selected">("all");
const selectedBranches = ref<string[]>([]);
const branchMenuOpen = ref(false);
const columnMenuOpen = ref(false);
const ctx = ref<{ x: number; y: number; target: CtxTarget } | null>(null);
/** 选中行：stash:N | commitOid。未提交更改由 Commit 面板负责。 */
const selectedKey = ref<string | null>(null);
const rootRef = ref<HTMLElement | null>(null);
const tbodyRef = ref<HTMLElement | null>(null);
const initializing = ref(false);
const compareBaseId = ref<string | null>(null);
const compareIds = ref<string[]>([]);
const comparisonFiles = ref<GitFileChange[]>([]);
const reviewState = ref<Record<string, boolean>>({});
const reviewActive = ref(false);
let loadSeq = 0;
let comparisonSeq = 0;
let sidesSeq = 0;
let workspaceGeneration = 0;

const dirtyCount = computed(() => changelistEntries.value.length);
const graphWidth = computed(() => {
  const maxLane = rows.value.reduce(
    (max, row) => Math.max(max, row.graph?.laneCount ?? 0),
    0,
  );
  return Math.max(56, Math.min(184, 18 + maxLane * 16));
});
const columnStyle = computed(() => {
  const columns = [
    `${graphWidth.value}px`,
    "minmax(0, 1fr)",
    ...(showDate.value ? ["148px"] : []),
    ...(showAuthor.value ? ["100px"] : []),
    ...(showCommit.value ? ["82px"] : []),
  ];
  return { gridTemplateColumns: columns.join(" ") };
});

const branchRefs = computed(() =>
  branches.value
    .filter((branch) => showRemote.value || !branch.isRemote)
    .map((branch) => branch.name),
);

const branchFilterLabel = computed(() => {
  if (branchScope.value === "current") {
    return snapshot.value.branch ?? t("gitLog.currentBranch");
  }
  if (branchScope.value === "selected") {
    return t("gitLog.selectedBranches", {
      count: selectedBranches.value.length,
    });
  }
  return t("gitLog.showAll");
});

function refIsRemote(name: string) {
  return (
    branches.value.some((branch) => branch.isRemote && branch.name === name) ||
    name.endsWith("/HEAD")
  );
}

function refIsTag(name: string) {
  return tags.value.some((tag) => tag.name === name);
}

function isRemoteRef(name: string) {
  return refIsRemote(name);
}

function isTagRef(name: string) {
  return refIsTag(name);
}

function refClass(name: string) {
  if (name.startsWith("stash@")) return "ref stash";
  if (isTagRef(name)) return "ref tag";
  if (isRemoteRef(name)) {
    return name.endsWith("/HEAD") ? "ref remote-head" : "ref remote";
  }
  return "ref local";
}

function refNameOf(name: string) {
  return name.replace(/^refs\/(heads|remotes|tags)\//, "");
}

function tagTitle(name: string) {
  const tag = tags.value.find((item) => item.name === name);
  if (!tag) return name;
  const details = [tag.tagger, tag.time, tag.message].filter(Boolean).join(" · ");
  return details ? `${name} · ${details}` : name;
}

function branchReachable(branchNames: string[] | null): Set<string> | null {
  if (!branchNames?.length) return null;
  const byId = new Map(log.value.map((commit) => [commit.id, commit]));
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const commit of log.value) {
    if ((commit.refs ?? []).some((ref) => branchNames.includes(ref))) {
      queue.push(commit.id);
    }
  }
  while (queue.length) {
    const id = queue.pop();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    const commit = byId.get(id);
    if (!commit) continue;
    for (const parent of commit.parents ?? []) queue.push(parent);
  }
  return visited;
}

const rows = computed<GraphRow[]>(() => {
  const q = filter.value.trim().toLowerCase();
  const out: GraphRow[] = [];

  if (showStashes.value) {
    for (const stash of stashes.value) {
      const row: GraphRow = {
        kind: "stash",
        key: `stash:${stash.index}`,
        id: stash.id,
        stashIndex: stash.index,
        summary: stashLabel(stash),
        author: "stash",
        time: "",
        refs: [`stash@{${stash.index}}`],
      };
      if (
        !q ||
        row.summary.toLowerCase().includes(q) ||
        row.refs?.some((ref) => ref.toLowerCase().includes(q))
      ) {
        out.push(row);
      }
    }
  }

  const selectedBranchNames =
    branchScope.value === "current"
      ? snapshot.value.branch
        ? [snapshot.value.branch]
        : null
      : branchScope.value === "selected"
        ? selectedBranches.value
        : null;
  const reachable = branchReachable(selectedBranchNames);

  for (const item of log.value) {
    if (reachable && !reachable.has(item.id)) continue;
    let refs = item.refs ?? [];
    if (!showRemote.value) refs = refs.filter((ref) => !isRemoteRef(ref));
    if (!showTags.value) refs = refs.filter((ref) => !isTagRef(ref));
    const changes =
      item.changes?.length > 0
        ? item.changes
        : item.files.map((path) => ({
            path,
            oldPath: null,
            status: "modified",
          }));
    const row: GraphRow = {
      kind: "commit",
      key: item.id,
      id: item.id,
      summary: item.summary,
      author: item.author,
      time: item.time,
      refs,
      files: item.files,
      changes,
      body: item.body,
      unpushed: item.unpushed,
      merge: (item.parents?.length ?? 0) > 1,
    };
    const searchable = [
      row.summary,
      row.author ?? "",
      row.id ?? "",
      row.body ?? "",
      ...(row.refs ?? []),
      ...(row.files ?? []),
    ]
      .join(" ")
      .toLowerCase();
    if (!q || searchable.includes(q)) out.push(row);
  }

  const layout = layoutGitGraph(
    out
      .filter((row): row is GraphRow & { id: string } => row.kind === "commit" && Boolean(row.id))
      .map((row) => {
        const commit = log.value.find((item) => item.id === row.id);
        return { id: row.id, parents: commit?.parents ?? [] };
      }),
  );
  const layoutById = new Map(layout.map((item) => [item.id, item]));
  return out.map((row) =>
    row.kind === "commit" && row.id
      ? { ...row, graph: layoutById.get(row.id) }
      : row,
  );
});

function preferredVisibleRowKey(list: readonly GraphRow[]): string | null {
  const preferred = preferredVisibleCommitId(
    log.value,
    list.flatMap((row) =>
      row.kind === "commit" && row.id ? [row.id] : [],
    ),
    snapshot.value.head,
  );
  if (preferred) {
    const match = list.find((row) => row.id === preferred);
    if (match) return match.key;
  }
  return list[0]?.key ?? null;
}

const selectedRow = computed(
  () =>
    rows.value.find((row) => row.key === selectedKey.value) ??
    rows.value[0] ??
    null,
);

const selectedCommit = computed<GitCommitInfo | null>(() => {
  const row = selectedRow.value;
  if (!row || row.kind !== "commit" || !row.id) return null;
  return log.value.find((commit) => commit.id === row.id) ?? null;
});

const detailChanges = computed<GitFileChange[]>(() => {
  if (compareIds.value.length === 2) return comparisonFiles.value;
  return selectedCommit.value?.changes ?? [];
});

const detailReviewKey = computed(() => {
  if (compareIds.value.length === 2) {
    return `compare:${compareIds.value.join(":")}`;
  }
  return selectedCommit.value ? `commit:${selectedCommit.value.id}` : null;
});

const detailBodyParts = computed(() => {
  const body =
    compareIds.value.length === 2
      ? ""
      : selectedCommit.value?.body?.trim() ?? "";
  if (!body) return [];
  const parts: Array<{ text: string; url?: string }> = [];
  const urlPattern = /(https?:\/\/[^\s]+)/g;
  let cursor = 0;
  for (const match of body.matchAll(urlPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ text: body.slice(cursor, index) });
    const url = match[0];
    parts.push({ text: url, url });
    cursor = index + url.length;
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor) });
  return parts;
});

function stashLabel(stash: GitStashEntry) {
  const message = stash.message
    .replace(/^On [^:]+:\s*/i, "")
    .replace(/^WIP on [^:]+:\s*/i, "");
  return message || stash.message || `stash@{${stash.index}}`;
}

function shortHash(id?: string) {
  return id ? id.slice(0, 8) : "";
}

function rowTitle(row: GraphRow) {
  if (row.kind !== "commit") return row.summary;
  const head =
    snapshot.value.head && row.id?.startsWith(snapshot.value.head)
      ? " · HEAD"
      : "";
  return `${row.id}${head}${row.refs?.length ? ` · ${row.refs.join(", ")}` : ""}`;
}

async function ensureLog() {
  if (!workspace.rootPath) return;
  const root = workspace.rootPath;
  const generation = workspaceGeneration;
  const seq = ++loadSeq;
  if (!log.value.length) initializing.value = true;
  try {
    if (!snapshot.value.initialized) await git.refresh();
    if (
      !snapshot.value.initialized ||
      seq !== loadSeq ||
      workspace.rootPath !== root ||
      workspaceGeneration !== generation
    ) {
      return;
    }
    // loadLog 不传 limit：沿用 store 权威 logLimit，避免 loadMore 到 240 条后
    // 任意 ensureLog（刷新/checkout）把日志缩回硬编码的 120 条。
    await Promise.all([git.loadLog(), git.refresh()]);
    if (
      seq !== loadSeq ||
      workspace.rootPath !== root ||
      workspaceGeneration !== generation
    ) {
      return;
    }
    if (!selectedKey.value) {
      selectedKey.value = preferredVisibleRowKey(rows.value);
    }
  } finally {
    if (seq === loadSeq) initializing.value = false;
  }
}

async function loadMore() {
  if (loading.value) return;
  await git.loadMoreLog();
}

function clearComparison(resetBase = false) {
  comparisonSeq += 1;
  compareIds.value = [];
  comparisonFiles.value = [];
  reviewActive.value = false;
  if (resetBase) compareBaseId.value = null;
}

function selectRow(key: string) {
  selectedKey.value = key;
  const row = rows.value.find((item) => item.key === key);
  if (row?.kind === "commit" && row.id) {
    gitLog.selectCommit(row.id);
    compareBaseId.value = row.id;
  }
  ctx.value = null;
  void nextTick(() => rootRef.value?.focus({ preventScroll: true }));
}

async function selectForComparison(id: string) {
  const base = compareBaseId.value ?? selectedId.value;
  if (!base || base === id) {
    clearComparison();
    compareBaseId.value = id;
    selectRow(id);
    return;
  }
  compareIds.value = [base, id];
  selectedKey.value = id;
  gitLog.selectCommit(id);
  await loadComparison();
}

async function loadComparison() {
  if (!workspace.rootPath || compareIds.value.length !== 2) return;
  const root = workspace.rootPath;
  const generation = workspaceGeneration;
  const seq = ++comparisonSeq;
  const ids = [compareIds.value[0]!, compareIds.value[1]!] as const;
  try {
    const files = await gitCommitFiles(root, ids[0], ids[1]);
    if (
      seq !== comparisonSeq ||
      workspace.rootPath !== root ||
      workspaceGeneration !== generation ||
      compareIds.value[0] !== ids[0] ||
      compareIds.value[1] !== ids[1]
    ) {
      return;
    }
    comparisonFiles.value = files;
    reviewActive.value = false;
    loadReviewState();
  } catch (error) {
    if (
      seq !== comparisonSeq ||
      workspace.rootPath !== root ||
      workspaceGeneration !== generation
    ) {
      return;
    }
    workspace.showNotice(
      error instanceof Error ? error.message : String(error),
      3200,
    );
  }
}

function onRowClick(event: MouseEvent, row: GraphRow) {
  if (
    row.kind === "commit" &&
    row.id &&
    (event.metaKey || event.ctrlKey)
  ) {
    void selectForComparison(row.id);
    return;
  }
  clearComparison();
  selectRow(row.key);
}

function onCtx(event: MouseEvent, row: GraphRow) {
  event.preventDefault();
  event.stopPropagation();
  clearComparison();
  selectRow(row.key);
  if (row.kind === "commit" && row.id) {
    ctx.value = {
      x: event.clientX,
      y: event.clientY,
      target: { kind: "commit", id: row.id },
    };
  } else if (row.kind === "stash" && row.stashIndex != null) {
    ctx.value = {
      x: event.clientX,
      y: event.clientY,
      target: { kind: "stash", index: row.stashIndex },
    };
  }
}

function onRefCtx(event: MouseEvent, name: string) {
  event.preventDefault();
  event.stopPropagation();
  const isTag = isTagRef(name);
  ctx.value = {
    x: event.clientX,
    y: event.clientY,
    target: {
      kind: "ref",
      name,
      isRemote: !isTag && isRemoteRef(name),
      isTag,
    },
  };
}

async function onShowDiff(id: string, filePath?: string) {
  ctx.value = null;
  const item = log.value.find((commit) => commit.id === id);
  const path = filePath ?? item?.changes?.[0]?.path ?? item?.files?.[0];
  if (!path) {
    workspace.showNotice(t("gitLog.noDiffFiles"));
    return;
  }
  const parent = item?.parents?.[0] ?? "";
  await openSides(parent, id, path, `${path} · ${id.slice(0, 7)}`);
}

async function onCheckout(id: string) {
  ctx.value = null;
  await git.checkoutCommit(id);
  await ensureLog();
}

async function onCherryPick(id: string) {
  ctx.value = null;
  await git.cherryPick(id);
  await ensureLog();
}

async function onRevertCommit(id: string) {
  ctx.value = null;
  await git.revertCommit(id);
  await ensureLog();
}

async function onReset(id: string, mode: "soft" | "mixed" | "hard") {
  ctx.value = null;
  await git.resetTo(id, mode);
  await ensureLog();
}

async function onCompareCurrent(id: string) {
  const right = snapshot.value.head ?? snapshot.value.branch;
  if (!right) return;
  const item = log.value.find((commit) => commit.id === id);
  const path = item?.changes?.[0]?.path ?? item?.files?.[0];
  if (!path) {
    workspace.showNotice(t("gitLog.noDiffFiles"));
    return;
  }
  await openSides(id, right, path, `${path} · HEAD`);
}

async function onShowComparisonDiff(path: string) {
  if (compareIds.value.length !== 2) return;
  await openSides(
    compareIds.value[0]!,
    compareIds.value[1]!,
    path,
    `${path} · ${compareIds.value[0]!.slice(0, 7)} ↔ ${compareIds.value[1]!.slice(0, 7)}`,
  );
}

async function openSides(
  leftRef: string,
  rightRef: string,
  path: string,
  title: string,
) {
  if (!workspace.rootPath) return;
  const root = workspace.rootPath;
  const generation = workspaceGeneration;
  const seq = ++sidesSeq;
  try {
    const sides = await gitBranchSides(root, leftRef, rightRef, path);
    if (
      seq !== sidesSeq ||
      workspace.rootPath !== root ||
      workspaceGeneration !== generation
    ) {
      return;
    }
    const { useCompareStore } = await import("@/stores/compare");
    if (
      seq !== sidesSeq ||
      workspace.rootPath !== root ||
      workspaceGeneration !== generation
    ) {
      return;
    }
    const compare = useCompareStore();
    compare.upsertTab({
      id: `log-diff-${Date.now()}`,
      kind: "diff",
      path: sides.path,
      title,
      leftLabel: sides.leftLabel.slice(0, 18),
      rightLabel: sides.rightLabel.slice(0, 18),
      left: sides.left,
      right: sides.right,
      editableRight: false,
    });
    gitLog.blurLog();
  } catch (error) {
    if (
      seq !== sidesSeq ||
      workspace.rootPath !== root ||
      workspaceGeneration !== generation
    ) {
      return;
    }
    workspace.showNotice(
      error instanceof Error ? error.message : String(error),
      3200,
    );
  }
}

async function onOpenCurrentFile(path: string) {
  if (!workspace.rootPath) return;
  const root = workspace.rootPath;
  const generation = workspaceGeneration;
  const { useEditorStore } = await import("@/stores/editor");
  if (workspace.rootPath !== root || workspaceGeneration !== generation) return;
  await useEditorStore().openFile(joinPath(root, path));
}

async function onCopyPath(path: string) {
  try {
    await navigator.clipboard.writeText(path);
    workspace.showNotice(t("gitLog.copiedPath"));
  } catch {
    workspace.showNotice(t("gitLog.copyFailed"));
  }
}

async function onInteractiveRebase(id: string) {
  ctx.value = null;
  const item = log.value.find((commit) => commit.id === id);
  const onto = item?.parents?.[0];
  if (!onto) {
    workspace.showNotice(t("gitLog.noOnto"));
    return;
  }
  const { openInteractiveRebase } = await import("@/shared/gitRebaseDialog");
  await openInteractiveRebase({
    onto,
    title: t("gitLog.rebaseTitle", { hash: id.slice(0, 7) }),
  });
}

async function onNewBranch(id: string) {
  ctx.value = null;
  const { promptInput } = await import("@/shared/promptDialog");
  const name = await promptInput({
    title: t("gitLog.newBranchTitle"),
    label: t("gitLog.newBranchLabel"),
    placeholder: "feature/from-commit",
    confirmText: t("gitLog.newBranchConfirm"),
  });
  if (!name?.trim()) return;
  await git.createBranchAt(name.trim(), id, true);
  await ensureLog();
}

async function onCreateTag(id: string) {
  ctx.value = null;
  const { promptInput } = await import("@/shared/promptDialog");
  const name = await promptInput({
    title: t("gitLog.createTagTitle"),
    label: t("gitLog.tagName"),
    placeholder: "v1.0.0",
    confirmText: t("gitLog.createTagConfirm"),
  });
  if (!name?.trim()) return;
  const message = await promptInput({
    title: t("gitLog.annotatedTagTitle"),
    label: t("gitLog.annotatedTagLabel"),
    placeholder: t("gitLog.annotatedTagPlaceholder"),
    confirmText: t("common.ok"),
  });
  await git.createTagAt(name.trim(), id, message?.trim() || undefined);
  await ensureLog();
}

async function onCopy(id: string, message = t("gitLog.copiedHash")) {
  ctx.value = null;
  try {
    await navigator.clipboard.writeText(id);
    workspace.showNotice(message);
  } catch {
    workspace.showNotice(t("gitLog.copyFailed"));
  }
}

async function onCheckoutRef(name: string, isRemote: boolean) {
  ctx.value = null;
  if (isRemote) await git.checkoutRemote(name);
  else await git.checkout(name);
  await ensureLog();
}

async function onRefAction(name: string, action: "merge" | "rebase" | "compare") {
  ctx.value = null;
  // 仅去掉 origin/ 前缀；本地分支名可能自带斜杠（feature/foo），
  // slice(1) 会把它们误截断成 foo 导致合并找不到分支
  const localName = name.startsWith("origin/") ? name.slice("origin/".length) : name;
  if (action === "merge") await git.mergeBranch(localName);
  else if (action === "rebase") await git.rebaseBranch(name);
  else await git.compareBranchWithCurrent(name);
  await ensureLog();
}

async function onRenameRef(name: string) {
  ctx.value = null;
  const { promptInput } = await import("@/shared/promptDialog");
  const next = await promptInput({
    title: t("branches.renameTitle"),
    label: t("branches.renameLabel"),
    defaultValue: name,
    confirmText: t("branches.renameConfirm"),
  });
  if (!next?.trim() || next.trim() === name) return;
  await git.renameBranch(name, next.trim());
  await ensureLog();
}

async function onDeleteRef(name: string, isRemote: boolean, isTag: boolean) {
  ctx.value = null;
  if (isTag) await git.deleteTag(name);
  else if (isRemote) await git.deleteRemoteBranch(name);
  else await git.deleteBranch(name);
  await ensureLog();
}

async function onPushTag(name: string) {
  ctx.value = null;
  await git.pushTag(name);
}

function openCommitPanel() {
  ctx.value = null;
  settings.openCommitPanel();
}

async function onStashPop(index: number) {
  ctx.value = null;
  await git.stashPop(index);
  await ensureLog();
}

async function onStashApply(index: number) {
  ctx.value = null;
  await git.stashApply(index);
  await ensureLog();
}

async function onStashDrop(index: number) {
  ctx.value = null;
  await git.stashDrop(index);
  await ensureLog();
}

function detailFiles(row: GraphRow | null): string[] {
  if (!row) return [];
  if (row.kind === "commit") {
    return selectedCommit.value?.files ?? row.files ?? [];
  }
  return row.files ?? [];
}

function toggleBranch(name: string) {
  const next = new Set(selectedBranches.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  selectedBranches.value = [...next];
  branchScope.value = "selected";
}

function selectAllBranches() {
  selectedBranches.value = [];
  branchScope.value = "all";
  branchMenuOpen.value = false;
}

function selectCurrentBranch() {
  selectedBranches.value = [];
  branchScope.value = "current";
  branchMenuOpen.value = false;
}

function loadReviewState() {
  const key = detailReviewKey.value;
  if (!key) {
    reviewState.value = {};
    return;
  }
  try {
    const raw = localStorage.getItem(`prismcode:git-review:${workspace.rootPath}:${key}`);
    reviewState.value = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    reviewState.value = {};
  }
}

function persistReviewState() {
  const key = detailReviewKey.value;
  if (!key) return;
  localStorage.setItem(
    `prismcode:git-review:${workspace.rootPath}:${key}`,
    JSON.stringify(reviewState.value),
  );
}

function startReview() {
  reviewActive.value = true;
  reviewState.value = {};
  persistReviewState();
}

function toggleReviewed(path: string) {
  if (!reviewActive.value) return;
  reviewState.value = {
    ...reviewState.value,
    [path]: !reviewState.value[path],
  };
  persistReviewState();
}

function isReviewed(path: string) {
  return reviewActive.value && reviewState.value[path] === true;
}

function scrollToRow(key: string) {
  void nextTick(() => {
    const element = Array.from(tbodyRef.value?.children ?? []).find(
      (child) => (child as HTMLElement).dataset.rowKey === key,
    ) as HTMLElement | undefined;
    element?.scrollIntoView({ block: "center" });
  });
}

function moveSelection(delta: number) {
  const index = rows.value.findIndex((row) => row.key === selectedKey.value);
  if (index < 0) return;
  const next = rows.value[Math.max(0, Math.min(rows.value.length - 1, index + delta))];
  if (!next) return;
  clearComparison();
  selectRow(next.key);
  scrollToRow(next.key);
}

function moveToRelatedCommit(direction: "parent" | "child") {
  const current = selectedCommit.value?.id;
  if (!current) return;
  const target =
    direction === "parent"
      ? parentCommitId(log.value, current)
      : childCommitId(log.value, current);
  if (!target || !rows.value.some((row) => row.id === target)) return;
  clearComparison();
  selectRow(target);
  scrollToRow(target);
}

function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

function focusLogRoot() {
  rootRef.value?.focus({ preventScroll: true });
}

function onLogScroll(event: Event) {
  const element = event.currentTarget as HTMLElement;
  if (element.scrollTop + element.clientHeight >= element.scrollHeight - 80) {
    void loadMore();
  }
}

function onDocMouseDown(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (
    target?.closest("[data-gitlog-ctx]") ||
    target?.closest("[data-branch-picker]") ||
    target?.closest("[data-column-picker]")
  ) {
    return;
  }
  ctx.value = null;
  branchMenuOpen.value = false;
  columnMenuOpen.value = false;
}

function onKeydown(event: KeyboardEvent) {
  if (!logOpen.value || !gitLog.isFocused) return;
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === "f") {
    event.preventDefault();
    filterOpen.value = true;
    void nextTick(() => document.querySelector<HTMLInputElement>(".git-log-filter")?.focus());
  } else if (isTextInputTarget(event.target)) {
    return;
  } else if (mod && event.key.toLowerCase() === "r") {
    event.preventDefault();
    void ensureLog();
  } else if (mod && event.key.toLowerCase() === "h") {
    event.preventDefault();
    const head = log.value.find(
      (commit) => snapshot.value.head && commit.id.startsWith(snapshot.value.head),
    );
    if (head) scrollToRow(head.id);
  } else if (mod && event.key.toLowerCase() === "s") {
    event.preventDefault();
    const stashRows = rows.value.filter((row) => row.kind === "stash");
    const target = event.shiftKey ? stashRows[stashRows.length - 1] : stashRows[0];
    if (target) scrollToRow(target.key);
  } else if (event.key === "Escape") {
    ctx.value = null;
    branchMenuOpen.value = false;
    if (compareIds.value.length) clearComparison();
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    moveSelection(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveSelection(-1);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    moveToRelatedCommit("parent");
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    moveToRelatedCommit("child");
  }
}

onMounted(() => {
  document.addEventListener("mousedown", onDocMouseDown, true);
  if (logOpen.value) void ensureLog();
  if (logFocused.value) void nextTick(focusLogRoot);
});

onBeforeUnmount(() => {
  loadSeq += 1;
  comparisonSeq += 1;
  sidesSeq += 1;
  document.removeEventListener("mousedown", onDocMouseDown, true);
});

watch(
  () => workspace.rootPath,
  () => {
    workspaceGeneration += 1;
    loadSeq += 1;
    sidesSeq += 1;
    clearComparison(true);
    selectedKey.value = null;
  },
);

watch(logOpen, (open) => {
  if (open) void ensureLog();
});

watch(logFocused, (focused) => {
  if (focused) void nextTick(focusLogRoot);
});

watch(rows, (list) => {
  if (!list.length) {
    selectedKey.value = null;
    return;
  }
  if (!selectedKey.value || !list.some((row) => row.key === selectedKey.value)) {
    selectedKey.value = preferredVisibleRowKey(list);
  }
});

watch(detailReviewKey, loadReviewState, { immediate: true });

watch(selectedId, (id) => {
  if (id) selectedKey.value = id;
});
</script>

<template>
  <div
    ref="rootRef"
    class="log-panel"
    tabindex="0"
    @click="ctx = null"
    @keydown="onKeydown"
  >
    <div v-if="!snapshot.initialized" class="empty">{{ t("gitLog.notInit") }}</div>
    <template v-else>
      <div class="toolbar">
        <div class="branch-picker" data-branch-picker @click.stop>
          <button
            type="button"
            class="tool-button branch-button"
            :class="{ active: branchMenuOpen }"
            @click="branchMenuOpen = !branchMenuOpen"
          >
            <GitBranch :size="14" />
            <span>{{ branchFilterLabel }}</span>
          </button>
          <div v-if="branchMenuOpen" class="branch-menu">
            <button type="button" :class="{ selected: branchScope === 'all' }" @click="selectAllBranches">
              {{ t("gitLog.showAll") }}
            </button>
            <button type="button" :class="{ selected: branchScope === 'current' }" @click="selectCurrentBranch">
              {{ t("gitLog.currentBranch") }}
            </button>
            <div class="menu-divider" />
            <label v-for="name in branchRefs" :key="name" class="branch-option">
              <input
                type="checkbox"
                :checked="selectedBranches.includes(name)"
                @change="toggleBranch(name)"
              />
              <span :class="refClass(name)">{{ refNameOf(name) }}</span>
            </label>
            <div v-if="!branchRefs.length" class="menu-empty">{{ t("gitLog.noBranches") }}</div>
          </div>
        </div>
        <label class="check">
          <input v-model="showRemote" type="checkbox" />
          {{ t("gitLog.showRemote") }}
        </label>
        <button
          v-if="dirtyCount > 0"
          type="button"
          class="tool-button changes-button"
          @click="openCommitPanel"
        >
          {{ t("gitLog.uncommitted", { count: dirtyCount }) }}
        </button>
        <label class="check">
          <input v-model="showTags" type="checkbox" />
          {{ t("gitLog.showTags") }}
        </label>
        <label class="check">
          <input v-model="showStashes" type="checkbox" />
          {{ t("gitLog.showStashes") }}
        </label>
        <div class="spacer" />
        <button type="button" class="icon-btn" :title="t('git.fetch')" @click="git.fetchRemote(); ensureLog()">
          <CloudDownload :size="14" />
        </button>
        <button type="button" class="icon-btn" :title="t('git.pull')" @click="git.pull(); ensureLog()">
          <ArrowDown :size="14" />
        </button>
        <button type="button" class="icon-btn" :title="t('git.push')" @click="git.pushWithDialog(); ensureLog()">
          <ArrowUp :size="14" />
        </button>
        <div class="column-picker" data-column-picker @click.stop>
          <button type="button" class="icon-btn" :class="{ active: columnMenuOpen }" :title="t('gitLog.columns')" @click="columnMenuOpen = !columnMenuOpen">⋮</button>
          <div v-if="columnMenuOpen" class="column-menu">
            <label><input v-model="showDate" type="checkbox" /> {{ t("gitLog.showDate") }}</label>
            <label><input v-model="showAuthor" type="checkbox" /> {{ t("gitLog.showAuthor") }}</label>
            <label><input v-model="showCommit" type="checkbox" /> {{ t("gitLog.showCommit") }}</label>
          </div>
        </div>
        <button
          type="button"
          class="icon-btn"
          :class="{ active: filterOpen }"
          :title="t('gitLog.filter')"
          @click="filterOpen = !filterOpen"
        >
          <Search :size="14" />
        </button>
        <button type="button" class="icon-btn" :title="t('common.refresh')" @click="ensureLog()">
          <RefreshCw :size="14" :class="{ spin: loading }" />
        </button>
        <button type="button" class="link" @click="loadMore">
          {{ t("gitLog.loadMore") }}
        </button>
      </div>

      <div v-if="filterOpen" class="filter-bar">
        <input
          v-model="filter"
          v-bind="PLAIN_INPUT_ATTRS"
          class="filter git-log-filter"
          type="text"
          :placeholder="t('gitLog.filterPlaceholder')"
        />
      </div>

      <div v-if="compareIds.length === 2" class="compare-banner">
        <span>{{ t("gitLog.comparing", { count: detailChanges.length }) }}</span>
        <code>{{ compareIds[0]?.slice(0, 8) }} ↔ {{ compareIds[1]?.slice(0, 8) }}</code>
        <button type="button" class="link" @click="clearComparison(true)">
          {{ t("gitLog.clearComparison") }}
        </button>
      </div>

      <div v-if="initializing && !log.length" class="empty">{{ t("gitLog.loading") }}</div>
      <div v-else-if="!rows.length" class="empty">{{ t("gitLog.empty") }}</div>
      <div v-else class="split">
        <div class="table-wrap">
          <div class="thead" :style="columnStyle">
            <span class="col graph-h">{{ t("gitLog.graph") }}</span>
            <span class="col desc-h">{{ t("gitLog.description") }}</span>
            <span v-if="showDate" class="col date-h">{{ t("gitLog.date") }}</span>
            <span v-if="showAuthor" class="col author-h">{{ t("gitLog.author") }}</span>
            <span v-if="showCommit" class="col hash-h">{{ t("gitLog.commit") }}</span>
          </div>
          <div ref="tbodyRef" class="tbody" @scroll="onLogScroll">
            <div
              v-for="row in rows"
              :key="row.key"
              class="tr"
              :data-row-key="row.key"
              :style="columnStyle"
              :class="{
                active: selectedRow?.key === row.key,
                comparing: compareIds.includes(row.id ?? ''),
                stash: row.kind === 'stash',
              }"
              :title="rowTitle(row)"
              @click="onRowClick($event, row)"
              @contextmenu="onCtx($event, row)"
            >
              <div class="col graph-c" aria-hidden="true">
                <svg
                  v-if="row.kind === 'commit' && row.graph"
                  class="graph-svg"
                  :viewBox="`0 0 ${graphWidth} 34`"
                  preserveAspectRatio="none"
                >
                  <line
                    v-for="(line, lineIndex) in row.graph.connectors"
                    :key="lineIndex"
                    class="graph-line"
                    :x1="8 + line.from * 16"
                    :y1="line.fromY * 34"
                    :x2="8 + line.to * 16"
                    :y2="line.toY * 34"
                  />
                  <circle
                    class="graph-node"
                    :class="{ head: row.id && snapshot.head && row.id.startsWith(snapshot.head), merge: row.merge }"
                    :cx="8 + row.graph.lane * 16"
                    cy="17"
                    r="4.5"
                  />
                </svg>
                <span v-else class="simple-node stash" />
              </div>
              <div class="col desc-c">
                <span
                  v-for="refName in row.refs ?? []"
                  :key="refName"
                  :class="refClass(refName)"
                  :title="isTagRef(refName) ? tagTitle(refName) : refName"
                  @click.stop
                  @contextmenu.stop="onRefCtx($event, refName)"
                >
                  {{ refNameOf(refName) }}
                </span>
                <span v-if="row.unpushed" class="badge">{{ t("gitLog.unpushed") }}</span>
                <span class="summary" :class="{ bold: row.kind !== 'commit' }">{{ row.summary }}</span>
              </div>
              <div v-if="showDate" class="col date-c">{{ row.time || "—" }}</div>
              <div v-if="showAuthor" class="col author-c">{{ row.author || "—" }}</div>
              <div v-if="showCommit" class="col hash-c" :title="row.id">
                {{ row.kind === "commit" || row.kind === "stash" ? shortHash(row.id) : "" }}
              </div>
            </div>
          </div>
        </div>

        <aside v-if="selectedRow" class="detail">
          <template v-if="compareIds.length === 2">
            <div class="detail-head">
              <div class="detail-title">{{ t("gitLog.comparisonTitle") }}</div>
              <button type="button" class="close-detail" :title="t('gitLog.clearComparison')" @click="clearComparison(true)">
                <X :size="14" />
              </button>
              <div class="meta">
                <span class="id">{{ compareIds[0]?.slice(0, 12) }}</span>
                <span>↔</span>
                <span class="id">{{ compareIds[1]?.slice(0, 12) }}</span>
              </div>
            </div>
          </template>
          <template v-else>
            <div class="detail-head">
              <div class="detail-title">{{ selectedRow.summary }}</div>
              <div v-if="selectedRow.kind === 'commit'" class="meta">
                <span class="id" :title="selectedRow.id">{{ selectedRow.id?.slice(0, 12) }}</span>
                <span>{{ selectedRow.author }}</span>
                <span>{{ selectedRow.time }}</span>
              </div>
              <div v-else-if="selectedRow.kind === 'stash'" class="meta">
                <span class="id">stash@{{ selectedRow.stashIndex }}</span>
                <span :title="selectedRow.id">{{ shortHash(selectedRow.id) }}</span>
              </div>
            </div>
            <div v-if="selectedRow.refs?.length" class="ref-row">
              <span
                v-for="refName in selectedRow.refs"
                :key="refName"
                :class="refClass(refName)"
                :title="isTagRef(refName) ? tagTitle(refName) : refName"
                @contextmenu.stop="onRefCtx($event, refName)"
              >
                {{ refNameOf(refName) }}
              </span>
            </div>
            <div v-if="selectedCommit?.body" class="commit-body">
              <template v-for="(part, index) in detailBodyParts" :key="index">
                <a v-if="part.url" :href="part.url" target="_blank" rel="noreferrer" @click.stop>{{ part.text }}</a>
                <span v-else>{{ part.text }}</span>
              </template>
            </div>
            <div v-if="selectedCommit?.parents?.length" class="parents">
              <span class="section-label">{{ t("gitLog.parents") }}</span>
              <button
                v-for="parent in selectedCommit.parents"
                :key="parent"
                type="button"
                class="parent"
                @click="selectRow(parent)"
              >
                {{ parent.slice(0, 10) }}
              </button>
            </div>
            <div v-if="selectedRow.kind === 'commit'" class="detail-actions">
              <button type="button" @click="selectedRow.id && onShowDiff(selectedRow.id)">
                {{ t("gitLog.showDiff") }}
              </button>
              <button type="button" @click="selectedRow.id && onCompareCurrent(selectedRow.id)">
                {{ t("gitLog.compareCurrent") }}
              </button>
              <button type="button" @click="selectedRow.id && onCreateTag(selectedRow.id)">
                <Tag :size="12" /> {{ t("gitLog.createTag") }}
              </button>
              <button v-if="detailChanges.length" type="button" @click="startReview">
                {{ t("gitLog.startReview") }}
              </button>
            </div>
          </template>

          <div class="files-head">
            {{ compareIds.length === 2 ? t("gitLog.comparisonFiles") : selectedRow.kind === "stash" ? t("git.stashes") : t("gitLog.files") }}
            <span v-if="detailChanges.length || detailFiles(selectedRow).length" class="count">
              {{ compareIds.length === 2 ? detailChanges.length : detailChanges.length || detailFiles(selectedRow).length }}
            </span>
          </div>
          <div v-if="selectedRow.kind === 'stash' && compareIds.length !== 2" class="muted">
            {{ t("gitLog.stashHint") }}
          </div>
          <div v-else-if="!detailChanges.length && !detailFiles(selectedRow).length" class="muted">
            {{ t("gitLog.noFiles") }}
          </div>
          <div v-else class="file-list">
            <div
              v-for="change in detailChanges"
              :key="change.path"
              class="file-row"
              :class="{ reviewed: isReviewed(change.path) }"
            >
              <input
                v-if="reviewActive"
                type="checkbox"
                :checked="isReviewed(change.path)"
                :aria-label="t('gitLog.reviewFile')"
                @change="toggleReviewed(change.path)"
              />
              <span class="change-status" :class="`status-${change.status}`">{{ change.status.slice(0, 1).toUpperCase() }}</span>
              <button
                type="button"
                class="file"
                :title="change.path"
                @click="compareIds.length === 2 ? onShowComparisonDiff(change.path) : selectedCommit?.id && onShowDiff(selectedCommit.id, change.path)"
              >
                {{ change.path }}
              </button>
              <button type="button" class="file-action" :title="t('gitLog.openCurrent')" @click="onOpenCurrentFile(change.path)">↗</button>
              <button type="button" class="file-action" :title="t('gitLog.copyPath')" @click="onCopyPath(change.path)">⧉</button>
            </div>
            <template v-if="!detailChanges.length">
              <button
                v-for="file in detailFiles(selectedRow)"
                :key="file"
                type="button"
                class="file"
                :title="file"
                @click="selectedCommit?.id && onShowDiff(selectedCommit.id, file)"
              >
                {{ file }}
              </button>
            </template>
          </div>
        </aside>
      </div>
    </template>

    <Teleport to="body">
      <div
        v-if="ctx"
        class="ctx"
        data-gitlog-ctx
        :style="{ left: `${ctx.x}px`, top: `${ctx.y}px` }"
        @click.stop
      >
        <template v-if="ctx.target.kind === 'commit'">
          <button type="button" @click="onCheckout(ctx.target.id)">{{ t("gitLog.checkout") }}</button>
          <button type="button" @click="onNewBranch(ctx.target.id)">{{ t("gitLog.newBranch") }}</button>
          <button type="button" @click="onCreateTag(ctx.target.id)">{{ t("gitLog.createTag") }}</button>
          <button type="button" @click="onCopy(ctx.target.id)">{{ t("gitLog.copyRevision") }}</button>
          <button type="button" @click="onShowDiff(ctx.target.id)">{{ t("gitLog.showDiff") }}</button>
          <button type="button" @click="onCompareCurrent(ctx.target.id)">{{ t("gitLog.compareCurrent") }}</button>
          <div class="menu-divider" />
          <button type="button" @click="onCherryPick(ctx.target.id)">{{ t("gitLog.cherryPick") }}</button>
          <button type="button" @click="onRevertCommit(ctx.target.id)">{{ t("gitLog.revert") }}</button>
          <button type="button" @click="onInteractiveRebase(ctx.target.id)">{{ t("gitLog.rebase") }}</button>
          <div class="menu-divider" />
          <button type="button" @click="onReset(ctx.target.id, 'soft')">{{ t("gitLog.resetSoft") }}</button>
          <button type="button" @click="onReset(ctx.target.id, 'mixed')">{{ t("gitLog.resetMixed") }}</button>
          <button type="button" class="danger" @click="onReset(ctx.target.id, 'hard')">{{ t("gitLog.resetHard") }}</button>
        </template>
        <template v-else-if="ctx.target.kind === 'ref'">
          <button type="button" @click="onCheckoutRef(ctx.target.name, ctx.target.isRemote)">{{ t("gitLog.checkoutRef") }}</button>
          <template v-if="!ctx.target.isTag">
            <button type="button" @click="onRefAction(ctx.target.name, 'merge')">{{ t("gitLog.mergeRef") }}</button>
            <button type="button" @click="onRefAction(ctx.target.name, 'rebase')">{{ t("gitLog.rebaseRef") }}</button>
            <button type="button" @click="onRefAction(ctx.target.name, 'compare')">{{ t("gitLog.compareRef") }}</button>
            <button v-if="!ctx.target.isRemote" type="button" @click="onRenameRef(ctx.target.name)">{{ t("gitLog.renameRef") }}</button>
          </template>
          <button type="button" @click="onCopy(ctx.target.name, t('gitLog.copiedRef'))">{{ t("gitLog.copyRef") }}</button>
          <button v-if="ctx.target.isTag" type="button" @click="onPushTag(ctx.target.name)">{{ t("gitLog.pushTag") }}</button>
          <button type="button" class="danger" @click="onDeleteRef(ctx.target.name, ctx.target.isRemote, ctx.target.isTag)">{{ t("gitLog.deleteRef") }}</button>
        </template>
        <template v-else>
          <button type="button" @click="onStashApply(ctx.target.index)">{{ t("gitLog.applyStash") }}</button>
          <button type="button" @click="onStashPop(ctx.target.index)">{{ t("gitLog.popStash") }}</button>
          <button type="button" class="danger" @click="onStashDrop(ctx.target.index)">{{ t("gitLog.dropStash") }}</button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.log-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-app);
}
.log-panel:focus {
  outline: none;
}
.changes-button {
  color: var(--warning);
}
.toolbar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-panel);
  font-size: 12px;
}
.branch-picker {
  position: relative;
  flex-shrink: 0;
}
.tool-button,
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 26px;
  border-radius: 5px;
  color: var(--text-secondary);
}
.tool-button {
  max-width: 190px;
  padding: 0 8px;
}
.tool-button span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-button:hover,
.tool-button.active,
.icon-btn:hover,
.icon-btn.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.icon-btn {
  width: 26px;
  color: var(--text-muted);
}
.check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

/* 文字描述区域恢复文本选择（body 全局 user-select:none 防误选）：
   提交描述列与详情面板的文字可选中复制（⌘/Ctrl+C），
   工具栏按钮 / 勾选框 / 图列仍保持不可选。 */
.tr .desc-c,
.tr .date-c,
.tr .author-c,
.tr .hash-c,
.detail .detail-title,
.detail .meta,
.detail .commit-body,
.detail .ref-row,
.detail .muted,
.detail .files-head,
.detail .file-list .file,
.detail .parents .parent,
.detail .parents .section-label {
  user-select: text;
  -webkit-user-select: text;
}
.check input,
.branch-option input {
  accent-color: var(--accent);
}
.spacer {
  flex: 1;
}
.toolbar .link,
.compare-banner .link {
  flex-shrink: 0;
  color: var(--accent);
  font-size: 12px;
}
.toolbar .link:hover,
.compare-banner .link:hover {
  text-decoration: underline;
}
.branch-menu {
  position: absolute;
  z-index: 20;
  top: calc(100% + 6px);
  left: 0;
  width: 250px;
  max-height: min(420px, 60vh);
  padding: 5px;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-elevated);
  box-shadow: var(--shadow-modal);
}
.column-picker {
  position: relative;
  flex-shrink: 0;
}
.column-menu {
  position: absolute;
  z-index: 20;
  top: calc(100% + 6px);
  right: 0;
  width: 150px;
  padding: 5px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-elevated);
  box-shadow: var(--shadow-modal);
}
.column-menu label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px;
  border-radius: 5px;
  color: var(--text-primary);
  font-size: 12px;
}
.column-menu label:hover {
  background: var(--accent-soft);
}
.column-menu input {
  accent-color: var(--accent);
}
.branch-menu > button,
.branch-option {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 7px;
  padding: 7px 8px;
  border-radius: 5px;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
}
.branch-menu > button:hover,
.branch-option:hover,
.branch-menu > button.selected {
  background: var(--accent-soft);
}
.menu-empty {
  padding: 10px 8px;
  color: var(--text-muted);
  font-size: 12px;
}
.menu-divider {
  height: 1px;
  margin: 4px 0;
  background: var(--border-subtle);
}
.filter-bar {
  flex-shrink: 0;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-panel);
}
.filter {
  width: 100%;
  height: 28px;
  box-sizing: border-box;
  padding: 0 9px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-app);
  color: var(--text-primary);
  font-size: 12px;
}
.compare-banner {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 9px;
  padding: 6px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border-subtle));
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
  color: var(--text-secondary);
  font-size: 11px;
}
.compare-banner code,
.id,
.hash-c {
  font-family: var(--font-mono);
}
.empty {
  display: grid;
  flex: 1;
  place-items: center;
  color: var(--text-muted);
  font-size: 13px;
}
.split {
  display: flex;
  flex: 1;
  min-height: 0;
}
.table-wrap {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  border-right: 1px solid var(--border-subtle);
}
.thead,
.tr {
  display: grid;
  grid-template-columns: var(--graph-width) minmax(0, 1fr) 148px 100px 82px;
  align-items: stretch;
}
.thead {
  flex-shrink: 0;
  height: 28px;
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-panel);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
}
.thead .col {
  padding: 0 8px;
}
.tbody {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.tr {
  min-height: 34px;
  height: 34px;
  cursor: default;
  border-bottom: 1px solid color-mix(in srgb, var(--border-subtle) 60%, transparent);
  font-size: 12px;
}
.tr:hover {
  background: var(--accent-soft);
}
.tr.active {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.tr.comparing {
  box-shadow: inset 3px 0 0 var(--accent);
}
.col {
  display: flex;
  min-width: 0;
  align-items: center;
  padding: 4px 8px;
}
.graph-c {
  position: relative;
  justify-content: center;
  padding: 0;
  overflow: hidden;
}
.graph-svg {
  width: 100%;
  height: 34px;
  overflow: visible;
}
.graph-line {
  fill: none;
  stroke: color-mix(in srgb, var(--accent) 56%, var(--text-muted));
  stroke-width: 1.6;
  vector-effect: non-scaling-stroke;
}
.graph-node {
  fill: #60a5fa;
  stroke: color-mix(in srgb, #60a5fa 35%, transparent);
  stroke-width: 3;
}
.graph-node.head {
  fill: var(--accent);
  stroke: color-mix(in srgb, var(--accent) 36%, transparent);
}
.graph-node.merge {
  fill: var(--warning);
}
.simple-node {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #a78bfa;
  box-shadow: 0 0 0 2px color-mix(in srgb, #a78bfa 24%, transparent);
}
.desc-c {
  gap: 5px;
  overflow: hidden;
}
.summary {
  overflow: hidden;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.summary.bold {
  font-weight: 600;
}
.date-c,
.author-c {
  overflow: hidden;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hash-c {
  overflow: hidden;
  color: var(--text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ref {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  height: 18px;
  max-width: 160px;
  padding: 0 6px;
  overflow: hidden;
  border-radius: 9px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ref.local {
  background: color-mix(in srgb, #3b82f6 18%, transparent);
  color: #3b82f6;
}
.ref.remote {
  background: color-mix(in srgb, var(--text-muted) 16%, transparent);
  color: var(--text-secondary);
}
.ref.remote-head {
  border: 1px solid color-mix(in srgb, #3b82f6 50%, transparent);
  background: transparent;
  color: #3b82f6;
}
.ref.tag {
  background: color-mix(in srgb, #f59e0b 18%, transparent);
  color: #d97706;
}
.ref.stash {
  background: color-mix(in srgb, #a78bfa 20%, transparent);
  color: #a78bfa;
}
.badge {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  height: 16px;
  padding: 0 5px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--warning) 20%, transparent);
  color: var(--warning);
  font-size: 10px;
}
.detail {
  display: flex;
  flex-shrink: 0;
  flex-direction: column;
  width: min(390px, 42%);
  min-height: 0;
  background: var(--bg-panel);
}
.detail-head {
  position: relative;
  padding: 13px 14px 9px;
  border-bottom: 1px solid var(--border-subtle);
}
.detail-title {
  padding-right: 22px;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}
.close-detail {
  position: absolute;
  top: 10px;
  right: 10px;
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 5px;
  color: var(--text-muted);
}
.close-detail:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
  color: var(--text-muted);
  font-size: 11px;
}
.id {
  color: var(--accent);
}
.ref-row,
.parents {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border-subtle);
}
.parents {
  align-items: center;
  gap: 5px;
}
.section-label {
  color: var(--text-muted);
  font-size: 11px;
}
.parent {
  padding: 2px 5px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 11px;
}
.parent:hover {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}
.commit-body {
  max-height: 130px;
  padding: 9px 14px;
  overflow: auto;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.commit-body a {
  color: var(--accent);
}
.detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border-subtle);
}
.detail-actions button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 7px;
  border: 1px solid var(--border-subtle);
  border-radius: 5px;
  color: var(--text-secondary);
  font-size: 11px;
}
.detail-actions button:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.detail-actions button.danger {
  color: var(--danger);
}
.files-head {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 7px;
  padding: 10px 14px 6px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
}
.files-head .count {
  color: var(--text-muted);
  font-weight: 500;
}
.muted {
  padding: 8px 14px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.45;
}
.file-list {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  padding: 0 8px 8px;
  overflow: auto;
}
.file-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  padding: 2px 3px;
  border-radius: 5px;
}
.file-row:hover {
  background: var(--accent-soft);
}
.file-row.reviewed .file {
  color: var(--text-muted);
  text-decoration: line-through;
}
.change-status {
  display: inline-grid;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  place-items: center;
  border-radius: 3px;
  background: color-mix(in srgb, var(--text-muted) 18%, transparent);
  color: var(--text-secondary);
  font-size: 10px;
  font-weight: 700;
}
.status-added {
  background: color-mix(in srgb, var(--success) 18%, transparent);
  color: var(--success);
}
.status-deleted {
  background: color-mix(in srgb, var(--danger) 18%, transparent);
  color: var(--danger);
}
.status-renamed {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--accent);
}
.file {
  flex: 1;
  min-width: 0;
  padding: 5px;
  overflow: hidden;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file:hover {
  color: var(--accent);
}
.file-action {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border-radius: 4px;
  color: var(--text-muted);
  font-size: 13px;
}
.file-action:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.ctx {
  position: fixed;
  z-index: 90;
  display: flex;
  flex-direction: column;
  min-width: 224px;
  max-height: calc(100vh - 16px);
  padding: 4px;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-elevated);
  box-shadow: var(--shadow-modal);
}
.ctx button {
  padding: 7px 10px;
  border-radius: 5px;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
}
.ctx button:hover {
  background: var(--accent-soft);
}
.ctx button.danger {
  color: var(--danger);
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 900px) {
  .check {
    display: none;
  }
  .detail {
    width: min(330px, 44%);
  }
  .thead,
  .tr {
    grid-template-columns: var(--graph-width) minmax(0, 1fr) 112px 78px;
  }
  .hash-h,
  .hash-c {
    display: none;
  }
}
</style>
