import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import {
  basename,
  languageFromPath,
  pathExists,
  readTextFile,
  toAbsolutePath,
  writeTextFile,
} from "@/shared/fs";
import { isRasterImagePath } from "@/shared/media";
import {
  loadEditorSession,
  saveEditorSession,
  type EditorSession,
  type EditorSessionTab,
} from "@/shared/editorSession";
import {
  mapWithConcurrency,
  prioritizeActiveTab,
} from "@/features/editor/sessionRestore";
import { formatDocumentContent } from "@/features/editor/formatting";
import { fileScopeRoot } from "@/shared/fileScope";
import {
  recordNavigation,
  takeNavigationBack,
  takeNavigationForward,
} from "@/features/editor/navigationHistory";
import { wordAt } from "@/features/editor/documentSymbols";
import type { EditorFindRequest, EditorJumpTarget, EditorOpenAt } from "@/shared/types";
import { useCompareStore } from "@/stores/compare";
import { useGitStore } from "@/stores/git";
import { useSessionsStore } from "@/stores/sessions";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";

export interface EditorTab {
  id: string;
  path: string;
  name: string;
  content: string;
  original: string;
  language: string;
  cursor: { line: number; column: number };
  /** 图片预览缓存破坏（外部变更时递增） */
  previewNonce: number;
  /** 固定标签：关闭其它/左/右/全部时保留 */
  pinned: boolean;
  /** 相对磁盘有无未保存改动：setContent 时 O(1) 维护，供 dirtyPaths 增量更新 */
  dirty: boolean;
}

export interface EditorReferenceResult {
  path: string;
  line: number;
  column: number;
  isDefinition?: boolean;
}

export const useEditorStore = defineStore("editor", () => {
  const SESSION_RESTORE_CONCURRENCY = 4;
  const tabs = ref<EditorTab[]>([]);
  const activePath = ref<string | null>(null);
  const jumpStack = ref<EditorJumpTarget[]>([]);
  const forwardJumpStack = ref<EditorJumpTarget[]>([]);
  const recentPaths = ref<string[]>([]);
  const openAt = ref<EditorOpenAt | null>(null);
  let openAtSeq = 0;
  // 查找面板打开信号（原生菜单 ⌘F -> store -> 编辑器 watcher 消费）
  const findRequest = ref<EditorFindRequest | null>(null);
  let findRequestSeq = 0;
  // 行内 git blame 常驻列开关（会话级，不持久化；hover 悬浮始终开启）
  const blameVisible = ref(false);
  const referencesVisible = ref(false);
  const referenceWord = ref("");
  const referenceResults = ref<EditorReferenceResult[]>([]);
  let referencesRequestSeq = 0;
  let sessionTimer: ReturnType<typeof setTimeout> | null = null;
  let restoringSession = false;
  /** 工作区切换代际：使 A→B→A 时旧的异步编辑器任务也失效。 */
  let workspaceGeneration = 0;
  let restoreGeneration = 0;

  /**
   * 外部修改标记：当 syncFromDisk / reloadAfterDiscard / formatDocument /
   * renameSymbol 等「非用户输入」来源改了 tab.content 时，先 markExternalUpdate(path)。
   * CodeMirrorEditor 的 props.content watcher 只有在 consumeExternalUpdate
   * 返回 true 时才把新内容 dispatch 进 CM；用户输入触发的 setContent 不标记，
   * watcher 直接 return，彻底切断 CM -> store -> prop -> CM 的回环。
   */
  const pendingExternalUpdates = new Set<string>();
  /** 外部程序持续写同一文件时，自动保存不得和它互相覆盖。 */
  const autoSaveBlockedPaths = new Set<string>();
  /** 已经询问过且用户选择保留本地内容的磁盘版本。 */
  const externalConflictVersions = new Map<string, string>();
  function markExternalUpdate(path: string): void {
    pendingExternalUpdates.add(path);
  }
  function consumeExternalUpdate(path: string): boolean {
    return pendingExternalUpdates.delete(path);
  }

  function hasAutoSaveableChanges(): boolean {
    return tabs.value.some(
      (tab) =>
        !isRasterImagePath(tab.path) &&
        tab.dirty &&
        !autoSaveBlockedPaths.has(tab.path),
    );
  }

  const activeTab = computed(
    () => tabs.value.find((t) => t.path === activePath.value) ?? null,
  );

  function isLiveTab(tab: EditorTab, path: string): boolean {
    return tabs.value.some((item) => item === tab && item.path === path);
  }

  /**
   * 该文件的读写作用域根：项目窗口为工作区根，light 模式为文件所在目录
   * （见 shared/fileScope）。所有文件 IPC 都以它作为 root 参数。
   */
  function scopeFor(path: string): string | null {
    return fileScopeRoot(useWorkspaceStore().rootPath, path);
  }

  // dirty 集合缓存：只在集合内容真正变化时替换 Set 引用。dirty 由 setContent
  // O(1) 维护（不读 content 字符串），连续输入时引用不变，资源树/状态栏等
  // 下游组件不会每键整树重渲染；脏标签从干净→脏或反之才触发一次替换
  let cachedDirtySet: Set<string> | null = null;
  const dirtyPaths = computed(() => {
    const next = new Set<string>();
    for (const t of tabs.value) {
      if (!isRasterImagePath(t.path) && t.dirty) next.add(t.path);
    }
    if (cachedDirtySet && cachedDirtySet.size === next.size) {
      let same = true;
      for (const p of next) {
        if (!cachedDirtySet.has(p)) {
          same = false;
          break;
        }
      }
      if (same) return cachedDirtySet;
    }
    cachedDirtySet = next;
    return next;
  });

  function isDirty(path: string) {
    return dirtyPaths.value.has(path);
  }

  function pushJump(target: EditorJumpTarget) {
    recordNavigation(
      { back: jumpStack.value, forward: forwardJumpStack.value },
      target,
    );
  }

  function currentJumpTarget(): EditorJumpTarget | null {
    const tab = activeTab.value;
    if (!tab) return null;
    return { path: tab.path, line: tab.cursor.line, column: tab.cursor.column };
  }

  function takeJumpBack(): EditorJumpTarget | null {
    return takeNavigationBack(
      { back: jumpStack.value, forward: forwardJumpStack.value },
      currentJumpTarget(),
    );
  }

  function takeJumpForward(): EditorJumpTarget | null {
    return takeNavigationForward(
      { back: jumpStack.value, forward: forwardJumpStack.value },
      currentJumpTarget(),
    );
  }

  function rememberRecent(path: string): void {
    recentPaths.value = [path, ...recentPaths.value.filter((item) => item !== path)].slice(
      0,
      50,
    );
  }

  function requestOpenAt(path: string, line: number, column: number) {
    openAtSeq += 1;
    openAt.value = { path, line, column, requestId: openAtSeq };
  }

  /** 请求打开当前活动编辑器的查找面板（原生菜单 ⌘F 触发） */
  function requestFind() {
    findRequestSeq += 1;
    findRequest.value = { path: activePath.value, requestId: findRequestSeq };
  }

  async function openReferences(path: string, content: string, position: number) {
    const workspace = useWorkspaceStore();
    const root = workspace.rootPath;
    const word = wordAt(content, position)?.word ?? "";
    if (!root || !word) return;
    const generation = workspaceGeneration;
    const requestId = ++referencesRequestSeq;
    referenceWord.value = word;
    referencesVisible.value = true;
    referenceResults.value = [];
    try {
      const { findReferences } = await import("@/features/editor/findReferences");
      const results = await findReferences(word, path, content, root, {
        position,
        maxDepth: 8,
      });
      if (
        requestId !== referencesRequestSeq ||
        workspace.rootPath !== root ||
        generation !== workspaceGeneration
      ) {
        return;
      }
      referenceResults.value = results;
    } catch (error) {
      if (
        requestId !== referencesRequestSeq ||
        workspace.rootPath !== root ||
        generation !== workspaceGeneration
      ) {
        return;
      }
      referencesVisible.value = false;
      useWorkspaceStore().showNotice(
        `查找引用失败：${error instanceof Error ? error.message : String(error)}`,
        3200,
      );
    }
  }

  function closeReferences() {
    referencesRequestSeq += 1;
    referencesVisible.value = false;
  }

  /** 切换行内 git blame 常驻列 */
  function toggleBlame() {
    blameVisible.value = !blameVisible.value;
  }

  /** 立即写入当前工作区的编辑器会话，供切换工作区/退出前调用。 */
  function persistSession(root?: string | null) {
    if (sessionTimer !== null) {
      clearTimeout(sessionTimer);
      sessionTimer = null;
    }
    const sessionRoot = root ?? useWorkspaceStore().rootPath;
    if (!sessionRoot) return;
    const session: EditorSession = {
      tabs: tabs.value.map((tab) => ({
        path: tab.path,
        cursor: tab.cursor,
        pinned: tab.pinned,
        dirty: tab.dirty,
        content: tab.content,
        original: tab.original,
      })),
      activePath: activePath.value,
      recentPaths: recentPaths.value,
    };
    saveEditorSession(sessionRoot, session);
  }

  function schedulePersistSession() {
    if (restoringSession || sessionTimer !== null) return;
    if (!useWorkspaceStore().rootPath) return;
    sessionTimer = setTimeout(() => {
      sessionTimer = null;
      persistSession();
    }, 180);
  }

  /**
   * 读取一个会话标签，但不激活编辑器、不展开资源树、不触发 Git/Dock 刷新。
   * 文本文件直接以 readTextFile 的失败表示路径失效，省掉原先重复的 pathExists IPC；
   * 栅格图不读正文，仍需一次存在性检查。
   */
  async function loadRestoredTab(
    root: string,
    savedTab: EditorSessionTab,
    isCurrent: () => boolean,
  ): Promise<EditorTab | null> {
    try {
      const raster = isRasterImagePath(savedTab.path);
      if (raster && !(await pathExists(root, savedTab.path))) return null;
      const original = raster ? "" : await readTextFile(root, savedTab.path);
      if (!isCurrent()) return null;

      let content = original;
      let dirty = false;
      if (
        savedTab.dirty === true &&
        typeof savedTab.content === "string" &&
        typeof savedTab.original === "string" &&
        savedTab.original === original
      ) {
        content = savedTab.content;
        dirty = content !== original;
      }

      return {
        id: savedTab.path,
        path: savedTab.path,
        name: basename(savedTab.path),
        content,
        original,
        language: languageFromPath(savedTab.path),
        cursor: savedTab.cursor,
        previewNonce: Date.now(),
        pinned: savedTab.pinned,
        dirty,
      };
    } catch {
      // 会话允许包含已移动/删除/暂时不可访问的旧文件，恢复时静默跳过。
      return null;
    }
  }

  /**
   * 恢复工作区上次打开的标签、活动标签、光标和固定状态。
   * 磁盘版本发生变化时不覆盖当前磁盘文件，避免把过期恢复快照误当成新文件。
   */
  async function restoreSession(root: string) {
    if (restoringSession || !root || tabs.value.length) return;
    const saved = loadEditorSession(root);
    if (!saved?.tabs.length) return;

    const workspace = useWorkspaceStore();
    const generation = workspaceGeneration;
    const restoreId = ++restoreGeneration;
    const isCurrent = () =>
      generation === workspaceGeneration &&
      workspace.rootPath === root &&
      restoreId === restoreGeneration;
    restoringSession = true;
    try {
      // 先只恢复活动标签，让项目尽快出现可编辑内容；活动文件失效时按原
      // 标签顺序寻找第一个仍存在的文件，不让一条陈旧路径阻断整个会话。
      const readOrder = prioritizeActiveTab(saved.tabs, saved.activePath);
      const attempted = new Set<string>();
      let firstRestored: EditorTab | null = null;
      for (const savedTab of readOrder) {
        if (!isCurrent()) return;
        attempted.add(savedTab.path);
        firstRestored = await loadRestoredTab(root, savedTab, isCurrent);
        if (firstRestored) break;
      }
      if (!isCurrent()) return;
      if (!firstRestored) {
        restoringSession = false;
        return;
      }

      // 用户可能在活动文件读取期间主动打开了别的标签：保留用户操作，
      // 只补入不存在的恢复标签，且不抢走用户刚选择的活动页。
      const existingFirst = tabs.value.find(
        (tab) => tab.path === firstRestored.path,
      );
      if (!existingFirst) tabs.value = [firstRestored, ...tabs.value];
      if (!activePath.value) activate(firstRestored.path);
      recentPaths.value = saved.recentPaths ?? recentPaths.value;
      if (activePath.value) rememberRecent(activePath.value);

      const remaining = saved.tabs.filter(
        (savedTab) =>
          savedTab.path !== firstRestored.path && !attempted.has(savedTab.path),
      );

      // 不等待非活动标签：先把控制权还给 Vue/WKWebView 完成首屏绘制，
      // 再用小并发后台读盘。整个后台阶段保持 restoringSession，避免每补一批
      // 标签就把半成品会话写回 localStorage。
      void (async () => {
        await new Promise<void>((resolveDelay) => {
          window.setTimeout(resolveDelay, 0);
        });
        const restored = await mapWithConcurrency(
          remaining,
          SESSION_RESTORE_CONCURRENCY,
          (savedTab) => loadRestoredTab(root, savedTab, isCurrent),
        );
        if (!isCurrent()) return;

        const restoredByPath = new Map(
          restored
            .filter((tab): tab is EditorTab => Boolean(tab))
            .map((tab) => [tab.path, tab]),
        );
        const currentTabs = [...tabs.value];
        const currentByPath = new Map(currentTabs.map((tab) => [tab.path, tab]));
        const merged: EditorTab[] = [];
        const seen = new Set<string>();

        // 恢复原标签栏顺序；后台期间用户已打开/编辑的同路径标签优先。
        for (const savedTab of saved.tabs) {
          const tab =
            currentByPath.get(savedTab.path) ?? restoredByPath.get(savedTab.path);
          if (!tab || seen.has(tab.path)) continue;
          merged.push(tab);
          seen.add(tab.path);
        }
        // 后台恢复期间由用户新开的非会话标签追加在末尾，不得丢失。
        for (const tab of currentTabs) {
          if (seen.has(tab.path)) continue;
          merged.push(tab);
          seen.add(tab.path);
        }
        tabs.value = merged;
        persistSession(root);
      })()
        .catch((error) => {
          if (isCurrent()) {
            console.warn("[editorSession] 后台恢复标签失败", error);
          }
        })
        .finally(() => {
          if (restoreId === restoreGeneration) restoringSession = false;
        });
    } catch (error) {
      if (isCurrent()) {
        restoringSession = false;
        console.warn("[editorSession] 恢复活动标签失败", error);
      }
    }
  }

  async function openFile(path: string) {
    const workspace = useWorkspaceStore();
    // 项目窗口用工作区根；light 模式（无工作区）用文件所在目录。
    const scope = scopeFor(path);
    if (!scope) return;
    const generation = workspaceGeneration;
    useSessionsStore().blurSessions();
    useCompareStore().blurCompare();
    void import("@/stores/gitLog").then(({ useGitLogStore }) => {
      useGitLogStore().blurLog();
    });

    const existing = tabs.value.find((t) => t.path === path);
    if (existing) {
      activePath.value = path;
      // 切换到已打开 tab：标记外部修改，让 CodeMirrorEditor 的 content watcher
      // 正确同步该 tab 的内容（断环机制会阻断未标记的 dispatch）
      markExternalUpdate(path);
      workspace.selectPath(path);
      workspace.revealPath(path);
      return;
    }

    try {
      // 栅格图：不读文本，仅作预览标签
      // 发起时刻的活动标签：读盘是异步 IPC，期间用户可能已切到别的标签。
      // 完成后若无新激活则不抢占（避免「点了大文件后又被强制切走」）；
      // 若期间已激活其它标签，本标签只加入列表，不打断用户当前编辑。
      const beforeActive = activePath.value;
      const content = isRasterImagePath(path)
        ? ""
        : await readTextFile(scope, path);
      // 读取期间已切换工作区/作用域：旧文件标签不得落入新工作区
      if (scopeFor(path) !== scope || generation !== workspaceGeneration) return;
      // 并发打开同一文件的场景（双击、快速打开连续回车等）：两个请求都
      // 通过了上面的 existing 检查，后完成的请求会在此发现重复标签。
      // 此时绝不能再 push，否则同一 path 出现两个标签，:key 冲突导致
      // 标签与编辑内容错位（activeTab 只命中第一个、切换不换文档）。
      const dup = tabs.value.find((t) => t.path === path);
      if (dup) {
        if (activePath.value === beforeActive) {
          activePath.value = path;
          markExternalUpdate(path);
          workspace.selectPath(path);
          workspace.revealPath(path);
        }
        return;
      }
      tabs.value.push({
        id: path,
        path,
        name: basename(path),
        content,
        original: content,
        language: languageFromPath(path),
        cursor: { line: 1, column: 1 },
        previewNonce: Date.now(),
        pinned: false,
        dirty: false,
      });
      if (activePath.value === beforeActive) {
        activePath.value = path;
        workspace.selectPath(path);
        workspace.revealPath(path);
      }
    } catch (error) {
      if (scopeFor(path) !== scope || generation !== workspaceGeneration) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function openFileAt(
    path: string,
    line: number,
    column: number,
    options?: { recordHistory?: boolean },
  ) {
    const scope = scopeFor(path);
    if (!scope) return;
    const generation = workspaceGeneration;
    const current = activeTab.value;
    if (current && options?.recordHistory !== false) {
      pushJump({
        path: current.path,
        line: current.cursor.line,
        column: current.cursor.column,
      });
    }
    await openFile(path);
    if (scopeFor(path) !== scope || generation !== workspaceGeneration) return;
    if (!tabs.value.some((tab) => tab.path === path)) return;
    requestOpenAt(path, line, column);
  }

  function setContent(path: string, content: string) {
    const tab = tabs.value.find((t) => t.path === path);
    if (!tab) return;
    tab.content = content;
    tab.dirty = content !== tab.original;
    if (!tab.dirty) {
      autoSaveBlockedPaths.delete(path);
      externalConflictVersions.delete(path);
    }
  }

  /** 磁盘内容已更新（如 import 批量替换），同步缓冲区且保持干净状态 */
  function syncFromDisk(path: string, content: string) {
    const tab = tabs.value.find((t) => t.path === path);
    if (!tab) return;
    markExternalUpdate(path);
    tab.content = content;
    tab.original = content;
    tab.dirty = false;
    autoSaveBlockedPaths.delete(path);
    externalConflictVersions.delete(path);
  }

  /** 外部磁盘变更：干净标签自动重载；脏标签询问是否覆盖 */
  async function syncExternalChanges(changedPaths: string[]) {
    if (!changedPaths.length) return;
    const workspace = useWorkspaceStore();
    const generation = workspaceGeneration;

    for (const path of changedPaths) {
      // 每个标签按自己的作用域校验：项目窗口为工作区，light 模式为文件目录。
      const scope = scopeFor(path);
      if (!scope) continue;
      const isCurrent = () =>
        scopeFor(path) === scope && generation === workspaceGeneration;
      const tab = tabs.value.find((t) => t.path === path);
      if (!tab) continue;

      try {
        const exists = await pathExists(scope, path);
        if (!isCurrent()) return;
        if (!exists) {
          if (tab.content === tab.original) {
            await closeTab(path);
            if (!isCurrent()) return;
            workspace.showNotice(`「${tab.name}」已被外部删除`);
          } else {
            autoSaveBlockedPaths.add(path);
            externalConflictVersions.set(path, "<missing>");
            workspace.showNotice(
              `「${tab.name}」已被外部删除，本地仍有未保存更改`,
              3600,
            );
          }
          continue;
        }

        // 栅格图：刷新预览即可
        if (isRasterImagePath(path)) {
          tab.previewNonce = Date.now();
          workspace.showNotice(`「${tab.name}」已从磁盘重新加载`);
          continue;
        }

        const disk = await readTextFile(scope, path);
        if (!isCurrent() || !isLiveTab(tab, path)) return;
        if (disk === tab.content) {
          if (tab.original !== disk || tab.dirty) {
            tab.original = disk;
            tab.dirty = false;
            tab.previewNonce = Date.now();
          }
          autoSaveBlockedPaths.delete(path);
          externalConflictVersions.delete(path);
          continue;
        }

        if (tab.content === tab.original) {
          markExternalUpdate(path);
          tab.content = disk;
          tab.original = disk;
          tab.dirty = false;
          tab.previewNonce = Date.now();
          autoSaveBlockedPaths.delete(path);
          externalConflictVersions.delete(path);
          workspace.showNotice(`「${tab.name}」已从磁盘重新加载`);
          continue;
        }

        // 外部程序可能在保存循环中反复写出同一个版本。第一次询问后，
        // 同一磁盘版本不再阻塞主线程弹窗；只有出现新版本才重新询问。
        if (externalConflictVersions.get(path) === disk) continue;

        const overwrite = window.confirm(
          `「${tab.name}」已被外部修改，且本地有未保存更改。\n\n确定：用磁盘版本覆盖\n取消：保留编辑器内容`,
        );
        if (!isCurrent()) return;
        if (overwrite) {
          markExternalUpdate(path);
          tab.content = disk;
          tab.original = disk;
          tab.dirty = false;
          tab.previewNonce = Date.now();
          autoSaveBlockedPaths.delete(path);
          externalConflictVersions.delete(path);
          workspace.showNotice(`「${tab.name}」已用磁盘版本覆盖`);
        } else {
          tab.original = disk;
          tab.dirty = true;
          // 保留本地版本时暂停自动保存，防止与持续写盘的终端进程互相覆盖。
          autoSaveBlockedPaths.add(path);
          externalConflictVersions.set(path, disk);
          workspace.showNotice(`「${tab.name}」外部已变更，已保留本地编辑`, 3200);
        }
      } catch (error) {
        if (!isCurrent() || !isLiveTab(tab, path)) return;
        workspace.showNotice(
          error instanceof Error ? error.message : String(error),
          3200,
        );
      }
    }
  }

  /**
   * Git 回滚后强制同步编辑器：磁盘已还原/删除，缓冲区必须跟上，
   * 否则会出现「列表已干净、编辑器仍是旧内容」。
   */
  async function reloadAfterDiscard(repoRelativePaths: string[]) {
    const workspace = useWorkspaceStore();
    if (!workspace.rootPath || !repoRelativePaths.length) return;
    const root = workspace.rootPath;
    const generation = workspaceGeneration;
    const isCurrent = () =>
      workspace.rootPath === root && generation === workspaceGeneration;

    const absList = repoRelativePaths.map((p) => toAbsolutePath(root, p));
    const relSet = new Set(
      repoRelativePaths.map((p) => p.replace(/\\/g, "/")),
    );

    for (const abs of absList) {
      if (!isCurrent()) return;
      const tab = tabs.value.find((t) => t.path === abs);
      if (!tab) continue;
      try {
        const exists = await pathExists(root, abs);
        if (!isCurrent()) return;
        if (!exists) {
          await closeTab(abs);
          continue;
        }
        if (isRasterImagePath(abs)) {
          tab.previewNonce = Date.now();
          continue;
        }
        const disk = await readTextFile(root, abs);
        if (!isCurrent() || !isLiveTab(tab, abs)) return;
        markExternalUpdate(abs);
        tab.content = disk;
        tab.original = disk;
        tab.dirty = false;
        tab.previewNonce = Date.now();
        autoSaveBlockedPaths.delete(abs);
        externalConflictVersions.delete(abs);
      } catch (error) {
        if (!isCurrent() || !isLiveTab(tab, abs)) return;
        workspace.showNotice(
          error instanceof Error ? error.message : String(error),
          3200,
        );
      }
    }

    if (!isCurrent()) return;
    const compare = useCompareStore();
    for (const tab of [...compare.tabs]) {
      const norm = tab.path.replace(/\\/g, "/");
      if (relSet.has(norm)) {
        compare.closeTab(tab.id);
      }
    }
  }

  function setCursor(path: string, line: number, column: number) {
    const tab = tabs.value.find((t) => t.path === path);
    if (!tab) return;
    tab.cursor = { line, column };
  }

  function activate(path: string) {
    useSessionsStore().blurSessions();
    useCompareStore().blurCompare();
    void import("@/stores/gitLog").then(({ useGitLogStore }) => {
      useGitLogStore().blurLog();
    });
    activePath.value = path;
    // 切换到已打开的 tab 时，CodeMirrorEditor 的 :key 不变（同一路径），
    // 组件不重建。props.content 会变成该 tab 的内容，但 watcher 的断环逻辑
    // 会阻断非外部修改的 dispatch。这里标记外部修改，让 watcher 正确同步内容。
    markExternalUpdate(path);
    const workspace = useWorkspaceStore();
    workspace.selectPath(path);
    workspace.revealPath(path);
  }

  /** 切到下一个标签；末尾循环到首个（VSCode 行为） */
  function activateNextTab() {
    if (tabs.value.length < 2) return;
    const idx = tabs.value.findIndex((t) => t.path === activePath.value);
    if (idx < 0) {
      activate(tabs.value[0].path);
      return;
    }
    const next = tabs.value[(idx + 1) % tabs.value.length];
    activate(next.path);
  }

  /** 切到上一个标签；首部循环到末个（VSCode 行为） */
  function activatePrevTab() {
    if (tabs.value.length < 2) return;
    const idx = tabs.value.findIndex((t) => t.path === activePath.value);
    if (idx < 0) {
      activate(tabs.value[0].path);
      return;
    }
    const prev = tabs.value[(idx - 1 + tabs.value.length) % tabs.value.length];
    activate(prev.path);
  }

  /**
   * 格式化文件（项目本地 prettier 优先，内置引擎兜底，开箱即用零配置）。
   * quiet 模式用于「保存时格式化」：不弹成功/失败提示，失败静默保留原内容。
   */
  async function formatDocument(path?: string, options?: { quiet?: boolean }) {
    const workspace = useWorkspaceStore();
    const settings = useSettingsStore();
    if (!settings.editor.prettierEnabled) {
      if (!options?.quiet) workspace.showNotice("请先在设置中启用代码格式化");
      return;
    }
    const targetPath = path ?? activePath.value;
    if (!targetPath) {
      if (!options?.quiet) workspace.showNotice("当前无活动文件可格式化");
      return;
    }
    if (isRasterImagePath(targetPath)) return;
    const scope = scopeFor(targetPath);
    if (!scope) return;
    const generation = workspaceGeneration;
    const isCurrent = () =>
      scopeFor(targetPath) === scope && generation === workspaceGeneration;

    let tab = tabs.value.find((t) => t.path === targetPath) ?? null;
    if (!tab) {
      await openFile(targetPath);
      if (!isCurrent()) return;
      tab = tabs.value.find((t) => t.path === targetPath) ?? null;
    }
    if (!tab) return;

    const tabPath = tab.path;
    const contentAtStart = tab.content;
    try {
      const formatted = await formatDocumentContent(
        scope,
        tabPath,
        contentAtStart,
      );
      // 格式化是异步的；用户可能在等待期间继续输入或关闭/重命名标签。
      // 只在同一个标签仍存在且内容未变时应用结果，避免覆盖新输入。
      if (
        !isCurrent() ||
        !isLiveTab(tab, tabPath) ||
        tab.content !== contentAtStart
      ) {
        return;
      }
      if (formatted !== tab.content) {
        markExternalUpdate(tabPath);
        tab.content = formatted;
        tab.dirty = true;
        if (!options?.quiet) workspace.showNotice(`已格式化 ${tab.name}`);
      } else if (!options?.quiet) {
        workspace.showNotice("无需格式化");
      }
    } catch (error) {
      if (!isCurrent()) return;
      // quiet 仅隐藏成功提示；格式化失败必须告知用户具体原因。
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  async function saveActive(options?: { quiet?: boolean; auto?: boolean }) {
    const workspace = useWorkspaceStore();
    const git = useGitStore();
    if (!activeTab.value) {
      if (!options?.quiet) {
        workspace.showNotice("当前无活动文件可保存");
      }
      return;
    }
    const tab = activeTab.value;
    if (isRasterImagePath(tab.path)) return;
    if (options?.auto && autoSaveBlockedPaths.has(tab.path)) return;
    const tabPath = tab.path;

    // light 模式（无工作区）也允许保存：作用域取文件所在目录。
    const scope = scopeFor(tabPath);
    if (!scope) {
      if (!options?.quiet) {
        workspace.showNotice("当前无活动文件可保存");
      }
      return;
    }
    const generation = workspaceGeneration;
    const isCurrent = () =>
      scopeFor(tabPath) === scope && generation === workspaceGeneration;

    // 保存时格式化：先格式化再写盘（失败静默，保留原内容继续保存）
    const settings = useSettingsStore();
    if (settings.editor.formatOnSave) {
      await formatDocument(tab.path, { quiet: true });
    }

    if (!isCurrent() || !isLiveTab(tab, tabPath)) return;
    let content = tab.content;
    if (!tab.dirty) return;
    try {
      workspace.markSelfWrite(tabPath);
      await writeTextFile(scope, tabPath, content);
      if (!isCurrent() || !isLiveTab(tab, tabPath)) return;
      // 写盘期间的新输入属于下一次保存，不能被本次快照错误标记为已保存。
      if (tab.content !== content) return;
      tab.original = content;
      tab.dirty = false;
      autoSaveBlockedPaths.delete(tab.path);
      externalConflictVersions.delete(tab.path);
      if (!options?.quiet) {
        workspace.showNotice(`已保存 ${tab.name}`);
      }
      void git.scheduleRefresh();
    } catch (error) {
      if (!isCurrent()) return;
      if (!options?.quiet) {
        workspace.showNotice(
          error instanceof Error ? error.message : String(error),
          3200,
        );
      }
    }
  }

  async function saveAll(options?: { quiet?: boolean; auto?: boolean }) {
    const workspace = useWorkspaceStore();
    const git = useGitStore();
    const generation = workspaceGeneration;
    const dirty = tabs.value.filter(
      (t) =>
        !isRasterImagePath(t.path) &&
        t.dirty &&
        !(options?.auto && autoSaveBlockedPaths.has(t.path)),
    );
    if (!dirty.length) return;
    try {
      let saved = 0;
      const settings = useSettingsStore();
      for (const tab of dirty) {
        const tabPath = tab.path;
        // 每个标签各取自己的作用域：项目窗口为工作区，light 模式为文件目录。
        const scope = scopeFor(tabPath);
        if (!scope) continue;
        const isCurrent = () =>
          scopeFor(tabPath) === scope && generation === workspaceGeneration;
        if (!isLiveTab(tab, tabPath)) continue;
        // 保存时格式化：先格式化再写盘（失败静默，保留原内容继续保存）
        if (settings.editor.formatOnSave) {
          await formatDocument(tabPath, { quiet: true });
        }
        if (!isCurrent() || !isLiveTab(tab, tabPath)) return;
        const content = tab.content;
        workspace.markSelfWrite(tabPath);
        await writeTextFile(scope, tabPath, content);
        if (!isCurrent() || !isLiveTab(tab, tabPath)) return;
        // 写盘期间的新输入仍保持 dirty，避免把未落盘内容误报为已保存。
        if (tab.content !== content) continue;
        tab.original = content;
        tab.dirty = false;
        autoSaveBlockedPaths.delete(tab.path);
        externalConflictVersions.delete(tab.path);
        saved += 1;
      }
      if (!options?.quiet && saved > 0) {
        workspace.showNotice(
          saved === 1 ? `已保存 ${dirty[0].name}` : `已保存 ${saved} 个文件`,
        );
      }
      // light 模式没有 Git 仓库，git store 内部会按无工作区直接返回。
      if (generation === workspaceGeneration) void git.scheduleRefresh();
    } catch (error) {
      if (generation !== workspaceGeneration) return;
      if (!options?.quiet) {
        workspace.showNotice(
          error instanceof Error ? error.message : String(error),
          3200,
        );
      }
    }
  }

  async function closeTab(path: string) {
    const tab = tabs.value.find((t) => t.path === path);
    if (!tab) return;
    if (tab.dirty) {
      const ok = window.confirm(`「${tab.name}」有未保存更改，仍要关闭？`);
      if (!ok) return;
    }
    const idx = tabs.value.findIndex((t) => t.path === path);
    tabs.value = tabs.value.filter((t) => t.path !== path);
    // 清除外部更新标记：否则重开同路径文件时会触发一次多余的 CM dispatch
    pendingExternalUpdates.delete(path);
    autoSaveBlockedPaths.delete(path);
    externalConflictVersions.delete(path);
    if (activePath.value === path) {
      const next = tabs.value[idx] || tabs.value[idx - 1] || null;
      if (next) {
        activePath.value = next.path;
      } else {
        // 已无剩余文件标签：若终端标签已打开则兜底激活，避免「只剩终端却不激活」。
        // （closeTabsByPaths 批量关闭也会经由本函数，统一覆盖 closeAll/closeOthers 等场景）
        activePath.value = null;
        const sessions = useSessionsStore();
        if (sessions.open) sessions.focusSessions();
      }
    }
  }

  /** 固定标签排到左侧，组内保持相对顺序 */
  function reorderPinnedFirst() {
    const pinned = tabs.value.filter((t) => t.pinned);
    const rest = tabs.value.filter((t) => !t.pinned);
    tabs.value = [...pinned, ...rest];
  }

  function togglePin(path: string) {
    const tab = tabs.value.find((t) => t.path === path);
    if (!tab) return;
    tab.pinned = !tab.pinned;
    reorderPinnedFirst();
  }

  async function closeTabsByPaths(paths: string[]) {
    for (const path of paths) {
      await closeTab(path);
    }
  }

  async function closeOtherTabs(path: string) {
    const victims = tabs.value
      .filter((t) => t.path !== path && !t.pinned)
      .map((t) => t.path);
    await closeTabsByPaths(victims);
  }

  async function closeTabsToTheLeft(path: string) {
    const idx = tabs.value.findIndex((t) => t.path === path);
    if (idx <= 0) return;
    const victims = tabs.value
      .slice(0, idx)
      .filter((t) => !t.pinned)
      .map((t) => t.path);
    await closeTabsByPaths(victims);
  }

  async function closeTabsToTheRight(path: string) {
    const idx = tabs.value.findIndex((t) => t.path === path);
    if (idx < 0 || idx >= tabs.value.length - 1) return;
    const victims = tabs.value
      .slice(idx + 1)
      .filter((t) => !t.pinned)
      .map((t) => t.path);
    await closeTabsByPaths(victims);
  }

  async function closeAllTabs() {
    const victims = tabs.value.filter((t) => !t.pinned).map((t) => t.path);
    await closeTabsByPaths(victims);
  }

  function renameTabPath(from: string, to: string) {
    const tab = tabs.value.find((t) => t.path === from);
    if (!tab) return;
    if (from !== to) {
      if (pendingExternalUpdates.delete(from)) {
        pendingExternalUpdates.add(to);
      }
      if (autoSaveBlockedPaths.delete(from)) {
        autoSaveBlockedPaths.add(to);
      }
      if (externalConflictVersions.has(from)) {
        const version = externalConflictVersions.get(from);
        externalConflictVersions.delete(from);
        if (version !== undefined) externalConflictVersions.set(to, version);
      }
    }
    tab.path = to;
    tab.id = to;
    tab.name = basename(to);
    tab.language = languageFromPath(to);
    tab.previewNonce = Date.now();
    if (activePath.value === from) activePath.value = to;
  }

  /** 文件夹移动后批量更新其下已打开标签路径 */
  function renameTabsUnderPrefix(fromPrefix: string, toPrefix: string) {
    const normFrom = fromPrefix.replace(/\\/g, "/").replace(/\/+$/, "");
    const normTo = toPrefix.replace(/\\/g, "/").replace(/\/+$/, "");
    for (const tab of [...tabs.value]) {
      const normPath = tab.path.replace(/\\/g, "/");
      if (normPath === normFrom) {
        renameTabPath(tab.path, toPrefix);
      } else if (normPath.startsWith(`${normFrom}/`)) {
        const suffix = normPath.slice(normFrom.length);
        renameTabPath(tab.path, `${normTo}${suffix}`);
      }
    }
  }

  function closeTabsUnder(prefix: string): boolean {
    const victims = tabs.value.filter(
      (t) =>
        t.path === prefix ||
        t.path.startsWith(`${prefix}/`) ||
        t.path.startsWith(`${prefix}\\`),
    );
    // 脏标签汇总确认（与 closeTab / 切换工作区一致）：
    // 删除目录可能连带关闭含未保存改动的文件，静默丢弃不可接受
    const dirty = victims.filter(
      (t) => !isRasterImagePath(t.path) && t.dirty,
    );
    if (dirty.length > 0) {
      const ok = window.confirm(
        `${dirty.length} 个文件有未保存更改，关闭标签将丢弃这些更改。继续？`,
      );
      if (!ok) return false;
    }
    for (const tab of victims) {
      tabs.value = tabs.value.filter((t) => t.path !== tab.path);
      pendingExternalUpdates.delete(tab.path);
      autoSaveBlockedPaths.delete(tab.path);
      externalConflictVersions.delete(tab.path);
    }
    if (activePath.value && victims.some((t) => t.path === activePath.value)) {
      activePath.value = tabs.value[0]?.path ?? null;
    }
    return true;
  }

  /** 切换工作区前：有未保存更改则确认是否丢弃 */
  function confirmDiscardForWorkspaceSwitch(): boolean {
    const dirty = tabs.value.filter(
      (t) => !isRasterImagePath(t.path) && t.dirty,
    );
    if (!dirty.length) return true;
    return window.confirm(
      `${dirty.length} 个文件有未保存更改，切换项目将丢弃这些更改。继续？`,
    );
  }

  /** 切换工作区后清空文件标签与跳转栈 */
  function clearForWorkspaceSwitch() {
    workspaceGeneration += 1;
    restoreGeneration += 1;
    restoringSession = false;
    referencesRequestSeq += 1;
    referencesVisible.value = false;
    referenceResults.value = [];
    tabs.value = [];
    activePath.value = null;
    jumpStack.value = [];
    forwardJumpStack.value = [];
    recentPaths.value = [];
    openAt.value = null;
    pendingExternalUpdates.clear();
    autoSaveBlockedPaths.clear();
    externalConflictVersions.clear();
  }

  // ==================== Markdown 预览/编辑模式（按文件路径持久化） ====================
  // 切换模式不存到 EditorTab，避免序列化与 watcher 关注列表膨胀；
  // 直接走 localStorage（按完整路径 key），切回同一文件自动恢复上次选择。
  // 默认 'preview'，与首次打开行为一致。
  const MD_MODE_KEY = (path: string) => `prismcode.md-mode:${path}`;

  /** 读取某路径上次的 MD 模式；非 MD 路径或无记录返回 'preview' */
  function getMdMode(path: string): "preview" | "edit" {
    try {
      const v = localStorage.getItem(MD_MODE_KEY(path));
      return v === "edit" ? "edit" : "preview";
    } catch {
      return "preview";
    }
  }

  /** 显式设置 MD 模式（写 localStorage）；不存在的 tab 不创建 */
  function setMdMode(path: string, mode: "preview" | "edit") {
    try {
      localStorage.setItem(MD_MODE_KEY(path), mode);
    } catch {
      // localStorage 满 / 隐私模式：静默忽略，不阻断 UI 切换
    }
  }

  // ==================== macOS Dock 菜单：当前文件同步 ====================
  // 切 tab / 关 tab / 切换工作区都会改 activePath，watch 统一同步到 Dock 菜单
  watch(
    [tabs, activePath],
    () => {
      schedulePersistSession();
    },
    { deep: true },
  );

  watch(activePath, (path) => {
    if (path) rememberRecent(path);
    void useWorkspaceStore().syncDockMenu();
  });

  return {
    tabs,
    activePath,
    activeTab,
    dirtyPaths,
    jumpStack,
    forwardJumpStack,
    recentPaths,
    openAt,
    findRequest,
    blameVisible,
    isDirty,
    pushJump,
    takeJumpBack,
    takeJumpForward,
    requestOpenAt,
    requestFind,
    referencesVisible,
    referenceWord,
    referenceResults,
    openReferences,
    closeReferences,
    toggleBlame,
    persistSession,
    restoreSession,
    openFile,
    openFileAt,
    setContent,
    syncFromDisk,
    markExternalUpdate,
    consumeExternalUpdate,
    syncExternalChanges,
    reloadAfterDiscard,
    setCursor,
    activate,
    activateNextTab,
    activatePrevTab,
    saveActive,
    saveAll,
    hasAutoSaveableChanges,
    formatDocument,
    closeTab,
    togglePin,
    closeOtherTabs,
    closeTabsToTheLeft,
    closeTabsToTheRight,
    closeAllTabs,
    renameTabPath,
    renameTabsUnderPrefix,
    closeTabsUnder,
    confirmDiscardForWorkspaceSwitch,
    clearForWorkspaceSwitch,
    getMdMode,
    setMdMode,
  };
});
