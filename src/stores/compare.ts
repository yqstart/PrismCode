import { computed, ref } from "vue";
import { defineStore } from "pinia";
import {
  gitConflictSides,
  gitFileSides,
  type GitConflictSides,
} from "@/shared/gitApi";
import { basename } from "@/shared/fs";
import { planCompareTabEviction } from "@/features/git/compareTabs";
import { useSessionsStore } from "@/stores/sessions";
import { useWorkspaceStore } from "@/stores/workspace";

export type CompareKind = "diff" | "merge";

export interface CompareTab {
  id: string;
  kind: CompareKind;
  /** 仓库内相对路径 */
  path: string;
  title: string;
  leftLabel: string;
  rightLabel: string;
  left: string;
  right: string;
  staged?: boolean;
  /** 冲突时右侧可编辑（合并结果） */
  editableRight: boolean;
  conflict?: GitConflictSides;
}

export const useCompareStore = defineStore("compare", () => {
  const tabs = ref<CompareTab[]>([]);
  const activeId = ref<string | null>(null);
  const focused = ref(false);
  let seq = 0;
  /** 工作区切换代际：阻止 A→B→A 时旧的 Diff/合并请求回写。 */
  let workspaceGeneration = 0;

  const activeTab = computed(
    () => tabs.value.find((t) => t.id === activeId.value) ?? null,
  );
  const isFocused = computed(() => focused.value && Boolean(activeTab.value));

  function focusCompare() {
    if (!tabs.value.length) return;
    focused.value = true;
    useSessionsStore().blurSessions();
    void import("@/stores/gitLog").then(({ useGitLogStore }) => {
      useGitLogStore().blurLog();
    });
  }

  function blurCompare() {
    focused.value = false;
  }

  function activate(id: string) {
    activeId.value = id;
    focusCompare();
  }

  function closeTab(id: string) {
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx < 0) return;
    tabs.value.splice(idx, 1);
    if (activeId.value === id) {
      const next = tabs.value[idx] || tabs.value[idx - 1] || null;
      activeId.value = next?.id ?? null;
    }
    if (!tabs.value.length) {
      focused.value = false;
    }
  }

  /** 切换工作区时关闭全部对比标签 */
  function clearAll() {
    workspaceGeneration += 1;
    tabs.value = [];
    activeId.value = null;
    focused.value = false;
  }

  function upsertTab(tab: CompareTab) {
    const existing = tabs.value.find(
      (t) => t.kind === tab.kind && t.path === tab.path && t.staged === tab.staged,
    );
    if (existing) {
      Object.assign(existing, tab, { id: existing.id });
      activate(existing.id);
      return existing.id;
    }
    tabs.value.push(tab);
    const kept = new Set(
      planCompareTabEviction(
        tabs.value.slice(0, -1).map((item) => item.id),
        activeId.value,
        tab.id,
      ),
    );
    kept.add(tab.id);
    tabs.value = tabs.value.filter((item) => kept.has(item.id));
    activate(tab.id);
    return tab.id;
  }

  async function openDiff(path: string, staged = false) {
    const workspace = useWorkspaceStore();
    if (!workspace.rootPath) return;
    if (!path.trim()) {
      workspace.showNotice("请选择具体文件查看分栏对比");
      return;
    }
    const root = workspace.rootPath;
    const generation = workspaceGeneration;
    try {
      const sides = await gitFileSides(root, path, staged);
      // 等待期间已切换工作区：旧仓库的对比标签不得落入新工作区
      if (workspace.rootPath !== root || workspaceGeneration !== generation) return;
      seq += 1;
      upsertTab({
        id: `diff-${seq}`,
        kind: "diff",
        path: sides.path,
        title: `${basename(sides.path)}${staged ? " · 暂存" : " · 更改"}`,
        leftLabel: sides.leftLabel,
        rightLabel: sides.rightLabel,
        left: sides.left,
        right: sides.right,
        staged,
        editableRight: false,
      });
    } catch (error) {
      if (workspace.rootPath !== root || workspaceGeneration !== generation) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function openMerge(path: string) {
    const workspace = useWorkspaceStore();
    if (!workspace.rootPath) return;
    const root = workspace.rootPath;
    const generation = workspaceGeneration;
    try {
      const sides = await gitConflictSides(root, path);
      // 等待期间已切换工作区：旧仓库的合并标签不得落入新工作区
      if (workspace.rootPath !== root || workspaceGeneration !== generation) return;
      seq += 1;
      upsertTab({
        id: `merge-${seq}`,
        kind: "merge",
        path: sides.path,
        title: `${basename(sides.path)} · 合并`,
        leftLabel: "本地 (Ours)",
        rightLabel: "远程 (Theirs)",
        left: sides.ours,
        right: sides.theirs,
        editableRight: true,
        conflict: sides,
      });
      // 默认右侧为可编辑合并结果，初始用工作区内容（便于保留已改部分）
      const tab = tabs.value.find((t) => t.id === activeId.value);
      if (tab) {
        tab.right = sides.working || sides.ours;
        tab.rightLabel = "合并结果";
      }
    } catch (error) {
      if (workspace.rootPath !== root || workspaceGeneration !== generation) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  function setRightContent(id: string, content: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || !tab.editableRight) return;
    tab.right = content;
  }

  function applySideToResult(id: string, side: "ours" | "theirs" | "base") {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab?.conflict) return;
    if (side === "ours") tab.right = tab.conflict.ours;
    else if (side === "theirs") tab.right = tab.conflict.theirs;
    else tab.right = tab.conflict.base;
    tab.rightLabel = "合并结果";
    tab.editableRight = true;
  }

  function showOursTheirs(id: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab?.conflict) return;
    tab.left = tab.conflict.ours;
    tab.right = tab.conflict.theirs;
    tab.leftLabel = "本地 (Ours)";
    tab.rightLabel = "远程 (Theirs)";
    tab.editableRight = false;
  }

  return {
    tabs,
    activeId,
    activeTab,
    focused,
    isFocused,
    focusCompare,
    blurCompare,
    activate,
    upsertTab,
    closeTab,
    clearAll,
    openDiff,
    openMerge,
    setRightContent,
    applySideToResult,
    showOursTheirs,
  };
});
