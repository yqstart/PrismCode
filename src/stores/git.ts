import { computed, ref } from "vue";
import { defineStore } from "pinia";
import {
  gitBlame,
  gitBranchSides,
  gitBranches,
  gitCheckout,
  gitCheckoutCommit,
  gitCheckoutRemote,
  gitCherryPick,
  gitCommit,
  gitCreateTag,
  gitCreateBranch,
  gitCreateBranchAt,
  gitDeleteTag,
  gitDeleteBranch,
  gitDeleteRemoteBranch,
  gitDiff,
  gitDiscardPaths,
  gitFetch,
  gitInit,
  gitLog,
  gitMergeBranch,
  gitMergeAbort,
  gitPull,
  gitPush,
  gitRebaseAbort,
  gitRebaseBranch,
  gitRebaseContinue,
  gitRebaseInteractive,
  gitRebasePlan,
  gitRebaseSkip,
  gitRebaseStatus,
  gitRenameBranch,
  gitReset,
  gitResetHard,
  gitResolveConflict,
  gitRevertCommit,
  gitRevertTo,
  gitSetUpstream,
  gitStage,
  gitStash,
  gitStashApply,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitPushTag,
  gitTags,
  gitStatus,
  gitUndoCommit,
  gitUnstage,
  gitUpdateProject,
  type GitAuthPayload,
  type GitBranchInfo,
  type GitCommitInfo,
  type GitDiffResult,
  type GitRebaseStatus,
  type GitRebaseStep,
  type GitStashEntry,
  type GitStatusEntry,
  type GitStatusSnapshot,
  type GitTagInfo,
} from "@/shared/gitApi";
import { t } from "@/i18n";
import { relativeToRoot } from "@/shared/fs";
import { useWorkspaceStore } from "@/stores/workspace";

const EMPTY: GitStatusSnapshot = {
  initialized: false,
  branch: null,
  upstream: null,
  head: null,
  ahead: 0,
  behind: 0,
  entries: [],
  conflictCount: 0,
};

const EMPTY_REBASE: GitRebaseStatus = {
  inProgress: false,
  kind: "none",
  headName: null,
  onto: null,
  conflicted: false,
};

export const useGitStore = defineStore("git", () => {
  const snapshot = ref<GitStatusSnapshot>({ ...EMPTY });
  const branches = ref<GitBranchInfo[]>([]);
  const tags = ref<GitTagInfo[]>([]);
  const log = ref<GitCommitInfo[]>([]);
  const stashes = ref<GitStashEntry[]>([]);
  const logLimit = ref(80);
  const conflictFiles = ref<string[]>([]);
  const rebaseStatus = ref<GitRebaseStatus>({ ...EMPTY_REBASE });
  const diffResults = ref<GitDiffResult[]>([]);
  const diffTitle = ref("");
  const diffVisible = ref(false);
  const loading = ref(false);
  const commitMessage = ref("");
  const amendCommit = ref(false);
  /// 远端操作（push/pull/fetch/update）进行中：用于禁用重复点击。
  /// 注意：**不会**影响其他 UI 元素（活动栏/标签/资源树），
  /// 它们走完全独立的 store 与组件树，互不阻塞。
  const remoteInFlight = ref(false);
  let refreshSeq = 0;
  let refreshAgain = false;
  /** 短时间内的 UI 刷新请求合并为一次五路 IPC，避免文件切换/保存/聚焦
   * 产生刷新风暴；Git 操作完成后的 await refresh() 仍保持即时语义。 */
  const REFRESH_DEBOUNCE_MS = 300;
  let scheduledRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduledRefreshResolvers: Array<() => void> = [];
  /** 当前刷新循环的 Promise；并发调用会排队补刷，并等待最终结果。 */
  let activeRefreshPromise: Promise<void> | null = null;
  /** Git 索引写入队列：多窗口或快速点击暂存时不能让后写入的旧索引覆盖前一次结果。 */
  let indexOperationQueue: Promise<void> = Promise.resolve();
  /** 工作区切换代际：阻止排队中的暂存/取消暂存落到新工作区。 */
  let workspaceOperationSeq = 0;
  /** 日志加载专用序号：与 refreshSeq 解耦。
   *  loadLog 与 refresh 并发时（GitLogPanel ensureLog 的 Promise.all），
   *  refresh 自增 refreshSeq 会把 loadLog 结果系统性作废——面板打开/刷新
   *  时日志永远停在旧数据。独立序号只对并发 loadLog 互斥（旧 limit 不
   *  覆盖新 limit），工作区切换防护改由 root 对比承担。 */
  let logSeq = 0;
  /** 整组 Diff 弹层请求序号，关闭/切换工作区后使旧结果失效。 */
  let diffSeq = 0;

  const statusMap = computed(() => {
    const map = new Map<string, GitStatusEntry>();
    for (const e of snapshot.value.entries) {
      map.set(e.path, e);
    }
    return map;
  });

  const stagedEntries = computed(() =>
    snapshot.value.entries.filter((e) => e.staged && !e.conflicted),
  );

  const unstagedEntries = computed(() =>
    snapshot.value.entries.filter((e) => e.unstaged && !e.conflicted),
  );

  const conflictEntries = computed(() =>
    snapshot.value.entries.filter((e) => e.conflicted),
  );

  /** 可勾选提交的变更（非冲突） */
  const changelistEntries = computed(() =>
    snapshot.value.entries.filter((e) => !e.conflicted),
  );

  /** 有变更的文件数（含暂存/未暂存/冲突） */
  const changedFileCount = computed(() => snapshot.value.entries.length);

  /** WebStorm 勾选态：path → 是否纳入本次提交；新文件默认勾选 */
  const checkedMap = ref<Record<string, boolean>>({});
  const selectedPath = ref<string | null>(null);

  const checkedPaths = computed(() =>
    changelistEntries.value
      .filter((e) => checkedMap.value[e.path] !== false)
      .map((e) => e.path),
  );

  const checkedCount = computed(() => checkedPaths.value.length);

  const allChecked = computed(
    () =>
      changelistEntries.value.length > 0 &&
      changelistEntries.value.every((e) => checkedMap.value[e.path] !== false),
  );

  function syncCheckedPaths() {
    const prev = checkedMap.value;
    const next: Record<string, boolean> = {};
    for (const e of changelistEntries.value) {
      next[e.path] = prev[e.path] ?? true;
    }
    checkedMap.value = next;
    if (
      selectedPath.value &&
      !snapshot.value.entries.some((e) => e.path === selectedPath.value)
    ) {
      selectedPath.value = null;
    }
  }

  function setPathChecked(path: string, checked: boolean) {
    checkedMap.value = { ...checkedMap.value, [path]: checked };
  }

  function setAllChecked(checked: boolean) {
    const next: Record<string, boolean> = {};
    for (const e of changelistEntries.value) {
      next[e.path] = checked;
    }
    checkedMap.value = next;
  }

  function selectChange(path: string | null) {
    selectedPath.value = path;
  }

  /** 捕获一次 Git 操作所属的工作区，避免等待期间切换项目后继续更新当前 UI。 */
  function captureWorkspaceOperation() {
    const workspace = useWorkspaceStore();
    const root = workspace.rootPath;
    if (!root) return null;
    const operationSeq = workspaceOperationSeq;
    return {
      workspace,
      root,
      isCurrent: () =>
        workspace.rootPath === root && workspaceOperationSeq === operationSeq,
    };
  }

  function scheduleRefresh(): Promise<void> {
    return new Promise((resolve) => {
      scheduledRefreshResolvers.push(resolve);
      if (scheduledRefreshTimer !== null) clearTimeout(scheduledRefreshTimer);
      scheduledRefreshTimer = setTimeout(() => {
        scheduledRefreshTimer = null;
        const resolvers = scheduledRefreshResolvers;
        scheduledRefreshResolvers = [];
        void refresh().finally(() => {
          for (const done of resolvers) done();
        });
      }, REFRESH_DEBOUNCE_MS);
    });
  }

  /**
   * 刷新 Git 状态；已有刷新时只追加一轮，并让调用方等待最终一轮完成。
   * 这样 stage/unstage 等修改操作不会在旧快照仍显示时提前返回。
   */
  function refresh(): Promise<void> {
    const workspace = useWorkspaceStore();
    const root = workspace.rootPath;
    if (!root) {
      snapshot.value = { ...EMPTY };
      branches.value = [];
      tags.value = [];
      stashes.value = [];
      conflictFiles.value = [];
      rebaseStatus.value = { ...EMPTY_REBASE };
      checkedMap.value = {};
      selectedPath.value = null;
      return Promise.resolve();
    }
    if (activeRefreshPromise) {
      refreshAgain = true;
      return activeRefreshPromise;
    }

    loading.value = true;
    const seq = ++refreshSeq;
    const run = (async () => {
      try {
        do {
          refreshAgain = false;
          const next = await gitStatus(root);
          if (seq !== refreshSeq || workspace.rootPath !== root) return;
          snapshot.value = next;
          if (snapshot.value.initialized) {
            // 与 gitStatus 结果相互独立的 3 项查询并行化，缩短整体阻塞
            const [branchesRes, stashesRes, rebaseRes, tagsRes] = await Promise.all([
              gitBranches(root).catch(() => []),
              gitStashList(root).catch(() => []),
              gitRebaseStatus(root).catch(() => ({
                ...EMPTY_REBASE,
              })),
              gitTags(root).catch(() => []),
            ]);
            if (seq !== refreshSeq || workspace.rootPath !== root) return;
            branches.value = branchesRes;
            tags.value = tagsRes;
            stashes.value = stashesRes as typeof stashes.value;
            rebaseStatus.value = rebaseRes;
            // 冲突文件直接从 status 快照派生（entries 已带 conflicted 标记），
            // 省去 gitConflictFiles 内部再跑一次完整 status（此前在主线程重扫）
            conflictFiles.value =
              snapshot.value.conflictCount > 0
                ? snapshot.value.entries
                    .filter((e) => e.conflicted)
                    .map((e) => e.path)
                : [];
          } else {
            branches.value = [];
            tags.value = [];
            stashes.value = [];
            conflictFiles.value = [];
            rebaseStatus.value = { ...EMPTY_REBASE };
          }
          if (seq === refreshSeq && workspace.rootPath === root) syncCheckedPaths();
        } while (refreshAgain && seq === refreshSeq && workspace.rootPath === root);
      } catch (error) {
        if (seq === refreshSeq && workspace.rootPath === root) {
          workspace.showNotice(
            error instanceof Error ? error.message : String(error),
            3200,
          );
        }
      } finally {
        if (seq === refreshSeq && workspace.rootPath === root) loading.value = false;
      }
    })();

    const settled = run.finally(() => {
      if (refreshSeq === seq) activeRefreshPromise = null;
    });
    activeRefreshPromise = settled;
    return settled;
  }

  function enqueueIndexOperation(operation: () => Promise<void>): Promise<void> {
    const next = indexOperationQueue.then(operation, operation);
    indexOperationQueue = next.catch(() => {});
    return next;
  }

  async function initRepo() {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    try {
      await gitInit(root);
      if (!isCurrent()) return;
      workspace.showNotice(t("git.initOk"));
      await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function stage(paths: string[]) {
    const workspace = useWorkspaceStore();
    const root = workspace.rootPath;
    if (!root) return;
    const operationSeq = workspaceOperationSeq;
    await enqueueIndexOperation(async () => {
      // 请求排队期间可能已经切换工作区，不能把旧工作区的操作写入新工作区。
      if (
        workspace.rootPath !== root ||
        workspaceOperationSeq !== operationSeq
      ) {
        return;
      }
      try {
        // 空 paths 是后端约定的「全部暂存」，比依赖某一帧前端状态枚举更可靠。
        await gitStage(root, paths);
        if (
          workspace.rootPath !== root ||
          workspaceOperationSeq !== operationSeq
        ) {
          return;
        }
        await refresh();
      } catch (error) {
        if (
          workspace.rootPath !== root ||
          workspaceOperationSeq !== operationSeq
        ) {
          return;
        }
        workspace.showNotice(
          error instanceof Error ? error.message : String(error),
          3200,
        );
      }
    });
  }

  async function stageAll() {
    await stage([]);
  }

  async function unstage(paths: string[]) {
    const workspace = useWorkspaceStore();
    const root = workspace.rootPath;
    if (!root || !paths.length) return;
    const operationSeq = workspaceOperationSeq;
    await enqueueIndexOperation(async () => {
      if (
        workspace.rootPath !== root ||
        workspaceOperationSeq !== operationSeq
      ) {
        return;
      }
      try {
        await gitUnstage(root, paths);
        if (
          workspace.rootPath !== root ||
          workspaceOperationSeq !== operationSeq
        ) {
          return;
        }
        await refresh();
      } catch (error) {
        if (
          workspace.rootPath !== root ||
          workspaceOperationSeq !== operationSeq
        ) {
          return;
        }
        workspace.showNotice(
          error instanceof Error ? error.message : String(error),
          3200,
        );
      }
    });
  }

  async function commit(message?: string, paths?: string[]) {
    const operation = captureWorkspaceOperation();
    if (!operation) return false;
    const { workspace, root, isCurrent } = operation;
    const msg = (message ?? commitMessage.value).trim();
    if (!msg) {
      workspace.showNotice(t("git.needMessage"));
      return false;
    }
    // 显式 paths：先 stage 再提交；否则提交当前 index（已暂存）
    const explicit = paths?.length ? paths : undefined;
    if (!amendCommit.value && !explicit && !stagedEntries.value.length) {
      workspace.showNotice(t("git.needStaged"));
      return false;
    }
    try {
      await gitCommit(
        root,
        msg,
        amendCommit.value ? undefined : explicit,
        amendCommit.value,
      );
      if (!isCurrent()) return false;
      commitMessage.value = "";
      amendCommit.value = false;
      workspace.showNotice(t("git.commitOk"));
      await refresh();
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
      return false;
    }
  }

  /** Commit and Push（WebStorm） */
  async function commitAndPush(message?: string) {
    const ok = await commit(message);
    if (!ok) return;
    await pushWithDialog();
  }

  async function checkout(name: string) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    if (snapshot.value.branch === name) return;

    const dirty = snapshot.value.entries.length > 0;

    try {
      await gitCheckout(root, name, false);
      if (!isCurrent()) return;
      workspace.showNotice(t("git.switchedTo", { name }));
      await refresh();
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // 干净工作区，或明显不是「本地变更阻挡」：直接提示
      if (!shouldOfferDirtyCheckout(msg, dirty)) {
        if (!isCurrent()) return;
        workspace.showNotice(msg, 3200);
        return;
      }
    }

    if (!isCurrent()) return;

    // 有未提交变更且安全切换失败 → VS Code / WebStorm 风格处理
    const { promptChoice } = await import("@/shared/choiceDialog");
    const choice = await promptChoice({
      title: t("git.checkoutTitle"),
      message: t("git.checkoutDirtyMessage", { name }),
      choices: [
        { id: "cancel", label: t("common.cancel"), variant: "ghost" },
        { id: "force", label: t("git.forceCheckout"), variant: "danger" },
        { id: "smart", label: t("git.smartCheckout"), variant: "primary" },
      ],
      dismissId: "cancel",
    });

    if (!isCurrent() || !choice || choice === "cancel") return;

    try {
      if (choice === "smart") {
        await gitStash(root, `Prism Code: checkout ${name}`, true);
        if (!isCurrent()) return;
        await gitCheckout(root, name, false);
        if (!isCurrent()) return;
        try {
          await gitStashPop(root);
          if (!isCurrent()) return;
          workspace.showNotice(t("git.switchedRestored", { name }));
        } catch (popError) {
          if (!isCurrent()) return;
          const popMsg =
            popError instanceof Error ? popError.message : String(popError);
          workspace.showNotice(
            t("git.switchedStashConflict", { name, detail: popMsg }),
            4800,
          );
        }
      } else if (choice === "force") {
        await gitCheckout(root, name, true);
        if (!isCurrent()) return;
        workspace.showNotice(t("git.forceSwitched", { name }));
      }
      if (!isCurrent()) return;
      await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
      await refresh();
    }
  }

  function shouldOfferDirtyCheckout(message: string, dirty: boolean): boolean {
    if (!dirty) return false;
    const lower = message.toLowerCase();
    // 分支不存在等与本地变更无关的错误，不弹智能/强制
    if (
      lower.includes("not found") ||
      lower.includes("does not exist") ||
      lower.includes("ambiguous") ||
      message.includes("未找到")
    ) {
      return false;
    }
    return true;
  }

  async function createBranch(name: string, checkout = true) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    try {
      await gitCreateBranch(root, name, checkout);
      if (!isCurrent()) return;
      workspace.showNotice(t("git.branchCreated", { name }));
      await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function deleteBranch(name: string) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    if (!window.confirm(t("git.deleteBranchConfirm", { name }))) return;
    if (!isCurrent()) return;
    try {
      await gitDeleteBranch(root, name);
      if (!isCurrent()) return;
      workspace.showNotice(t("git.branchDeleted", { name }));
      await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function renameBranch(from: string, to: string) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    try {
      await gitRenameBranch(root, from, to);
      if (!isCurrent()) return;
      workspace.showNotice(t("git.branchRenamed", { name: to }));
      await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function pull() {
    await runRemoteWithAuth("pull");
  }

  async function push(force = false) {
    if (force && !window.confirm(t("git.forcePushConfirm"))) {
      return;
    }
    await runRemoteWithAuth("push", force);
  }

  /** WebStorm Push 对话框 */
  async function pushWithDialog() {
    const { openPushDialog } = await import("@/shared/gitDialogs");
    const result = await openPushDialog();
    if (!result) return;
    await runRemoteWithAuth("push", result.force);
  }

  /** WebStorm Update Project */
  async function updateProject() {
    const { openUpdateProjectDialog } = await import("@/shared/gitDialogs");
    const strategy = await openUpdateProjectDialog();
    if (!strategy) return;
    await runRemoteWithAuth("update", false, strategy);
  }

  async function fetchRemote() {
    await runRemoteWithAuth("fetch");
  }

  /** 认证失败时弹出账号密码框并重试（对齐 WebStorm） */
  async function runRemoteWithAuth(
    kind: "pull" | "push" | "fetch" | "update",
    force = false,
    updateStrategy: "merge" | "rebase" = "merge",
  ) {
    const workspace = useWorkspaceStore();
    if (!workspace.rootPath) return;
    // 防止用户连点 push/pull 按钮导致后端并发调用同一 git 操作
    if (remoteInFlight.value) {
      workspace.showNotice(t("git.remoteInFlight"), 2400);
      return;
    }
    remoteInFlight.value = true;
    const root = workspace.rootPath;
    const operationSeq = workspaceOperationSeq;
    const isCurrent = () =>
      workspace.rootPath === root && workspaceOperationSeq === operationSeq;
    let auth: GitAuthPayload | undefined;
    let lastUser = "";
    // 最多 1 次重试：第 0 次尝试 → 失败弹窗 → 第 1 次尝试用新凭据；仍认证失败则停止弹窗
    const MAX_ATTEMPTS = 2;

    // 进入远端操作前先发一条"进行中"notice，避免网络慢/认证中时 UI 看起来卡死。
    // 持续时长留 0，让后续的成功/失败 notice 自然覆盖它。
    const progressMessages: Record<typeof kind, string> = {
      push: t("git.pushing"),
      pull: t("git.pulling"),
      fetch: t("git.fetching"),
      update: t("git.updating"),
    };
    if (isCurrent()) workspace.showNotice(progressMessages[kind]);

    try {
      await runRemoteWithAuthInner(
        kind,
        force,
        updateStrategy,
        root,
        auth,
        lastUser,
        MAX_ATTEMPTS,
        workspace,
        isCurrent,
      );
    } finally {
      remoteInFlight.value = false;
    }
  }

  async function runRemoteWithAuthInner(
    kind: "pull" | "push" | "fetch" | "update",
    force: boolean,
    updateStrategy: "merge" | "rebase",
    root: string,
    auth: GitAuthPayload | undefined,
    lastUserIn: string,
    maxAttempts: number,
    workspace: ReturnType<typeof useWorkspaceStore>,
    isCurrent: () => boolean,
  ) {
    let authLocal = auth;
    let lastUser = lastUserIn;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (!isCurrent()) return;
      try {
        let msg = "";
        if (kind === "pull") msg = await gitPull(root, authLocal);
        else if (kind === "push") msg = await gitPush(root, force, authLocal);
        else if (kind === "fetch") msg = await gitFetch(root, "origin", authLocal);
        else msg = await gitUpdateProject(root, updateStrategy, authLocal);
        if (!isCurrent()) return;
        const remembered = authLocal?.remember === true;
        const fallback = msg || t("git.done");
        workspace.showNotice(
          remembered ? t("git.doneRemembered", { msg: fallback }) : fallback,
        );
        await refresh();
        return;
      } catch (error) {
        if (!isCurrent()) return;
        const raw = error instanceof Error ? error.message : String(error);
        const parsed = parseGitAuthError(raw);
        if (!parsed) {
          workspace.showNotice(raw, 4800);
          return;
        }
        // 已用新凭据重试一次仍失败：不再继续弹窗，避免死循环
        if (attempt + 1 >= maxAttempts) {
          workspace.showNotice(
            t("git.authFailedGiveUp", { detail: parsed.detail }),
            6000,
          );
          return;
        }
        const { promptGitAuth } = await import("@/shared/gitAuthDialog");
        if (!isCurrent()) return;
        const titles: Record<typeof kind, string> = {
          pull: t("git.authPull"),
          push: t("git.authPush"),
          fetch: t("git.authFetch"),
          update: t("git.authUpdate"),
        };
        let defaultUsername = lastUser || guessUsernameFromUrl(parsed.url);
        if (!defaultUsername && parsed.url) {
          try {
            const { gitStoredUsername } = await import("@/shared/gitApi");
            defaultUsername = (await gitStoredUsername(parsed.url)) ?? "";
          } catch {
            /* 忽略预填失败 */
          }
        }
        if (!isCurrent()) return;
        const next = await promptGitAuth({
          title: titles[kind],
          remoteUrl: parsed.url,
          message: authLocal ? t("git.authRetry") : t("git.authRequired"),
          defaultUsername,
        });
        if (!isCurrent() || !next) return;
        lastUser = next.username;
        authLocal = {
          username: next.username,
          password: next.password,
          remember: next.remember,
        };
      }
    }
  }

  function parseGitAuthError(raw: string): { url: string; detail: string } | null {
    const idx = raw.indexOf("GIT_AUTH_REQUIRED|||");
    if (idx < 0) return null;
    const body = raw.slice(idx);
    const parts = body.split("|||");
    if (parts[0] !== "GIT_AUTH_REQUIRED") return null;
    return {
      url: parts[1] ?? "",
      detail: parts.slice(2).join("|||"),
    };
  }

  function guessUsernameFromUrl(url: string): string {
    // https://user@host/... 
    const m = url.match(/^https?:\/\/([^/@]+)@/i);
    return m?.[1] ?? "";
  }

  async function stash(message?: string) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    try {
      await gitStash(root, message);
      if (!isCurrent()) return;
      workspace.showNotice(t("git.stashOk"));
      await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function stashPop(index = 0) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    try {
      await gitStashPop(root, index);
      if (!isCurrent()) return;
      workspace.showNotice(t("git.stashPopOk"));
      await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function stashApply(index: number) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    try {
      await gitStashApply(root, index);
      if (!isCurrent()) return;
      workspace.showNotice(t("git.stashApplyOk"));
      await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function stashDrop(index: number) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    if (!confirm(t("git.stashDropConfirm", { index }))) return;
    if (!isCurrent()) return;
    try {
      await gitStashDrop(root, index);
      if (!isCurrent()) return;
      workspace.showNotice(t("git.stashDropOk"));
      await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function discard(paths: string[]) {
    const operation = captureWorkspaceOperation();
    if (!operation || !paths.length) return;
    const { workspace, root, isCurrent } = operation;
    try {
      await gitDiscardPaths(root, paths);
      if (!isCurrent()) return;
      const { useEditorStore } = await import("@/stores/editor");
      if (!isCurrent()) return;
      await useEditorStore().reloadAfterDiscard(paths);
      if (!isCurrent()) return;
      workspace.showNotice(
        paths.length === 1
          ? t("git.discardedOne")
          : t("git.discardedMany", { count: paths.length }),
      );
      await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function discardAll() {
    const paths = unstagedEntries.value.map((e) => e.path);
    if (!paths.length) {
      useWorkspaceStore().showNotice(t("git.nothingToDiscard"));
      return;
    }
    await discard(paths);
  }

  async function loadLog(limit?: number) {
    const workspace = useWorkspaceStore();
    if (!workspace.rootPath || !snapshot.value.initialized) return;
    const nextLimit = limit ?? logLimit.value;
    logLimit.value = nextLimit;
    const root = workspace.rootPath;
    const seq = ++logSeq;
    try {
      const result = await gitLog(root, nextLimit);
      // 并发 loadLog 只认最新（旧 limit 不覆盖新 limit）
      if (seq !== logSeq) return;
      // 等待期间切换工作区：旧仓库日志不得写入新工作区
      if (workspace.rootPath !== root) return;
      log.value = result;
    } catch (error) {
      if (seq !== logSeq) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function loadMoreLog() {
    await loadLog(logLimit.value + 80);
  }

  function noticeRebaseConflict(raw: string) {
    const workspace = useWorkspaceStore();
    const idx = raw.indexOf("GIT_REBASE_CONFLICT|||");
    const msg =
      idx >= 0
        ? raw.slice(idx + "GIT_REBASE_CONFLICT|||".length).trim()
        : raw;
    workspace.showNotice(msg || t("git.rebaseConflictDefault"), 5200);
    void useSettingsStoreOpenCommit();
  }

  async function useSettingsStoreOpenCommit() {
    const { useSettingsStore } = await import("@/stores/settings");
    const settings = useSettingsStore();
    settings.setActivePanel("commit");
    settings.setSidebarCollapsed(false);
  }

  async function showDiff(path?: string, staged?: boolean) {
    const workspace = useWorkspaceStore();
    if (!workspace.rootPath) return;
    const root = workspace.rootPath;
    // 分栏对比需要具体文件；整组 diff 仍回退为 patch 弹层
    if (path?.trim()) {
      const { useCompareStore } = await import("@/stores/compare");
      if (workspace.rootPath !== root) return;
      await useCompareStore().openDiff(path, staged ?? false);
      return;
    }
    const requestSeq = ++diffSeq;
    try {
      const result = await gitDiff(root, path, staged);
      if (requestSeq !== diffSeq || workspace.rootPath !== root) return;
      diffResults.value = [result];
      diffTitle.value = staged
        ? t("git.stagedChanges")
        : t("git.workingChanges");
      diffVisible.value = true;
    } catch (error) {
      if (requestSeq !== diffSeq || workspace.rootPath !== root) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  function closeDiff() {
    diffSeq += 1;
    diffVisible.value = false;
    diffResults.value = [];
    diffTitle.value = "";
  }

  /** 切换工作区时清空仓库相关临时 UI 状态（随后会 refresh） */
  function clearForWorkspaceSwitch() {
    workspaceOperationSeq += 1;
    snapshot.value = { ...EMPTY };
    branches.value = [];
    tags.value = [];
    log.value = [];
    stashes.value = [];
    logLimit.value = 80;
    conflictFiles.value = [];
    rebaseStatus.value = { ...EMPTY_REBASE };
    commitMessage.value = "";
    amendCommit.value = false;
    checkedMap.value = {};
    selectedPath.value = null;
    closeDiff();
    refreshSeq += 1;
    // 工作区可能在旧根与新根之间快速切回；仅比较 root 不能挡住
    // ABA 竞态（旧根请求返回时 root 又相同），因此切换时也必须使所有
    // 在途日志请求失效。
    logSeq += 1;
    // 旧工作区的刷新无法取消，但必须与新工作区的刷新解耦；旧 run
    // 会因 refreshSeq/root 校验丢弃结果，且不会清理新 run 的 Promise。
    activeRefreshPromise = null;
    refreshAgain = false;
    loading.value = false;
  }

  async function openConflictCompare(path: string) {
    const workspace = useWorkspaceStore();
    const root = workspace.rootPath;
    const operationSeq = workspaceOperationSeq;
    if (!root) return;
    const { useCompareStore } = await import("@/stores/compare");
    if (workspace.rootPath !== root || workspaceOperationSeq !== operationSeq) return;
    await useCompareStore().openMerge(path);
  }

  async function resetHard() {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    if (
      !window.confirm(t("git.resetHardConfirm"))
    ) {
      return;
    }
    if (!isCurrent()) return;
    try {
      await gitResetHard(root);
      if (!isCurrent()) return;
      workspace.showNotice(t("git.resetHardOk"));
      await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function undoCommit() {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    if (
      !window.confirm(t("git.undoCommitConfirm"))
    ) {
      return;
    }
    if (!isCurrent()) return;
    try {
      await gitUndoCommit(root);
      if (!isCurrent()) return;
      workspace.showNotice(t("git.undoCommitOk"));
      await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function revertTo(commitId: string) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    if (
      !window.confirm(
        t("git.revertToConfirm", { hash: commitId.slice(0, 7) }),
      )
    ) {
      return;
    }
    if (!isCurrent()) return;
    try {
      await gitRevertTo(root, commitId);
      if (!isCurrent()) return;
      workspace.showNotice(t("git.revertToOk"));
      await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function mergeBranch(name: string) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    try {
      const msg = await gitMergeBranch(root, name);
      if (!isCurrent()) return;
      workspace.showNotice(
        typeof msg === "string" && msg ? msg : t("git.merged", { name }),
      );
      await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        4800,
      );
      // 冲突等场景也会走到这里：刷新让冲突面板立即出现
      await refresh();
    }
  }

  async function mergeAbort() {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    if (!window.confirm(t("git.mergeAbortConfirm"))) return;
    if (!isCurrent()) return;
    try {
      const msg = await gitMergeAbort(root);
      if (!isCurrent()) return;
      workspace.showNotice(msg || t("git.mergeAborted"));
      await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function rebaseBranch(onto: string) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    try {
      const msg = await gitRebaseBranch(root, onto);
      if (!isCurrent()) return;
      workspace.showNotice(msg || t("git.rebasedOnto", { onto }));
      await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      const raw = error instanceof Error ? error.message : String(error);
      if (raw.includes("GIT_REBASE_CONFLICT|||")) noticeRebaseConflict(raw);
      else workspace.showNotice(raw, 4800);
      await refresh();
    }
  }

  async function rebaseContinue() {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    try {
      const msg = await gitRebaseContinue(root);
      if (!isCurrent()) return;
      workspace.showNotice(msg || t("git.rebaseContinued"));
      await refresh();
      await loadLog();
    } catch (error) {
      if (!isCurrent()) return;
      const raw = error instanceof Error ? error.message : String(error);
      if (raw.includes("GIT_REBASE_CONFLICT|||")) noticeRebaseConflict(raw);
      else workspace.showNotice(raw, 4800);
      await refresh();
    }
  }

  async function rebaseAbort() {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    if (!window.confirm(t("git.rebaseAbortConfirm"))) {
      return;
    }
    if (!isCurrent()) return;
    try {
      const msg = await gitRebaseAbort(root);
      if (!isCurrent()) return;
      workspace.showNotice(msg || t("git.rebaseAborted"));
      await refresh();
      await loadLog();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function rebaseSkip() {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    try {
      const msg = await gitRebaseSkip(root);
      if (!isCurrent()) return;
      workspace.showNotice(msg || t("git.rebaseSkipped"));
      await refresh();
      await loadLog();
    } catch (error) {
      if (!isCurrent()) return;
      const raw = error instanceof Error ? error.message : String(error);
      if (raw.includes("GIT_REBASE_CONFLICT|||")) noticeRebaseConflict(raw);
      else workspace.showNotice(raw, 4800);
      await refresh();
    }
  }

  async function startInteractiveRebase(onto: string, steps: GitRebaseStep[]) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    try {
      const msg = await gitRebaseInteractive(root, onto, steps);
      if (!isCurrent()) return;
      workspace.showNotice(msg || t("git.interactiveRebaseDone"));
      await refresh();
      await loadLog();
    } catch (error) {
      if (!isCurrent()) return;
      const raw = error instanceof Error ? error.message : String(error);
      if (raw.includes("GIT_REBASE_CONFLICT|||")) noticeRebaseConflict(raw);
      else workspace.showNotice(raw, 4800);
      await refresh();
      await loadLog();
    }
  }

  async function loadRebasePlan(onto: string) {
    const operation = captureWorkspaceOperation();
    if (!operation) return [];
    const { workspace, root, isCurrent } = operation;
    try {
      const plan = await gitRebasePlan(root, onto);
      return isCurrent() ? plan : [];
    } catch (error) {
      if (!isCurrent()) return [];
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
      return [];
    }
  }

  async function setUpstream(branch: string, upstream: string) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    try {
      await gitSetUpstream(root, branch, upstream);
      if (!isCurrent()) return;
      workspace.showNotice(t("git.upstreamSet", { upstream }));
      await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function deleteRemoteBranch(remoteRef: string) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    if (
      !window.confirm(t("git.deleteRemoteConfirm", { ref: remoteRef }))
    ) {
      return;
    }
    if (!isCurrent()) return;
    try {
      const msg = await gitDeleteRemoteBranch(root, remoteRef);
      if (!isCurrent()) return;
      workspace.showNotice(msg);
      await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        4800,
      );
    }
  }

  async function compareBranchWithCurrent(other: string) {
    const workspace = useWorkspaceStore();
    if (!workspace.rootPath || !snapshot.value.branch) return;
    const root = workspace.rootPath;
    const operationSeq = workspaceOperationSeq;
    try {
      const sides = await gitBranchSides(
        root,
        snapshot.value.branch,
        other,
      );
      // 等待期间已切换工作区：旧仓库的对比标签不得落入新工作区
      if (workspace.rootPath !== root || workspaceOperationSeq !== operationSeq) return;
      const { useCompareStore } = await import("@/stores/compare");
      if (workspace.rootPath !== root || workspaceOperationSeq !== operationSeq) return;
      const compare = useCompareStore();
      // upsert：同一分支重复对比时合并为同一标签，避免无限累积
      compare.upsertTab({
        id: `branch-diff-${Date.now()}`,
        kind: "diff",
        path: sides.path,
        title: t("git.branchCompare", { path: sides.path }),
        leftLabel: sides.leftLabel,
        rightLabel: sides.rightLabel,
        left: sides.left,
        right: sides.right,
        editableRight: false,
      });
    } catch (error) {
      if (workspace.rootPath !== root || workspaceOperationSeq !== operationSeq) {
        return;
      }
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function createBranchAt(
    name: string,
    commitId: string,
    checkout: boolean,
  ) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    try {
      await gitCreateBranchAt(root, name, commitId, checkout);
      if (!isCurrent()) return;
      workspace.showNotice(
        checkout
          ? t("git.createdAndSwitched", { name })
          : t("git.branchCreatedAt", { name }),
      );
      await refresh();
      await loadLog();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function createTagAt(
    name: string,
    commitId: string,
    message?: string,
  ) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    try {
      await gitCreateTag(root, name, commitId, message);
      if (!isCurrent()) return;
      workspace.showNotice(t("git.tagCreated", { name }));
      await refresh();
      await loadLog();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function deleteTag(name: string) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    if (!window.confirm(t("git.deleteTagConfirm", { name }))) return;
    if (!isCurrent()) return;
    try {
      await gitDeleteTag(root, name);
      if (!isCurrent()) return;
      workspace.showNotice(t("git.tagDeleted", { name }));
      await refresh();
      await loadLog();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function pushTag(name: string, remote?: string) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    const target = remote ?? snapshot.value.upstream?.split("/")[0] ?? "origin";
    try {
      const message = await gitPushTag(root, target, name);
      if (!isCurrent()) return;
      workspace.showNotice(message);
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        4800,
      );
    }
  }

  async function checkoutCommit(commitId: string) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    if (
      !window.confirm(
        t("git.checkoutCommitConfirm", { hash: commitId.slice(0, 7) }),
      )
    ) {
      return;
    }
    if (!isCurrent()) return;
    try {
      const msg = await gitCheckoutCommit(root, commitId);
      if (!isCurrent()) return;
      workspace.showNotice(msg);
      await refresh();
      await loadLog();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function revertCommit(commitId: string) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    try {
      const msg = await gitRevertCommit(root, commitId);
      if (!isCurrent()) return;
      workspace.showNotice(msg);
      await refresh();
      await loadLog();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        4800,
      );
      await refresh();
    }
  }

  async function resolveAllConflicts(strategy: "ours" | "theirs") {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    const paths = conflictEntries.value.map((e) => e.path);
    if (!paths.length) return;
    try {
      for (const path of paths) {
        if (!isCurrent()) return;
        await gitResolveConflict(root, path, strategy);
      }
      if (!isCurrent()) return;
      workspace.showNotice(
        strategy === "ours" ? t("git.acceptAllOurs") : t("git.acceptAllTheirs"),
      );
      await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
      await refresh();
    }
  }

  async function openFirstConflict() {
    await useSettingsStoreOpenCommit();
    const path = conflictEntries.value[0]?.path;
    if (path) await openConflictCompare(path);
  }

  async function checkoutRemote(remoteRef: string, localName?: string) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    try {
      const msg = await gitCheckoutRemote(
        root,
        remoteRef,
        localName,
      );
      if (!isCurrent()) return;
      workspace.showNotice(msg);
      await refresh();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function cherryPick(commitId: string) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    try {
      const msg = await gitCherryPick(root, commitId);
      if (!isCurrent()) return;
      workspace.showNotice(msg);
      await refresh();
      await loadLog();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        4800,
      );
      await refresh();
    }
  }

  async function resetTo(
    commitId: string,
    mode: "soft" | "mixed" | "hard",
  ) {
    const operation = captureWorkspaceOperation();
    if (!operation) return;
    const { workspace, root, isCurrent } = operation;
    const label =
      mode === "hard"
        ? t("git.resetHardLabel")
        : mode === "soft"
          ? t("git.resetSoftLabel")
          : t("git.resetMixedLabel");
    if (
      !window.confirm(
        t("git.resetConfirm", { hash: commitId.slice(0, 7), label }),
      )
    )
      return;
    if (!isCurrent()) return;
    try {
      const msg = await gitReset(root, commitId, mode);
      if (!isCurrent()) return;
      workspace.showNotice(msg);
      await refresh();
      await loadLog();
    } catch (error) {
      if (!isCurrent()) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function blameFile(path: string) {
    const operation = captureWorkspaceOperation();
    if (!operation) return [];
    const { workspace, root, isCurrent } = operation;
    try {
      const result = await gitBlame(root, path);
      return isCurrent() ? result : [];
    } catch (error) {
      if (!isCurrent()) return [];
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
      return [];
    }
  }

  async function resolveConflict(
    path: string,
    strategy: "ours" | "theirs" | "manual",
  ) {
    const workspace = useWorkspaceStore();
    if (!workspace.rootPath) return;
    const root = workspace.rootPath;
    const operationSeq = workspaceOperationSeq;
    try {
      await gitResolveConflict(root, path, strategy);
      if (workspace.rootPath !== root || workspaceOperationSeq !== operationSeq) return;
      workspace.showNotice(
        strategy === "manual" ? t("git.conflictManual") : t("git.conflictResolved"),
      );
      await refresh();
    } catch (error) {
      if (workspace.rootPath !== root || workspaceOperationSeq !== operationSeq) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  /**
   * 把绝对或相对路径归一为 statusMap 可查询的 key
   * - statusMap 的 key 是 libgit2 输出的「相对仓库根 / 正斜杠」路径
   * - 调用方传绝对路径时这里做 relativeToRoot 转换
   * - 优先 relative fallback to norm，吸收 Windows 反斜杠与大小写差异
   */
  function lookupStatusEntry(path: string): GitStatusEntry | null {
    if (!path) return null;
    const norm = path.replace(/\\/g, "/");
    const rootPath = useWorkspaceStore().rootPath;
    const rel = rootPath ? relativeToRoot(rootPath, norm) || norm : norm;
    return statusMap.value.get(rel) ?? statusMap.value.get(norm) ?? null;
  }

  /** 查 GitStatusEntry；供 ExplorerPanel / EditorArea 等需要原始 entry 的场景 */
  function statusEntry(path: string) {
    return lookupStatusEntry(path);
  }

  function statusColor(path: string): string | null {
    const entry = lookupStatusEntry(path);
    if (!entry) return null;
    if (entry.conflicted) return "var(--danger)";
    if (entry.status === "untracked") return "var(--success)";
    if (entry.staged) return "var(--success)";
    if (entry.unstaged) return "var(--warning)";
    return null;
  }

  /** 状态字母 badge：M / U / D / R / C（与 CommitPanel / Explorer 共享） */
  function statusLabel(status: string): string {
    const map: Record<string, string> = {
      modified: "M",
      untracked: "U",
      deleted: "D",
      renamed: "R",
      conflict: "C",
      changed: "M",
    };
    return map[status] ?? status.slice(0, 1).toUpperCase();
  }

  /** 状态中文 title（hover tooltip） */
  function statusTitle(status: string): string {
    const map: Record<string, string> = {
      modified: t("git.statusModified"),
      untracked: t("git.statusUntracked"),
      deleted: t("git.statusDeleted"),
      renamed: t("git.statusRenamed"),
      conflict: t("git.statusConflict"),
      changed: t("git.statusChanged"),
    };
    return map[status] ?? status;
  }

  /** 状态 CSS class（与 CommitPanel .st-* 同款） */
  function statusClass(status: string): string {
    if (status === "untracked") return "st-untracked";
    if (status === "deleted") return "st-deleted";
    if (status === "conflict") return "st-conflict";
    if (status === "renamed") return "st-renamed";
    return "st-modified";
  }

  return {
    snapshot,
    branches,
    tags,
    log,
    stashes,
    logLimit,
    conflictFiles,
    rebaseStatus,
    diffResults,
    diffTitle,
    diffVisible,
    loading,
    remoteInFlight,
    commitMessage,
    amendCommit,
    statusMap,
    stagedEntries,
    unstagedEntries,
    conflictEntries,
    changelistEntries,
    changedFileCount,
    checkedMap,
    checkedPaths,
    checkedCount,
    allChecked,
    selectedPath,
    setPathChecked,
    setAllChecked,
    selectChange,
    refresh,
    scheduleRefresh,
    initRepo,
    stage,
    stageAll,
    unstage,
    commit,
    commitAndPush,
    checkout,
    createBranch,
    deleteBranch,
    renameBranch,
    pull,
    push,
    pushWithDialog,
    updateProject,
    fetchRemote,
    stash,
    stashPop,
    stashApply,
    stashDrop,
    discard,
    discardAll,
    loadLog,
    loadMoreLog,
    showDiff,
    closeDiff,
    clearForWorkspaceSwitch,
    openConflictCompare,
    openFirstConflict,
    resetHard,
    undoCommit,
    revertTo,
    revertCommit,
    mergeBranch,
    mergeAbort,
    rebaseBranch,
    rebaseContinue,
    rebaseAbort,
    rebaseSkip,
    startInteractiveRebase,
    loadRebasePlan,
    setUpstream,
    deleteRemoteBranch,
    compareBranchWithCurrent,
    createBranchAt,
    createTagAt,
    deleteTag,
    pushTag,
    checkoutCommit,
    checkoutRemote,
    cherryPick,
    resetTo,
    blameFile,
    resolveConflict,
    resolveAllConflicts,
    statusEntry,
    statusColor,
    statusLabel,
    statusTitle,
    statusClass,
  };
});
