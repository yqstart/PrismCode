import { computed, ref, watch as watchState } from "vue";
import { defineStore } from "pinia";
import { ask, open } from "@tauri-apps/plugin-dialog";
import {
 watchImmediate as watchFs,
 type UnwatchFn,
 type WatchEvent,
} from "@tauri-apps/plugin-fs";
import {
 basename,
 copyEntry,
 copyExternalEntry,
 createEntry,
 deleteEntry,
 dirname,
 joinPath,
 listDir,
 nextCopyName,
 readSystemClipboardFiles,
 normalizeAbsPath,
 pathExists,
 renameEntry,
 type DirEntryInfo,
} from "@/shared/fs";
import { validateMoveTarget } from "@/shared/importReferences";
import { resolveBookmark, saveBookmark } from "@/shared/securityScoped";
import {
 clearRecentFolders as clearRecentFoldersStorage,
 loadRecentFolders,
 pushRecentFolder,
 removeRecentFolder as removeRecentFolderStorage,
} from "@/shared/path";
import { saveMainWindowRoot } from "@/shared/windowSession";
import { promptInput } from "@/shared/promptDialog";
import { searchFiles, type FileSearchHit } from "@/shared/searchApi";
import { getTopLevelSelectionPaths } from "@/features/explorer/selection";
import { useCompareStore } from "@/stores/compare";
import { useEditorStore } from "@/stores/editor";
import { useGitStore } from "@/stores/git";
import { useSearchStore } from "@/stores/search";
import { useSessionsStore } from "@/stores/sessions";
import { useSettingsStore } from "@/stores/settings";
import { workspaceSymbols } from "@/features/editor/workspaceSymbols";
import type { UpdateImportsOnMove } from "@/shared/types";

const WATCH_IGNORE_NAMES = new Set([
 ".git",
 "node_modules",
 "target",
 ".prismcode",
 ".prismcode-index",
 ".DS_Store",
]);

/** 高频外部写盘时只在安静窗口刷新，避免终端日志/构建器拖垮整个 WebView。 */
const WATCH_FLUSH_DEBOUNCE_MS = 700;
const WATCH_FLUSH_MIN_INTERVAL_MS = 1000;

/** 终端 / 外部 git 命令会改这些路径；需触发状态刷新，但不要刷新资源树 */
function isGitMetaPath(path: string): boolean {
 return /(?:^|[/\\])\.git(?:[/\\]|$)/.test(path);
}

export interface TreeNode extends DirEntryInfo {
 depth: number;
 expanded?: boolean;
 loaded?: boolean;
 children?: TreeNode[];
}

export interface MovePathResult {
 from: string;
 to: string;
 isDir: boolean;
 /** 在实际移动开始前捕获，确保后续引用更新遵循本次操作的设置。 */
 updateImportsOnMove: UpdateImportsOnMove;
}

export interface OpenFolderOptions {
 quiet?: boolean;
 /** restoreLastFolder 已经在读取目录前激活过书签，避免重复激活。 */
 bookmarkResolved?: boolean;
}

/** Toast 操作按钮 */
export interface ToastAction {
 label: string;
 onClick: () => void;
}

/** Toast 通知条目 */
export interface ToastItem {
 id: number;
 message: string;
 /** 可选操作按钮（如「安装」）；带 action 的 toast 不自动消失 */
 action?: ToastAction;
}

export const useWorkspaceStore = defineStore("workspace", () => {
 const rootPath = ref<string | null>(null);
 const rootName = ref("未打开文件夹");
 /** 通知队列：可同时堆叠多条，由 ToastHost 渲染 */
 const toasts = ref<ToastItem[]>([]);
 const filter = ref("");
 const selectedPath = ref<string | null>(null);
 /** 资源管理器当前选中的路径；selectedPath 是其中的焦点路径。 */
 const selectedPaths = ref<string[]>([]);
 const childrenMap = ref<Record<string, DirEntryInfo[]>>({});
 const expanded = ref<Set<string>>(new Set());
 const recentFolders = ref<string[]>(loadRecentFolders());
 const clipboard = ref<{
  mode: "copy" | "cut";
  path: string;
  isDir: boolean;
 } | null>(null);
 const extraIgnores = ref<string[]>([]);
 /** 触发资源树滚动到目标节点 */
 const revealToken = ref(0);
 const revealTarget = ref<string | null>(null);
 /** 过滤框的全项目定位结果（补全仅已加载节点的不足） */
 const locateHits = ref<FileSearchHit[]>([]);
 const locateLoading = ref(false);
 const refreshing = ref(false);
 /** 刷新进行中又收到变更：结束后补刷一轮（防丢 watch 事件，git store 同款） */
 let refreshAgain = false;
 const watchActive = ref(false);

 let noticeSeq = 0;
 const noticeTimers = new Map<number, number>();
 let locateTimer: number | undefined;
 let unwatchFn: UnwatchFn | null = null;
 let refreshTimer: number | undefined;
 let gitRefreshTimer: number | undefined;
 let lastWatchFlushAt = 0;
 let locateSearchSeq = 0;
 let openFolderSeq = 0;
 let refreshRunSeq = 0;
 let refreshingEpoch = -1;
 const selfWriteUntil = new Map<string, number>();
 let pendingWatchPaths = new Set<string>();
 let pendingWatchNeedsTreeRefresh = false;
 /**
  * 工作区代际计数：openFolder 每次提交新工作区时自增。异步读取
  * （loadChildren/refreshTree/refreshDirsForPaths）在 await 之后校验代际，
  * 防止旧工作区的在途结果整表覆盖新工作区的资源树。
  */
 let workspaceEpoch = 0;

 function isPathWithinRoot(root: string, path: string): boolean {
  const normalizedRoot = root === "/" ? "/" : normalizeAbsPath(root);
  const normalizedPath = path === "/" ? "/" : normalizeAbsPath(path);
  if (normalizedRoot === "/") return normalizedPath.startsWith("/");
  return (
   normalizedPath === normalizedRoot ||
   normalizedPath.startsWith(`${normalizedRoot}/`)
  );
 }

 function showNotice(message: string, ms = 2400, action?: ToastAction) {
  const id = ++noticeSeq;
  toasts.value.push({ id, message, action });
  // 带 action 的 toast 默认不自动消失（ms=0），等用户点击操作或手动关闭
  if (ms > 0) {
   const timer = window.setTimeout(() => {
    toasts.value = toasts.value.filter((x) => x.id !== id);
    noticeTimers.delete(id);
   }, ms);
   noticeTimers.set(id, timer);
  }
 }

 function dismissNotice(id: number) {
  const timer = noticeTimers.get(id);
  if (timer != null) window.clearTimeout(timer);
  noticeTimers.delete(id);
  toasts.value = toasts.value.filter((x) => x.id !== id);
 }

 function setSelection(
  paths: readonly string[],
  activePath: string | null = paths[paths.length - 1] ?? null,
 ) {
  const uniquePaths = [...new Set(paths)];
  const nextActivePath =
   activePath && uniquePaths.includes(activePath)
    ? activePath
    : (uniquePaths[uniquePaths.length - 1] ?? null);
  selectedPaths.value = uniquePaths;
  selectedPath.value = nextActivePath;
 }

 const flatTree = computed(() => {
  if (!rootPath.value) return [] as TreeNode[];
  const result: TreeNode[] = [];
  const q = filter.value.trim().toLowerCase();

  // 子树匹配缓存：自底向上一次 DFS 计算各目录「子孙中是否有命中」，
  // 避免原实现每个目录都递归重扫整棵子树（深层大目录下 O(n·d)）
  const descMatch = new Map<string, boolean>();
  const hasDescendantMatch = (path: string): boolean => {
   const cached = descMatch.get(path);
   if (cached !== undefined) return cached;
   let found = false;
   for (const child of childrenMap.value[path] || []) {
    if (child.name.toLowerCase().includes(q)) {
     found = true;
     break;
    }
    if (child.isDir && hasDescendantMatch(child.path)) {
     found = true;
     break;
    }
   }
   descMatch.set(path, found);
   return found;
  };

  const walk = (path: string, depth: number) => {
   const kids = childrenMap.value[path] || [];
   for (const child of kids) {
    const match = !q || child.name.toLowerCase().includes(q);
    const isExpanded = expanded.value.has(child.path);
    if (child.isDir) {
     if (match || hasDescendantMatch(child.path)) {
      result.push({
       ...child,
       depth,
       expanded: isExpanded,
       loaded: Boolean(childrenMap.value[child.path]),
      });
      if (isExpanded || q) {
       if (!childrenMap.value[child.path]) {
        // 过滤模式下懒加载已展开节点的子级由外部触发
       } else {
        walk(child.path, depth + 1);
       }
      }
     }
    } else if (match) {
     result.push({ ...child, depth });
    }
   }
  };

  walk(rootPath.value, 0);
  return result;
 });

 async function loadChildren(path: string) {
  const root = rootPath.value;
  if (!root) return;
  const epoch = workspaceEpoch;
  const entries = await listDir(root, path, extraIgnores.value);
  // 等待期间已切换工作区：旧结果作废，不污染新工作区的资源树
  if (rootPath.value !== root || epoch !== workspaceEpoch) return;
  childrenMap.value = { ...childrenMap.value, [path]: entries };
 }

 async function loadChildrenSafely(path: string): Promise<boolean> {
  const root = rootPath.value;
  const epoch = workspaceEpoch;
  try {
   await loadChildren(path);
   return true;
  } catch (error) {
   if (rootPath.value !== root || workspaceEpoch !== epoch) return false;
   showNotice(
    `无法读取目录：${error instanceof Error ? error.message : String(error)}`,
    3200,
   );
   return false;
  }
 }

 function markSelfWrite(path: string, ms = 1600) {
  selfWriteUntil.set(path, Date.now() + ms);
 }

 function isSelfWrite(path: string) {
  const until = selfWriteUntil.get(path);
  if (!until) return false;
  if (Date.now() > until) {
   selfWriteUntil.delete(path);
   return false;
  }
  return true;
 }

 function shouldIgnoreWatchPath(path: string) {
  return path.split(/[/\\]/).some((part) => WATCH_IGNORE_NAMES.has(part));
 }

 function stopWatch() {
  unwatchFn?.();
  unwatchFn = null;
  watchActive.value = false;
  window.clearTimeout(refreshTimer);
  window.clearTimeout(gitRefreshTimer);
  pendingWatchPaths = new Set();
  pendingWatchNeedsTreeRefresh = false;
  lastWatchFlushAt = 0;
 }

 function scheduleGitRefresh() {
  window.clearTimeout(gitRefreshTimer);
  gitRefreshTimer = window.setTimeout(() => {
   void useGitStore().refresh();
  }, 420);
 }

 async function startWatch(root: string) {
  stopWatch();
  const epoch = workspaceEpoch;
  try {
   // plugin-fs 的 debounced watch 在 macOS/Windows 会先用 FileIdMap
   // 递归扫描整个工作区；大型 target/node_modules 可让注册监听耗时数秒。
   // 这里使用无预扫描的原始 watcher，事件合并继续由本 store 下方的
   // WATCH_FLUSH_DEBOUNCE_MS / WATCH_FLUSH_MIN_INTERVAL_MS 统一承担。
   const unwatch = await watchFs(
    root,
    (event) => {
     onWatchEvent(event, root, epoch);
    },
    { recursive: true },
   );
   // 等待期间已切换到别的文件夹：释放刚建立的监听，避免监听目标与 rootPath 错位
   if (rootPath.value !== root || workspaceEpoch !== epoch) {
    unwatch();
    return;
   }
   unwatchFn = unwatch;
   watchActive.value = true;
  } catch {
   if (rootPath.value !== root || workspaceEpoch !== epoch) return;
   watchActive.value = false;
   showNotice("无法自动监听文件变更，请使用刷新按钮", 3200);
  }
 }

 function watchEventNeedsTreeRefresh(type: WatchEvent["type"]): boolean {
  if (typeof type === "string") return type === "any" || type === "other";
  if ("create" in type || "remove" in type) return true;
  if ("modify" in type) {
   // 文件内容/元数据变化不会改变资源树；重命名和未知变化需要重列目录。
   return type.modify.kind === "rename" || type.modify.kind === "other";
  }
  return false;
 }

 function scheduleWatchFlush(): void {
  window.clearTimeout(refreshTimer);
  const elapsed = Date.now() - lastWatchFlushAt;
  const wait = Math.max(
   WATCH_FLUSH_DEBOUNCE_MS,
   WATCH_FLUSH_MIN_INTERVAL_MS - elapsed,
  );
  refreshTimer = window.setTimeout(() => {
   refreshTimer = undefined;
   void flushWatchChanges();
  }, wait);
 }

 function onWatchEvent(
  event: WatchEvent,
  expectedRoot: string,
  expectedEpoch: number,
 ) {
  if (
   !rootPath.value ||
   rootPath.value !== expectedRoot ||
   workspaceEpoch !== expectedEpoch
  ) {
   return;
  }
  let gitTouched = false;
  for (const p of event.paths || []) {
   if (isSelfWrite(p)) continue;
   // .git 变更：仅刷新 Git 状态（终端 commit/checkout 等）
   if (isGitMetaPath(p)) {
    gitTouched = true;
    continue;
   }
   if (shouldIgnoreWatchPath(p)) continue;
   pendingWatchPaths.add(p);
  }
  if (gitTouched) scheduleGitRefresh();
  if (!pendingWatchPaths.size) return;
  pendingWatchNeedsTreeRefresh =
   pendingWatchNeedsTreeRefresh || watchEventNeedsTreeRefresh(event.type);
  scheduleWatchFlush();
 }

 async function flushWatchChanges() {
  if (!rootPath.value || !pendingWatchPaths.size) return;
  if (refreshing.value && refreshingEpoch === workspaceEpoch) {
   // 当前刷新结束后由 finally 重新安排，不能提前清空这批路径。
   refreshAgain = true;
   scheduleWatchFlush();
   return;
  }
  const changed = [...pendingWatchPaths];
  pendingWatchPaths = new Set();
  const refreshTree = pendingWatchNeedsTreeRefresh;
  pendingWatchNeedsTreeRefresh = false;
  lastWatchFlushAt = Date.now();
  // 工作区文件变了也会刷新 git；取消排队中的纯 git 刷新，避免重复
  window.clearTimeout(gitRefreshTimer);
  refreshAgain = false;
  await refreshFromDisk(changed, { quiet: true, refreshTree });
  if (pendingWatchPaths.size) scheduleWatchFlush();
 }

 async function refreshFromDisk(
  changedAbsPaths: string[] = [],
  options: { quiet?: boolean; refreshTree?: boolean } = {},
 ) {
  if (!rootPath.value) return;
  if (refreshing.value && refreshingEpoch === workspaceEpoch) {
   refreshAgain = true;
   return;
  }
  // 工作区切换时，旧工作区的刷新可能仍在 await 中；允许新代际立即开始
  // 刷新，并让旧任务的 finally 通过 runSeq 校验，不能清掉新任务的状态。
  if (refreshing.value) refreshAgain = false;
  const root = rootPath.value;
  const epoch = workspaceEpoch;
  const runSeq = ++refreshRunSeq;
  const isCurrent = () => rootPath.value === root && workspaceEpoch === epoch;
  refreshing.value = true;
  refreshingEpoch = epoch;
  try {
   // 仅重列受影响的父目录（文件变更局部刷新），避免大目录全量重列卡顿
   if (changedAbsPaths.length && options.refreshTree !== false) {
    await refreshDirsForPaths(changedAbsPaths);
   } else if (!changedAbsPaths.length) {
    await refreshTree();
   }
   if (!isCurrent()) return;
   const { useEditorStore } = await import("@/stores/editor");
   const editor = useEditorStore();
   const openAbs = new Set(editor.tabs.map((t) => t.path));
   const touched = changedAbsPaths.filter(
    (p) => isPathWithinRoot(root, p) && openAbs.has(p),
   );
   // 若未给出具体路径（手动刷新），同步全部打开标签
   if (!changedAbsPaths.length) {
    await editor.syncExternalChanges(editor.tabs.map((t) => t.path));
   } else if (touched.length) {
    await editor.syncExternalChanges(touched);
   }
   if (!isCurrent()) return;
   void useGitStore().refresh();
   if (!options.quiet) {
    showNotice("资源管理器已刷新");
   }
  } finally {
   if (runSeq === refreshRunSeq) {
    refreshing.value = false;
    refreshingEpoch = -1;
    if (
     epoch === workspaceEpoch &&
     refreshAgain &&
     pendingWatchPaths.size
    ) {
     refreshAgain = false;
     scheduleWatchFlush();
    }
   }
  }
 }

 async function openFolder(
  path?: string | null,
  options?: OpenFolderOptions,
 ): Promise<boolean> {
  const requestId = ++openFolderSeq;
  const isLatestRequest = () => requestId === openFolderSeq;
  try {
   let selected = path;
   if (!selected) {
    selected = await open({
     directory: true,
     multiple: false,
     title: "打开文件夹",
    });
   }
   if (!selected || Array.isArray(selected)) return false;
   if (!isLatestRequest()) return false;

   const previousRoot = rootPath.value;
   const isWorkspaceSwitch = Boolean(
    previousRoot && previousRoot !== selected,
   );
   // 首次打开工作区也要恢复该窗口在此工作区的终端快照；同一工作区
   // 重新选择时则保留当前编辑器和终端，不做销毁重建。
   const shouldResetWorkspaceSessions = previousRoot !== selected;
   if (isWorkspaceSwitch) {
    const editor = useEditorStore();
    if (!editor.confirmDiscardForWorkspaceSwitch()) return false;
    // 在 rootPath 改变前先落盘旧工作区的标签/光标/未保存快照，
    // 否则 clearForWorkspaceSwitch 后无法再找回旧会话。
    editor.persistSession(previousRoot);
    useSessionsStore().persistSession(previousRoot);
   }

   // 通过最近项目、Dock 菜单、启动恢复或新窗口 URL 进入时，没有经过
   // NSOpenPanel 的即时授权；先激活已保存的 security-scoped bookmark，
   // 再访问目录，避免 macOS 把同一项目当成首次访问而重复询问。
   // 首次打开没有书签时 resolveBookmark 返回 false，继续走原有授权流程。
   if (!options?.bookmarkResolved) {
    await resolveBookmark(selected);
   }
   if (!isLatestRequest()) return false;

   // 先把所有会抛错的异步操作（list_dir、reset stores）跑完并吞错。
   // 任一步失败都只 toast 通知 + 提前 return，绝不污染 rootPath 等已显示状态。
   let entries: DirEntryInfo[] = [];
   try {
    entries = await listDir(selected, selected, extraIgnores.value);
    if (!isLatestRequest()) return false;
   } catch (error) {
    if (isLatestRequest()) {
     showNotice(
      `无法打开 ${selected}：${error instanceof Error ? error.message : String(error)}`,
      3200,
     );
    }
    return false;
   }

   // 收集所有 reset/refresh 调用的错误，仅记日志不影响主流程
   const sideErrors: string[] = [];
   async function safeCall(
    label: string,
    fn: () => unknown | Promise<unknown>,
   ) {
    try {
     await fn();
    } catch (e) {
     sideErrors.push(
      `${label}: ${e instanceof Error ? e.message : String(e)}`,
     );
    }
   }

   // 提交语义：先改 UI 状态（rootPath 等），再触发 reset/refresh。
   // 即使后续 reset 全部失败，UI 至少是「打开了」——比「半残状态」更可恢复。
   if (!isLatestRequest()) return false;
   stopWatch();
   refreshAgain = false;
   if (previousRoot !== selected) {
    // workspaceSymbols 是跨编辑器能力共享的单例；切根前递增代际，
    // 使旧工作区在途扫描即使晚返回也不能污染新索引。
    workspaceSymbols.clear();
   }
   workspaceEpoch += 1;
   rootPath.value = selected;
   rootName.value = basename(selected);
   childrenMap.value = { [selected]: entries };
   expanded.value = new Set([selected]);
   setSelection([selected]);
   filter.value = "";
   invalidateLocateSearch();
   clipboard.value = null;
   selfWriteUntil.clear();
   recentFolders.value = pushRecentFolder(selected);
   // 只记主窗口最近打开的工作区，供应用重启时恢复；动态窗口调用是
   // no-op，编辑器 / 终端快照仍按窗口 ID 隔离（shared/windowSession）。
   saveMainWindowRoot(selected);

   if (shouldResetWorkspaceSessions) {
    if (isWorkspaceSwitch) {
     useEditorStore().clearForWorkspaceSwitch();
     useCompareStore().clearAll();
    }
    await safeCall("sessions", () =>
     useSessionsStore().resetLocalForWorkspace(selected),
    );
    if (!isLatestRequest()) return false;
    if (isWorkspaceSwitch) {
     const { useSshStore } = await import("@/stores/ssh");
     await safeCall("ssh", () => useSshStore().resetForWorkspace());
     if (!isLatestRequest()) return false;
     const search = useSearchStore();
     search.clearResults();
     search.closeQuickOpen();
     search.closeFindInFiles();
     useGitStore().clearForWorkspaceSwitch();
     const { usePackageScriptsStore } =
      await import("@/stores/packageScripts");
     usePackageScriptsStore().clear();
    }
   }

   // 工作区状态已提交后再恢复该根目录自己的编辑器会话；恢复失败不影响
   // 打开项目主流程，只在开发日志中保留原因。
   await safeCall("editor session", () =>
    useEditorStore().restoreSession(selected),
   );
   if (!isLatestRequest()) return false;

   // 首次恢复工作区时也要加载已勾选的脚本，供终端顶栏直接展示。
   const { usePackageScriptsStore } =
    await import("@/stores/packageScripts");
   if (!isLatestRequest()) return false;
   void usePackageScriptsStore().refresh(true);

   if (sideErrors.length) {
    console.warn("[openFolder] side resets had errors:", sideErrors);
   }

   if (!options?.quiet) {
    showNotice(`已打开 ${rootName.value}`);
   }
   void useGitStore().refresh();
   void startWatch(selected);
   // 同步 macOS Dock 菜单（最近项目 + 当前文件）。
   // store 内部读 editor.activePath 拿当前文件，避免调用方传 stale 值。
   void syncDockMenu();
   // macOS：把刚授权的工作区路径写为 security-scoped bookmark，
   // 下次自动更新后启动可走书签激活，不被 TCC 再问一次。
   // 等待写入完成，避免用户刚打开就重新进入项目时遇到保存竞态。
   await saveBookmark(selected);
   return isLatestRequest();
  } catch (error) {
   if (isLatestRequest() && !options?.quiet) {
    showNotice(
     error instanceof Error ? error.message : String(error),
     3200,
    );
   }
   return false;
  }
 }

 /** 启动时恢复最近一次成功打开的工作区 */
 async function restoreLastFolder() {
  if (rootPath.value) return;
  const openRequestAtStart = openFolderSeq;
  for (const path of recentFolders.value) {
   // macOS：先 resolve security-scoped bookmark 激活访问权（避免 TCC 弹问）
   // 失败（路径失效）继续尝试下一个；resolve 失败时 helper 会自动清掉旧 bookmark
   const ok = await resolveBookmark(path);
   if (!ok) continue;
   // 用户在恢复期间主动打开了其他项目：主动操作优先，不能被旧恢复请求覆盖。
   if (rootPath.value || openFolderSeq !== openRequestAtStart) return;
   const opened = await openFolder(path, {
    quiet: true,
    bookmarkResolved: true,
   });
   if (opened) return;
  }
 }

 async function toggleExpand(path: string) {
  const root = rootPath.value;
  const epoch = workspaceEpoch;
  if (!root) return;
  const next = new Set(expanded.value);
  if (next.has(path)) {
   next.delete(path);
  } else {
   next.add(path);
   if (!childrenMap.value[path]) {
    if (!(await loadChildrenSafely(path))) {
     if (rootPath.value !== root || workspaceEpoch !== epoch) return;
     next.delete(path);
     expanded.value = next;
     return;
    }
    if (rootPath.value !== root || workspaceEpoch !== epoch) return;
   }
  }
  expanded.value = next;
 }

 async function refreshTree() {
  if (!rootPath.value) return;
  const root = rootPath.value;
  const epoch = workspaceEpoch;
  const paths = Object.keys(childrenMap.value);
  const nextMap: Record<string, DirEntryInfo[]> = {};
  await Promise.all(
   paths.map(async (p) => {
    try {
     if (p !== root && !(await pathExists(root, p))) return;
     nextMap[p] = await listDir(root, p, extraIgnores.value);
    } catch {
     // 目录已消失则丢弃缓存
    }
   }),
  );
  // 等待期间已切换工作区：结果作废
  if (epoch !== workspaceEpoch) return;
  childrenMap.value = nextMap;
  const nextExpanded = new Set(
   [...expanded.value].filter((p) => p === root || Boolean(nextMap[p])),
  );
  nextExpanded.add(root);
  expanded.value = nextExpanded;
 }

 /**
  * 只重列受变更影响的父目录（文件变更局部刷新）。
  * 相比 refreshTree 的全量重列，大目录下显著降低保存/变更时的卡顿。
  */
 async function refreshDirsForPaths(changedAbsPaths: string[]) {
  const root = rootPath.value;
  if (!root) return;
  const epoch = workspaceEpoch;
  const dirs = new Set<string>();
  for (const p of changedAbsPaths) {
   if (!isPathWithinRoot(root, p)) continue;
   // 变更本身是目录则刷新它，否则刷新其父目录
   const target = childrenMap.value[p] !== undefined ? p : dirname(p);
   if (
    isPathWithinRoot(root, target) &&
    childrenMap.value[target] !== undefined
   ) {
    dirs.add(target);
   }
  }
  dirs.add(root);
  const nextMap = { ...childrenMap.value };
  await Promise.all(
   [...dirs].map(async (d) => {
    try {
     if (d !== root && !(await pathExists(root, d))) {
      delete nextMap[d];
      return;
     }
     nextMap[d] = await listDir(root, d, extraIgnores.value);
    } catch {
     delete nextMap[d];
    }
   }),
  );
  // 等待期间已切换工作区：结果作废
  if (epoch !== workspaceEpoch) return;
  childrenMap.value = nextMap;
 }

 async function createIn(parent: string, isDir: boolean) {
  const root = rootPath.value;
  if (!root) return;
  const epoch = workspaceEpoch;
  const isCurrent = () => rootPath.value === root && workspaceEpoch === epoch;
  const label = isDir ? "新建文件夹" : "新建文件";
  const name = await promptInput({
   title: label,
   label: isDir ? "文件夹名称" : "文件名称",
   placeholder: isDir ? "components" : "index.ts",
   confirmText: "创建",
  });
  if (!name?.trim() || !isCurrent()) return;
  const target = joinPath(parent, name.trim());
  try {
   markSelfWrite(target);
   markSelfWrite(parent);
   await createEntry(root, target, isDir);
   if (!isCurrent()) return;
   await loadChildren(parent);
   if (!isCurrent()) return;
   expanded.value = new Set([...expanded.value, parent]);
   setSelection([target]);
   showNotice(`${label}成功`);
   return target;
  } catch (error) {
   if (!isCurrent()) return;
   showNotice(error instanceof Error ? error.message : String(error), 3200);
  }
 }

 async function renamePath(path: string) {
  const root = rootPath.value;
  if (!root) return;
  const epoch = workspaceEpoch;
  const isCurrent = () => rootPath.value === root && workspaceEpoch === epoch;
  if (path === root) {
   showNotice("不能重命名工作区根目录");
   return;
  }
  const nextName = await promptInput({
   title: "重命名",
   label: "新名称",
   defaultValue: basename(path),
   confirmText: "重命名",
  });
  if (
   !nextName?.trim() ||
   nextName.trim() === basename(path) ||
   !isCurrent()
  ) {
   return;
  }
  const target = joinPath(dirname(path), nextName.trim());
  try {
   markSelfWrite(path);
   markSelfWrite(target);
   markSelfWrite(dirname(path));
   await renameEntry(root, path, target);
   if (!isCurrent()) return;
   await refreshAffected(path, target);
   if (!isCurrent()) return;
   setSelection([target]);
   showNotice("已重命名");
   return { from: path, to: target };
  } catch (error) {
   if (!isCurrent()) return;
   showNotice(error instanceof Error ? error.message : String(error), 3200);
  }
 }

 async function removePath(path: string) {
  const deleted = await removePaths([path]);
  return Boolean(deleted?.length);
 }

 /**
  * 批量删除工作区项目。
  * 目录与其子项同时选中时只删除目录，避免重复确认/删除；所有项目共用一次确认。
  */
 async function removePaths(
  paths: readonly string[],
 ): Promise<string[] | null> {
  const root = rootPath.value;
  if (!root) return null;
  const epoch = workspaceEpoch;
  const isCurrent = () => rootPath.value === root && workspaceEpoch === epoch;
  if (paths.some((path) => path === root)) {
   showNotice("不能删除工作区根目录");
   return null;
  }
  const candidates = getTopLevelSelectionPaths(paths);
  if (!candidates.length) {
   showNotice("不能删除工作区根目录");
   return null;
  }
  const prompt =
   candidates.length === 1
    ? `确定删除「${basename(candidates[0])}」？此操作不可撤销。`
    : `确定删除选中的 ${candidates.length} 个项目？此操作不可撤销。`;
  const ok = await ask(prompt, {
   title: "确认删除",
   kind: "warning",
  });
  if (!ok || !isCurrent()) return null;
  const deletedPaths: string[] = [];
  try {
   for (const path of candidates) {
    markSelfWrite(path);
    markSelfWrite(dirname(path));
    await deleteEntry(root, path);
    if (!isCurrent()) return null;
    deletedPaths.push(path);
   }

   const parents = new Set(deletedPaths.map((path) => dirname(path)));
   for (const parent of parents) {
    await loadChildren(parent);
    if (!isCurrent()) return null;
   }

   const nextParent = dirname(deletedPaths[0]);
   setSelection([nextParent]);
   showNotice(
    deletedPaths.length === 1
     ? "已删除"
     : `已删除 ${deletedPaths.length} 个项目`,
   );
   return deletedPaths;
  } catch (error) {
   if (!isCurrent()) return null;
   showNotice(error instanceof Error ? error.message : String(error), 3200);
   if (!deletedPaths.length) return null;
   // 部分删除成功：尽力刷新已删项的父目录并调整选中，保证树状态与磁盘一致。
   const parents = new Set(deletedPaths.map((path) => dirname(path)));
   for (const parent of parents) {
    await loadChildren(parent);
    if (!isCurrent()) return null;
   }
   setSelection([dirname(deletedPaths[0])]);
   return deletedPaths;
  }
 }

 function setClipboard(mode: "copy" | "cut", path: string, isDir: boolean) {
  clipboard.value = { mode, path, isDir };
  showNotice(mode === "copy" ? "已复制" : "已剪切");
 }

 async function pasteInto(parent: string) {
  const root = rootPath.value;
  const clipboardAtStart = clipboard.value;
  if (!root || !clipboardAtStart) return;
  const epoch = workspaceEpoch;
  const isCurrent = () => rootPath.value === root && workspaceEpoch === epoch;
  const source = clipboardAtStart.path;
  const mode = clipboardAtStart.mode;
  const isDir = clipboardAtStart.isDir;
  // 剪切粘贴同样属于「移动文件」，须与拖拽移动共用同一份 import 更新设置；
  // 在文件系统操作前捕获，避免移动完成后读取到新配置。
  const updateImportsOnMove = useSettingsStore().editor.updateImportsOnMove;
  const name = basename(source);
  let target = joinPath(parent, name);
  try {
   let n = 1;
   while (await pathExists(root, target)) {
    if (!isCurrent()) return;
    target = joinPath(parent, nextCopyName(name, n));
    n += 1;
    if (n > 50) throw new Error("目标名称冲突过多");
   }
   if (!isCurrent()) return;

   markSelfWrite(source);
   markSelfWrite(target);
   markSelfWrite(parent);
   if (mode === "copy") {
    await copyEntry(root, source, target);
   } else {
    await renameEntry(root, source, target);
    if (
     clipboard.value?.path === source &&
     clipboard.value.mode === mode &&
     clipboard.value.isDir === isDir
    ) {
     clipboard.value = null;
    }
   }
   if (!isCurrent()) return;
   await loadChildren(parent);
   await loadChildren(dirname(source));
   if (!isCurrent()) return;
   expanded.value = new Set([...expanded.value, parent]);
   setSelection([target]);
   showNotice("已粘贴");
   return {
    from: source,
    to: target,
    cut: mode === "cut",
    isDir,
    updateImportsOnMove,
   };
  } catch (error) {
   if (!isCurrent()) return;
   showNotice(error instanceof Error ? error.message : String(error), 3200);
  }
 }

 /**
  * 从系统剪贴板粘贴外部文件/目录（Finder / 资源管理器复制后 ⌘/Ctrl+V）。
  * 与 pasteInto 的区别：源在工作区外，多源批量复制、目标走 -copyN 避让；
  * 外部粘贴永远是复制语义，不碰内部剪贴板、不做 import 更新。
  * 返回成功复制的目标路径列表；剪贴板为空或失败返回 null 并 toast 说明。
  */
 async function pasteExternal(parent: string): Promise<string[] | null> {
  const root = rootPath.value;
  if (!root) return null;
  const epoch = workspaceEpoch;
  const isCurrent = () => rootPath.value === root && workspaceEpoch === epoch;
  let sources: string[];
  try {
   sources = await readSystemClipboardFiles();
  } catch (error) {
   if (!isCurrent()) return null;
   showNotice(error instanceof Error ? error.message : String(error), 3200);
   return null;
  }
  if (!sources.length) {
   showNotice("系统剪贴板中没有可粘贴的文件");
   return null;
  }
  const pasted: string[] = [];
  try {
   for (const source of sources) {
    if (!isCurrent()) return null;
    const name = basename(source);
    if (!name) continue;
    let target = joinPath(parent, name);
    let n = 1;
    while (await pathExists(root, target)) {
     if (!isCurrent()) return null;
     target = joinPath(parent, nextCopyName(name, n));
     n += 1;
     if (n > 50) throw new Error("目标名称冲突过多");
    }
    if (!isCurrent()) return null;
    markSelfWrite(target);
    markSelfWrite(parent);
    await copyExternalEntry(root, source, target);
    pasted.push(target);
   }
   if (!isCurrent()) return null;
   await loadChildren(parent);
   if (!isCurrent()) return null;
   expanded.value = new Set([...expanded.value, parent]);
   setSelection(pasted);
   showNotice(
    pasted.length === 1 ? "已粘贴" : "已粘贴 " + pasted.length + " 个项目",
   );
   return pasted;
  } catch (error) {
   if (!isCurrent()) return null;
   if (pasted.length) {
    await loadChildren(parent);
    setSelection(pasted);
   }
   showNotice(error instanceof Error ? error.message : String(error), 3200);
   return pasted.length ? pasted : null;
  }
 }

 async function refreshAffected(from: string, to?: string) {
  await loadChildren(dirname(from));
  if (to) await loadChildren(dirname(to));
 }

 /** 将文件/文件夹移动到目标目录下（保留 basename） */
 async function movePath(
  from: string,
  toParent: string,
  isDir: boolean,
 ): Promise<MovePathResult | null> {
  if (!rootPath.value) return null;
  const root = rootPath.value;
  const epoch = workspaceEpoch;
  const isCurrent = () => rootPath.value === root && workspaceEpoch === epoch;
  // 在文件系统操作前读取并捕获设置，避免移动完成后再读取时发生竞态，
  // 也确保所有未来的移动入口都默认遵循同一份设置。
  const updateImportsOnMove = useSettingsStore().editor.updateImportsOnMove;
  const err = validateMoveTarget(from, toParent, root, isDir);
  if (err) {
   if (normalizeAbsPath(dirname(from)) !== normalizeAbsPath(toParent)) {
    showNotice(err, 3200);
   }
   return null;
  }
  const dest = joinPath(toParent, basename(from));
  if (await pathExists(root, dest)) {
   if (!isCurrent()) return null;
   showNotice(`目标位置已存在「${basename(from)}」`, 3200);
   return null;
  }
  if (!isCurrent()) return null;
  try {
   markSelfWrite(from);
   markSelfWrite(dest);
   markSelfWrite(toParent);
   markSelfWrite(dirname(from));
   await renameEntry(root, from, dest);
   if (!isCurrent()) return null;
   await loadChildren(toParent);
   await loadChildren(dirname(from));
   if (!isCurrent()) return null;
   expanded.value = new Set([...expanded.value, toParent]);
   setSelection([dest]);
   showNotice(`已移动 ${basename(from)}`);
   return { from, to: dest, isDir, updateImportsOnMove };
  } catch (error) {
   if (!isCurrent()) return null;
   showNotice(error instanceof Error ? error.message : String(error), 3200);
   return null;
  }
 }

 function selectPath(path: string | null) {
  setSelection(path ? [path] : []);
 }

 function selectPaths(paths: readonly string[], activePath?: string | null) {
  setSelection(paths, activePath);
 }

 /** 返回当前工作区代际，供跨组件异步操作判断结果是否仍属于当前项目。 */
 function getWorkspaceEpoch(): number {
  return workspaceEpoch;
 }

 function pathPartsUnderRoot(path: string): string[] {
  if (!rootPath.value) return [];
  const root =
   rootPath.value === "/" ? "/" : normalizeAbsPath(rootPath.value);
  if (!isPathWithinRoot(root, path)) return [];
  const normalizedPath = path === "/" ? "/" : normalizeAbsPath(path);
  const relative = normalizedPath.slice(root.length).replace(/^[/\\]+/, "");
  return relative ? relative.split(/[/\\]/) : [];
 }

 async function revealPath(path: string) {
  if (!rootPath.value) return;
  const root = rootPath.value;
  const epoch = workspaceEpoch;
  const parts = pathPartsUnderRoot(path);
  if (!parts.length && path !== root) {
   showNotice("文件不在当前工作区内", 2800);
   return;
  }

  // 定位时清空过滤，避免目标被隐藏
  filter.value = "";
  invalidateLocateSearch();

  let cursor = root;
  if (!childrenMap.value[cursor]) {
   if (!(await loadChildrenSafely(cursor))) return;
   if (rootPath.value !== root || workspaceEpoch !== epoch) return;
  }
  const next = new Set(expanded.value);
  next.add(root);
  for (let i = 0; i < parts.length - 1; i += 1) {
   cursor = joinPath(cursor, parts[i]);
   next.add(cursor);
   if (!childrenMap.value[cursor]) {
    if (!(await loadChildrenSafely(cursor))) return;
    if (rootPath.value !== root || workspaceEpoch !== epoch) return;
   }
  }
  if (rootPath.value !== root || workspaceEpoch !== epoch) return;
  expanded.value = next;
  setSelection([path]);
  revealTarget.value = path;
  revealToken.value += 1;
 }

 async function runLocateSearch(query?: string) {
  const seq = ++locateSearchSeq;
  if (!rootPath.value) {
   locateLoading.value = false;
   locateHits.value = [];
   return;
  }
  const root = rootPath.value;
  const epoch = workspaceEpoch;
  const q = (query ?? filter.value).trim();
  if (q.length < 1) {
   locateHits.value = [];
   locateLoading.value = false;
   return;
  }
  locateLoading.value = true;
  try {
   const result = await searchFiles(root, q, {
    maxResults: 40,
    extraIgnores: extraIgnores.value,
   });
   if (
    seq !== locateSearchSeq ||
    rootPath.value !== root ||
    workspaceEpoch !== epoch
   ) {
    return;
   }
   locateHits.value = result;
  } catch {
   if (
    seq === locateSearchSeq &&
    rootPath.value === root &&
    workspaceEpoch === epoch
   ) {
    locateHits.value = [];
   }
  } finally {
   if (seq === locateSearchSeq) locateLoading.value = false;
  }
 }

 function scheduleLocateSearch(query?: string) {
  window.clearTimeout(locateTimer);
  locateTimer = window.setTimeout(() => {
   locateTimer = undefined;
   void runLocateSearch(query);
  }, 220);
 }

 function invalidateLocateSearch() {
  window.clearTimeout(locateTimer);
  locateTimer = undefined;
  locateSearchSeq += 1;
  locateLoading.value = false;
  locateHits.value = [];
 }

 function setFilter(value: string) {
  filter.value = value;
  invalidateLocateSearch();
  if (!value.trim()) {
   return;
  }
  scheduleLocateSearch(value);
 }

 function clearFilter() {
  filter.value = "";
  invalidateLocateSearch();
 }

 function collapseAll() {
  if (!rootPath.value) return;
  expanded.value = new Set([rootPath.value]);
 }

 function removeRecentFolder(path: string) {
  recentFolders.value = removeRecentFolderStorage(path);
 }

 function clearRecentFolders() {
  recentFolders.value = clearRecentFoldersStorage();
 }

 // ==================== macOS Dock 菜单同步 ====================

 /**
  * 同步最新状态给 macOS Dock 菜单。
  * - `recent` 来自 localStorage，最多 8 条
  * - `currentFile` 是 main 窗口当前活动 tab 的路径
  *
  * 调用方：openFolder / editor activePath 变化 / restoreLastFolder。
  * 非 macOS 平台 Rust 端是 no-op，调用零成本。
  */
 /**
  * 同步最新状态给 macOS Dock 菜单。
  * - `recent` 来自 localStorage，最多 8 条
  * - `currentFile` 是 main 窗口当前活动 tab 的路径（由 store 内部读，
  *   调用方无需关心，避免调用时 activePath 还没更新的竞态）
  *
  * 调用方：openFolder / editor activePath 变化 / restoreLastFolder。
  * 非 macOS 平台 Rust 端是 no-op，调用零成本。
  */
 async function syncDockMenu() {
  const editor = useEditorStore();
  try {
   const { invoke } = await import("@tauri-apps/api/core");
   await invoke("set_dock_menu", {
    state: {
     recent: recentFolders.value.slice(0, 8),
     currentFile: editor.activePath,
    },
   });
  } catch {
   // 非桌面壳（vite 预览）静默忽略
  }
 }

 /** 同步窗口原生标题（`Prism Code — 项目名`，与 openFolderInNewWindow 格式一致）。
  *  Overlay 标题栏隐藏 native title，但系统层仍读取：Mission Control / ⌘Tab /
  *  窗口菜单 / 系统 Tab 合并浮层。不更新则多窗口时名称恒为默认 "Prism Code"。 */
 async function syncWindowTitle(root: string) {
  const state = { root, at: new Date().toISOString() };
  try {
   const { getCurrentWindow } = await import("@tauri-apps/api/window");
   const prefix = import.meta.env.DEV ? "Prism Code Dev" : "Prism Code";
   await getCurrentWindow().setTitle(`${prefix} — ${basename(root)}`);
   Object.assign(state, { ok: true });
  } catch (e) {
   Object.assign(state, { ok: false, error: String(e) });
  }
  if (import.meta.env.DEV) {
   (window as unknown as Record<string, unknown>).__titleSync = state;
   console.log("[syncWindowTitle]", state);
  }
 }

 // 窗口原生标题随 rootPath 同步：任何设置 rootPath 的路径（启动恢复 / 手动打开 /
 // 新窗口 boot / Dock 菜单）都触发，比在 openFolder 内 fire-and-forget 更可靠。
 watchState(rootPath, (root) => {
  if (root) void syncWindowTitle(root);
 });

 return {
  rootPath,
  rootName,
  toasts,
  filter,
  selectedPath,
  selectedPaths,
  childrenMap,
  expanded,
  recentFolders,
  clipboard,
  extraIgnores,
  flatTree,
  revealToken,
  revealTarget,
  locateHits,
  locateLoading,
  refreshing,
  watchActive,
  showNotice,
  dismissNotice,
  openFolder,
  restoreLastFolder,
  toggleExpand,
  refreshTree,
  refreshFromDisk,
  markSelfWrite,
  startWatch,
  stopWatch,
  createIn,
  renamePath,
  removePath,
  removePaths,
  setClipboard,
  pasteInto,
  pasteExternal,
  movePath,
  selectPath,
  selectPaths,
  getWorkspaceEpoch,
  revealPath,
  loadChildren,
  runLocateSearch,
  scheduleLocateSearch,
  setFilter,
  clearFilter,
  collapseAll,
  removeRecentFolder,
  clearRecentFolders,
  syncDockMenu,
 };
});
