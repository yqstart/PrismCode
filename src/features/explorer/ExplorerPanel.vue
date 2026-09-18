<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Crosshair,
  FilePlus,
  FileText,
  FolderOpen,
  FolderPlus,
  FolderInput,
  RefreshCw,
  X,
} from "lucide-vue-next";
import { open } from "@tauri-apps/plugin-dialog";
import { storeToRefs } from "pinia";
import { writeClipboard } from "@/shared/clipboard";
import FileTypeIcon from "@/shared/FileTypeIcon.vue";
import {
  basename,
  dirname,
  normalizeAbsPath,
  relativeToRoot,
  toAbsolutePath,
} from "@/shared/fs";
import {
  applyImportPatches,
  scanImportReferences,
  validateMoveTarget,
} from "@/shared/importReferences";
import { showMoveReferencesDialog } from "@/shared/moveReferencesDialog";
import { openFolderInNewWindow } from "@/shared/openWorkspace";
import { formatShortcut } from "@/shared/platform";
import { revealInOsExplorer } from "@/shared/revealInOs";
import {
  getContextSelectionPaths,
  getPathRange,
} from "@/features/explorer/selection";
import { useI18n } from "@/i18n";
import { useEditorStore } from "@/stores/editor";
import { aggregateDirDirtyCounts } from "@/stores/gitDirtyAggregate";
import { useGitStore } from "@/stores/git";
import { useSessionsStore } from "@/stores/sessions";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore, type MovePathResult } from "@/stores/workspace";

const { t } = useI18n();
const workspace = useWorkspaceStore();
const editor = useEditorStore();
const git = useGitStore();
const sessions = useSessionsStore();
const settings = useSettingsStore();
const {
  rootPath,
  rootName,
  lightMode,
  selectedPath,
  selectedPaths,
  flatTree,
  recentFolders,
  clipboard,
  childrenMap,
  revealToken,
  revealTarget,
  refreshing,
  extraIgnores,
} = storeToRefs(workspace);
const { activePath } = storeToRefs(editor);

const menu = ref<{
  x: number;
  y: number;
  path: string;
  isDir: boolean;
  isRoot: boolean;
  paths: string[];
} | null>(null);
const menuRef = ref<HTMLElement | null>(null);
const treeBodyRef = ref<HTMLElement | null>(null);
/** 面板根元素：判定文本选区是否落在树外（见 hasSelectionOutsidePanel） */
const panelRef = ref<HTMLElement | null>(null);
const projectMenuOpen = ref(false);
/** Teleport 到 body 后的浮层位置（由 toggleProjectMenu 在 button 真实坐标计算） */
const projectMenuPos = ref<{ top: number; left: number } | null>(null);
const titleBtnRef = ref<HTMLElement | null>(null);
const pendingOpenPath = ref<string | null>(null);
const openingMode = ref(false);
/** Shift 范围选择的锚点；普通点击会重新设置，范围点击不会移动锚点。 */
const selectionAnchorPath = ref<string | null>(null);

const dirtySet = computed(() => editor.dirtyPaths);
/** git 状态按绝对路径索引，供 row 模板 O(1) 取用 */
const gitStatusByPath = computed(() => {
  const map = new Map<string, ReturnType<typeof git.statusEntry>>();
  for (const node of flatTree.value) {
    if (node.isDir) continue;
    const entry = git.statusEntry(node.path);
    if (entry) map.set(node.path, entry);
  }
  return map;
});
/** entries 按目录聚合（仅随 git 状态刷新重算，不随树的展开/折叠变化） */
const gitDirDirtyAgg = computed(() =>
  aggregateDirDirtyCounts(git.snapshot.entries),
);
/** 目录 → { count, firstAbs }，key 为节点绝对路径；折叠目录据此渲染改动数量徽章 */
const gitDirtyDirMap = computed(() => {
  const map = new Map<string, { count: number; firstAbs: string }>();
  const root = rootPath.value;
  if (!root) return map;
  const byDir = gitDirDirtyAgg.value;
  for (const node of flatTree.value) {
    if (!node.isDir) continue;
    const rel = relativeToRoot(root, node.path).replace(/\\/g, "/");
    const rec = byDir.get(rel);
    if (rec) {
      map.set(node.path, {
        count: rec.count,
        firstAbs: toAbsolutePath(root, rec.first),
      });
    }
  }
  return map;
});
const canLocate = computed(() => Boolean(rootPath.value && activePath.value));
const menuPaths = computed(() => menu.value?.paths ?? []);
const isRootTarget = computed(
  () =>
    Boolean(menu.value?.isRoot) ||
    menuPaths.value.includes(rootPath.value ?? ""),
);
const isFileTarget = computed(
  () =>
    Boolean(menu.value) &&
    menuPaths.value.length === 1 &&
    !menu.value!.isDir &&
    !menu.value!.isRoot,
);
const deleteMenuLabel = computed(() =>
  menuPaths.value.length > 1
    ? t("explorer.deleteSelected", { count: menuPaths.value.length })
    : t("explorer.delete"),
);
const locateFileTitle = computed(() =>
  t("explorer.revealActiveTitle", { shortcut: formatShortcut("alt", "F1") }),
);
const panelTitle = computed(() =>
  rootPath.value ? rootName.value : t("explorer.selectProject"),
);
const switchCandidates = computed(() =>
  recentFolders.value.filter((p) => p !== rootPath.value),
);

/** Tauri macOS WKWebView 的 HTML5 DnD 不可靠，改用 pointer 拖拽 */
const DRAG_THRESHOLD_PX = 5;
/** 拖拽边缘自动滚动：指针进入容器顶部/底部该距离内开始滚动 */
const DRAG_SCROLL_EDGE_PX = 32;
const DRAG_SCROLL_MIN_PX = 2;
const DRAG_SCROLL_MAX_PX = 12;
/** 指针超出容器上下边界仍可滚动的最大距离 */
const DRAG_SCROLL_OUTER_PX = 48;
/** 悬停折叠目录自动展开的延迟 */
const DRAG_HOVER_EXPAND_MS = 700;
const dragSource = ref<{ path: string; isDir: boolean } | null>(null);
const dropHoverPath = ref<string | null>(null);
const dropValid = ref(false);
const moving = ref(false);
const deleting = ref(false);
let suppressRowClick = false;

type PointerDragSession = {
  pointerId: number;
  startX: number;
  startY: number;
  source: { path: string; isDir: boolean };
  started: boolean;
};

type DropTarget = { path: string; isDir: boolean; expanded?: boolean };

let pointerDrag: PointerDragSession | null = null;
let dragScrollRaf: number | null = null;
let lastDragPoint: { x: number; y: number } | null = null;
let hoverExpandTimer: number | null = null;
let hoverExpandPath: string | null = null;

function resolveDropParent(targetPath: string, targetIsDir: boolean): string {
  return targetIsDir ? targetPath : dirname(targetPath);
}

function canDropOn(
  source: { path: string; isDir: boolean },
  targetPath: string,
  targetIsDir: boolean,
): boolean {
  if (!rootPath.value) return false;
  const toParent = resolveDropParent(targetPath, targetIsDir);
  if (normalizeAbsPath(dirname(source.path)) === normalizeAbsPath(toParent)) {
    return false;
  }
  return (
    validateMoveTarget(source.path, toParent, rootPath.value, source.isDir) ===
    null
  );
}

function lookupTreeNode(path: string): DropTarget | null {
  const node = flatTree.value.find((n) => n.path === path);
  if (!node) return null;
  return { path: node.path, isDir: node.isDir, expanded: node.expanded };
}

function resolveDropTargetAt(
  clientX: number,
  clientY: number,
): DropTarget | null {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return null;
  const row = el.closest("[data-tree-path]") as HTMLElement | null;
  if (row?.dataset.treePath) {
    return lookupTreeNode(row.dataset.treePath);
  }
  // 落到树空白处 → 工作区根目录
  if (el.closest(".tree") && rootPath.value) {
    return { path: rootPath.value, isDir: true, expanded: true };
  }
  return null;
}

function updateDropHover(
  clientX: number,
  clientY: number,
): DropTarget | null {
  if (!dragSource.value) {
    dropHoverPath.value = null;
    dropValid.value = false;
    return null;
  }
  const target = resolveDropTargetAt(clientX, clientY);
  if (!target || target.path === dragSource.value.path) {
    dropHoverPath.value = null;
    dropValid.value = false;
    return null;
  }
  dropHoverPath.value = target.path;
  dropValid.value = canDropOn(dragSource.value, target.path, target.isDir);
  return target;
}

/** 拖拽悬停折叠目录：延迟自动展开，松手可直接放入其子目录 */
function scheduleHoverExpand(target: DropTarget | null) {
  const foldPath =
    target &&
    target.isDir &&
    !target.expanded &&
    target.path !== dragSource.value?.path
      ? target.path
      : null;
  if (foldPath === hoverExpandPath) return;
  clearHoverExpand();
  hoverExpandPath = foldPath;
  if (!foldPath) return;
  hoverExpandTimer = window.setTimeout(() => {
    hoverExpandTimer = null;
    hoverExpandPath = null;
    if (!lastDragPoint || !dragSource.value) return;
    // 触发时按指针当前位置重算：滚动可能已把目标移走
    const current = resolveDropTargetAt(lastDragPoint.x, lastDragPoint.y);
    if (
      current &&
      current.path === foldPath &&
      current.isDir &&
      !current.expanded
    ) {
      void workspace.toggleExpand(foldPath);
    }
  }, DRAG_HOVER_EXPAND_MS);
}

function clearHoverExpand() {
  if (hoverExpandTimer !== null) {
    window.clearTimeout(hoverExpandTimer);
    hoverExpandTimer = null;
  }
  hoverExpandPath = null;
}

/** 拖拽边缘自动滚动：指针贴近容器顶部/底部时滚动树，露出视口外的目录 */
function startDragScrollLoop() {
  if (dragScrollRaf !== null) return;
  dragScrollRaf = requestAnimationFrame(dragScrollStep);
}

function stopDragScrollLoop() {
  if (dragScrollRaf !== null) {
    cancelAnimationFrame(dragScrollRaf);
    dragScrollRaf = null;
  }
}

function dragScrollStep() {
  dragScrollRaf = null;
  const container = treeBodyRef.value;
  if (
    !pointerDrag?.started ||
    !dragSource.value ||
    !container ||
    !lastDragPoint
  ) {
    return;
  }
  const rect = container.getBoundingClientRect();
  const y = lastDragPoint.y;
  let delta = 0;
  if (y < rect.top + DRAG_SCROLL_EDGE_PX && y > rect.top - DRAG_SCROLL_OUTER_PX) {
    const proximity =
      y <= rect.top ? 1 : 1 - (y - rect.top) / DRAG_SCROLL_EDGE_PX;
    delta = -(
      DRAG_SCROLL_MIN_PX +
      proximity * (DRAG_SCROLL_MAX_PX - DRAG_SCROLL_MIN_PX)
    );
  } else if (
    y > rect.bottom - DRAG_SCROLL_EDGE_PX &&
    y < rect.bottom + DRAG_SCROLL_OUTER_PX
  ) {
    const proximity =
      y >= rect.bottom ? 1 : 1 - (rect.bottom - y) / DRAG_SCROLL_EDGE_PX;
    delta =
      DRAG_SCROLL_MIN_PX +
      proximity * (DRAG_SCROLL_MAX_PX - DRAG_SCROLL_MIN_PX);
  }
  if (delta !== 0) {
    container.scrollTop += delta;
    scheduleHoverExpand(
      updateDropHover(lastDragPoint.x, lastDragPoint.y),
    );
  }
  dragScrollRaf = requestAnimationFrame(dragScrollStep);
}

function clearPointerDragListeners() {
  window.removeEventListener("pointermove", onWindowPointerMove);
  window.removeEventListener("pointerup", onWindowPointerUp);
  window.removeEventListener("pointercancel", onWindowPointerUp);
}

function resetDragChrome() {
  stopDragScrollLoop();
  clearHoverExpand();
  lastDragPoint = null;
  dragSource.value = null;
  dropHoverPath.value = null;
  dropValid.value = false;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

function onRowPointerDown(event: PointerEvent, path: string, isDir: boolean) {
  if (event.button !== 0 || !rootPath.value || moving.value) return;
  pointerDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    source: { path, isDir },
    started: false,
  };
  window.addEventListener("pointermove", onWindowPointerMove);
  window.addEventListener("pointerup", onWindowPointerUp);
  window.addEventListener("pointercancel", onWindowPointerUp);
}

function onWindowPointerMove(event: PointerEvent) {
  if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
  const dx = event.clientX - pointerDrag.startX;
  const dy = event.clientY - pointerDrag.startY;
  if (!pointerDrag.started) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    pointerDrag.started = true;
    dragSource.value = pointerDrag.source;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
  }
  event.preventDefault();
  lastDragPoint = { x: event.clientX, y: event.clientY };
  startDragScrollLoop();
  scheduleHoverExpand(updateDropHover(event.clientX, event.clientY));
}

async function onWindowPointerUp(event: PointerEvent) {
  if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
  const session = pointerDrag;
  pointerDrag = null;
  clearPointerDragListeners();
  stopDragScrollLoop();
  clearHoverExpand();
  lastDragPoint = null;

  if (!session.started) {
    resetDragChrome();
    return;
  }

  suppressRowClick = true;
  window.setTimeout(() => {
    suppressRowClick = false;
  }, 0);

  const source = session.source;
  const target = resolveDropTargetAt(event.clientX, event.clientY);
  const valid =
    Boolean(target) &&
    target!.path !== source.path &&
    canDropOn(source, target!.path, target!.isDir);

  resetDragChrome();
  if (!valid || !target || moving.value) return;

  const toParent = resolveDropParent(target.path, target.isDir);
  moving.value = true;
  try {
    const result = await workspace.movePath(
      source.path,
      toParent,
      source.isDir,
    );
    if (result) await afterMove(result);
  } finally {
    moving.value = false;
  }
}

async function afterMove(result: MovePathResult) {
  const root = rootPath.value;
  const epoch = workspace.getWorkspaceEpoch();
  const isCurrent = () =>
    rootPath.value === root && workspace.getWorkspaceEpoch() === epoch;
  if (!root || !isCurrent()) return;

  if (result.isDir) {
    editor.renameTabsUnderPrefix(result.from, result.to);
  } else {
    editor.renameTabPath(result.from, result.to);
  }
  void git.scheduleRefresh();

  // movePath 在文件系统操作前捕获本次移动的设置，避免后续异步流程读取到新配置。
  const mode = result.updateImportsOnMove;
  if (mode === "never" || !isCurrent()) return;

  const patches = await scanImportReferences(
    root,
    result.from,
    result.to,
    result.isDir,
    extraIgnores.value,
  );
  if (!isCurrent() || !patches.length) return;

  let toApply = patches;
  if (mode === "prompt") {
    const picked = await showMoveReferencesDialog({
      title: t("moveReferences.title"),
      hint: t("moveReferences.hint"),
      confirmText: t("moveReferences.confirm"),
      cancelText: t("moveReferences.cancel"),
      patches,
    });
    if (!isCurrent() || !picked?.length) return;
    toApply = picked;
  }

  const count = await applyImportPatches(
    root,
    toApply,
    (path, content) => editor.syncFromDisk(path, content),
    (path) => workspace.markSelfWrite(path),
  );
  if (!isCurrent()) return;
  if (count > 0) {
    workspace.showNotice(t("moveReferences.applied", { count }));
    void git.scheduleRefresh();
  }
}

onBeforeUnmount(() => {
  clearPointerDragListeners();
  pointerDrag = null;
  resetDragChrome();
  document.removeEventListener("mousedown", onDocMouseDown, true);
  window.removeEventListener("keydown", onExplorerKeydown);
});

/** 弹层全局关闭：点 .menu（文件树右键菜单）或 .project-menu 内部不关；其它位置关。
 *  capture 阶段：早于其他监听器，避免 stopPropagation 抢走。 */
function onDocMouseDown(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  if (target.closest(".menu, .project-menu")) return;
  if (menu.value || projectMenuOpen.value) {
    menu.value = null;
    projectMenuOpen.value = false;
  }
}

onMounted(async () => {
  document.addEventListener("mousedown", onDocMouseDown, true);
  window.addEventListener("keydown", onExplorerKeydown);
  if (rootPath.value) void git.scheduleRefresh();
  if (revealTarget.value) {
    await nextTick();
    scrollRowIntoView(revealTarget.value);
  }
});

/** 工具栏新建：优先落在选中目录，否则落在选中文件的父目录 / 根目录 */
function resolveCreateParent(): string | null {
  const selected = selectedPath.value;
  if (!selected || selected === rootPath.value) return rootPath.value;

  const inTree = flatTree.value.find((n) => n.path === selected);
  if (inTree?.isDir) return selected;
  if (selected in childrenMap.value) return selected;
  return dirname(selected);
}

async function createFromToolbar(isDir: boolean) {
  const parent = resolveCreateParent();
  if (!parent) return;
  const created = await workspace.createIn(parent, isDir);
  if (created && !isDir) await editor.openFile(created);
}

function closeProjectMenu() {
  projectMenuOpen.value = false;
  projectMenuPos.value = null;
}

function toggleProjectMenu() {
  if (projectMenuOpen.value) {
    closeProjectMenu();
    return;
  }
  // 浮层在父级 overflow:hidden 容器内会被裁切，所以用 Teleport 到 body 渲染
  // 位置取 button 在视口中的真实坐标
  const btn = titleBtnRef.value;
  if (btn) {
    const r = btn.getBoundingClientRect();
    projectMenuPos.value = { top: r.bottom + 4, left: r.left };
  }
  projectMenuOpen.value = true;
  menu.value = null;
}

function requestOpenPath(path: string) {
  closeProjectMenu();
  pendingOpenPath.value = path;
}

async function onOpenNewProject() {
  closeProjectMenu();
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("explorer.openNewProjectDialog"),
    });
    if (!selected || Array.isArray(selected)) return;
    pendingOpenPath.value = selected;
  } catch (error) {
    workspace.showNotice(
      error instanceof Error ? error.message : String(error),
      3200,
    );
  }
}

async function confirmOpenMode(mode: "current" | "new") {
  const path = pendingOpenPath.value;
  if (!path || openingMode.value) return;
  openingMode.value = true;
  try {
    if (mode === "new") {
      await openFolderInNewWindow(path);
      workspace.showNotice(
        t("explorer.openedInNewWindow", { name: basename(path) }),
      );
    } else {
      await workspace.openFolder(path);
    }
    pendingOpenPath.value = null;
  } catch (error) {
    workspace.showNotice(
      error instanceof Error ? error.message : String(error),
      3200,
    );
  } finally {
    openingMode.value = false;
  }
}

function cancelOpenMode() {
  if (openingMode.value) return;
  pendingOpenPath.value = null;
}

function scrollRowIntoView(path: string) {
  const root = treeBodyRef.value;
  if (!root) return;
  const rows = root.querySelectorAll<HTMLElement>("[data-tree-path]");
  for (const row of rows) {
    if (row.dataset.treePath === path) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.classList.add("flash");
      window.setTimeout(() => row.classList.remove("flash"), 900);
      break;
    }
  }
}

watch([revealToken, revealTarget], async ([, path]) => {
  if (!path) return;
  await nextTick();
  scrollRowIntoView(path);
});

watch(activePath, (path) => {
  if (!path || !rootPath.value) return;
  // 编辑区切换标签时自动在树中高亮定位
  if (settings.layout.activePanel !== "explorer") return;
  if (settings.layout.sidebarCollapsed) return;
  void workspace.revealPath(path);
});

function closeMenu() {
  menu.value = null;
  closeProjectMenu();
}

async function onOpen() {
  await onOpenNewProject();
}

async function onOpenRecent(path: string) {
  requestOpenPath(path);
}

function removeRecent(path: string, event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  workspace.removeRecentFolder(path);
}

function clearAllRecent(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  workspace.clearRecentFolders();
}

async function onRowClick(event: MouseEvent, path: string, isDir: boolean) {
  if (suppressRowClick) return;

  if (
    event.shiftKey &&
    selectionAnchorPath.value &&
    selectedPaths.value.includes(selectionAnchorPath.value)
  ) {
    workspace.selectPaths(
      getPathRange(
        flatTree.value.map((node) => node.path),
        selectionAnchorPath.value,
        path,
      ),
      path,
    );
    return;
  }

  selectionAnchorPath.value = path;
  workspace.selectPath(path);
  if (isDir) {
    await workspace.toggleExpand(path);
    return;
  }
  await editor.openFile(path);
}

async function onContext(event: MouseEvent, path: string, isDir: boolean) {
  event.preventDefault();
  event.stopPropagation();
  const wasSelected = selectedPaths.value.includes(path);
  const paths = getContextSelectionPaths(selectedPaths.value, path);
  // 右键已选中的节点保留当前集合；右键未选中的节点才切换为单选。
  if (!wasSelected) {
    selectionAnchorPath.value = path;
    workspace.selectPath(path);
  }
  // 先用估算定位占位，渲染后再按真实尺寸校正：
  // 估算高度（320）小于实际渲染高度，直接按估算 clamp 会让底部越出窗口被裁掉
  const estWidth = 200;
  const estHeight = 320;
  const x = Math.min(event.clientX, window.innerWidth - estWidth - 8);
  const y = Math.min(event.clientY, window.innerHeight - estHeight - 8);
  menu.value = {
    x: Math.max(8, x),
    y: Math.max(8, y),
    path,
    isDir,
    isRoot: Boolean(rootPath.value && path === rootPath.value),
    paths,
  };
  await nextTick();
  if (!menu.value) return;
  const el = menuRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  if (rect.right <= window.innerWidth && rect.bottom <= window.innerHeight)
    return;
  menu.value = {
    ...menu.value,
    // 越界时反向回拉，保证菜单完整落在窗口内（含底部按钮可见可点）
    x: Math.max(8, Math.min(menu.value.x, window.innerWidth - rect.width - 8)),
    y: Math.max(
      8,
      Math.min(menu.value.y, window.innerHeight - rect.height - 8),
    ),
  };
}

/** 点击目录改动徽章：自动逐级展开（含懒加载目录）并高亮定位到该目录下第一个改动文件 */
async function revealDirFirstChanged(node: { path: string }) {
  const rec = gitDirtyDirMap.value.get(node.path);
  if (rec) await workspace.revealPath(rec.firstAbs);
}

async function locateActiveFile() {
  if (!activePath.value) {
    workspace.showNotice(t("notice.noActiveFile"));
    return;
  }
  settings.setActivePanel("explorer");
  settings.setSidebarCollapsed(false);
  await workspace.revealPath(activePath.value);
  workspace.showNotice(
    t("notice.revealed", { name: basename(activePath.value) }),
  );
}

async function runMenu(action: string) {
  if (!menu.value || !rootPath.value) return;
  const { path, isDir, isRoot, paths } = menu.value;
  const parent = isDir ? path : dirname(path);
  closeMenu();

  try {
    if (action === "new-file") {
      const created = await workspace.createIn(parent, false);
      if (created) await editor.openFile(created);
      return;
    }
    if (action === "new-folder") {
      await workspace.createIn(parent, true);
      return;
    }
    if (action === "rename") {
      if (isRoot) {
        workspace.showNotice(t("explorer.cannotRenameRoot"));
        return;
      }
      const result = await workspace.renamePath(path);
      if (result) {
        // 目录重命名须连带更新其下已打开标签的路径：
        // 只改单文件路径的话，目录内已打开文件保存时仍写回旧路径
        // 注意：closeMenu() 已置 menu.value = null，此处必须用解构出的 isDir
        if (isDir) {
          editor.renameTabsUnderPrefix(result.from, result.to);
        } else {
          editor.renameTabPath(result.from, result.to);
        }
      }
      return;
    }
    if (action === "delete") {
      if (isRoot || paths.includes(rootPath.value)) {
        workspace.showNotice(t("explorer.cannotDeleteRoot"));
        return;
      }
      await deleteSelectedPaths(paths.length ? paths : [path]);
      return;
    }
    if (action === "copy") {
      workspace.setClipboard("copy", path, isDir);
      return;
    }
    if (action === "cut") {
      if (isRoot) {
        workspace.showNotice(t("explorer.cannotCutRoot"));
        return;
      }
      workspace.setClipboard("cut", path, isDir);
      return;
    }
    if (action === "paste") {
      // 右键菜单粘贴同样走统一入口：内部剪贴板优先，为空读系统剪贴板。
      // 剪切粘贴属于「移动文件」，走统一的移动后处理（含标签前缀更新与
      // 按 always/prompt/never 设置更新相对 import）。
      await pasteAtParent(parent);
      return;
    }
    if (action === "copy-abs-path") {
      await writeClipboard(path);
      workspace.showNotice(t("explorer.copiedAbsPath"));
      return;
    }
    if (action === "copy-rel-path") {
      const rel = relativeToRoot(rootPath.value, path);
      await writeClipboard(rel);
      workspace.showNotice(t("explorer.copiedRelPath"));
      return;
    }
    if (action === "copy-file-name") {
      await writeClipboard(basename(path));
      workspace.showNotice(t("explorer.copiedFileName"));
      return;
    }
    if (action === "open-in-terminal") {
      // 目录取该目录，文件取其父目录；打开面板并在目标目录落一个终端
      const target = isDir ? path : dirname(path);
      sessions.openTerminalAt(target);
      return;
    }
    if (action === "reveal-in-os") {
      await revealInOsExplorer(path, (message, ms) =>
        workspace.showNotice(message, ms),
      );
      return;
    }
  } catch (error) {
    workspace.showNotice(
      error instanceof Error ? error.message : String(error),
      3200,
    );
  }
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable ||
    Boolean(target.closest(".cm-content, .cm-editor, .xterm"))
  );
}

function isExplorerTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true;
  // 全局弹层（设置/快速打开/查找/确认框等）统一用 .overlay 容器，
  // 弹层内按 Delete 不得冒泡删除资源树文件。
  if (target.closest(".overlay")) return false;
  return target === document.body || Boolean(target.closest(".panel"));
}

/**
 * 是否存在落在资源树面板之外的「选中文本」。
 *
 * MD 预览 / Diff / Git Log 这些只读区域支持选中复制，但它们不可聚焦：选中后
 * activeElement 落在 body，isExplorerTarget 会把它判成「焦点在树内」，⌘C/⌘X
 * 于是被抢去复制文件——弹「已复制」，系统剪贴板里却什么都没有。只要用户手上
 * 有树外选区，复制/剪切就必须交回原生处理。
 * 折叠选区不算（刚点过预览、只留光标时仍按树内处理，⌘C 继续复制文件）。
 */
function hasSelectionOutsidePanel(): boolean {
  const selection = window.getSelection();
  const panel = panelRef.value;
  if (!panel || !selection || selection.isCollapsed) return false;
  return Boolean(selection.anchorNode) && !panel.contains(selection.anchorNode);
}

async function deleteSelectedPaths(
  paths: readonly string[] = selectedPaths.value,
) {
  if (deleting.value || !paths.length || !rootPath.value) return;
  deleting.value = true;
  try {
    const deletedPaths = await workspace.removePaths(paths);
    for (const deletedPath of deletedPaths ?? []) {
      // 只有实际删除成功的路径才关闭对应标签。
      editor.closeTabsUnder(deletedPath);
    }
  } finally {
    deleting.value = false;
  }
}

/**
 * 粘贴落点：选中目录进该目录，选中文件进其父目录，无选中进工作区根。
 * 与工具栏新建（resolveCreateParent）同规则，快捷键与右键菜单共用。
 */
function resolvePasteParent(): string | null {
  const selected = selectedPath.value;
  if (!selected || selected === rootPath.value) return rootPath.value;
  const inTree = flatTree.value.find((n) => n.path === selected);
  if (inTree?.isDir) return selected;
  if (selected in childrenMap.value) return selected;
  return dirname(selected);
}

/**
 * 统一粘贴：内部剪贴板优先（复制/剪切语义，走 import 更新），
 * 为空时读系统剪贴板粘贴外部文件。右键菜单与 ⌘/Ctrl+V 共用。
 */
async function pasteAtParent(parent: string) {
  if (clipboard.value) {
    const result = await workspace.pasteInto(parent);
    if (result?.cut) await afterMove(result);
    return;
  }
  await workspace.pasteExternal(parent);
}

/** 复制/剪切落点：焦点路径即操作对象（右键菜单 setClipboard 单路径同语义）。 */
function copyOrCutSelected(mode: "copy" | "cut") {
  const selected = selectedPath.value;
  if (!selected || !rootPath.value) return;
  const inTree = flatTree.value.find((n) => n.path === selected);
  const isDir = inTree?.isDir ?? selected in childrenMap.value;
  if (mode === "cut" && selected === rootPath.value) {
    workspace.showNotice(t("explorer.cannotCutRoot"));
    return;
  }
  workspace.setClipboard(mode, selected, isDir);
}

function onExplorerKeydown(event: KeyboardEvent) {
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  const isCopyOrCut = key === "c" || key === "x";
  // 资源树复制/剪切/粘贴：⌘/Ctrl+C/X/V。文本输入区与弹层内不拦截，
  // 让原生编辑行为优先；只有 activePanel 为 explorer 且焦点在树内才接管。
  // 树外有选中文本（MD 预览 / Diff / Git Log 等）时 ⌘C/⌘X 同样不拦截。
  if (
    mod &&
    !event.altKey &&
    !event.shiftKey &&
    (isCopyOrCut || key === "v") &&
    settings.layout.activePanel === "explorer" &&
    isExplorerTarget(event.target) &&
    !isTextEditingTarget(event.target) &&
    !(isCopyOrCut && hasSelectionOutsidePanel())
  ) {
    if (event.defaultPrevented || !rootPath.value) return;
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
    if (isCopyOrCut) {
      if (!selectedPath.value) return;
      copyOrCutSelected(key === "c" ? "copy" : "cut");
      return;
    }
    const parent = resolvePasteParent();
    if (!parent) return;
    void pasteAtParent(parent);
    return;
  }
  if (
    event.defaultPrevented ||
    (event.key !== "Delete" && event.code !== "Delete") ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    settings.layout.activePanel !== "explorer" ||
    !isExplorerTarget(event.target) ||
    isTextEditingTarget(event.target)
  ) {
    return;
  }
  if (!rootPath.value || !selectedPaths.value.length || deleting.value) return;
  event.preventDefault();
  event.stopPropagation();
  closeMenu();
  void deleteSelectedPaths();
}

defineExpose({ locateActiveFile });
</script>

<template>
  <div ref="panelRef" class="panel" @click="closeMenu">
    <header class="header">
      <div class="title-wrap">
        <button
          ref="titleBtnRef"
          type="button"
          class="title-btn"
          :title="rootPath ?? t('explorer.selectOrSwitch')"
          @click.stop="toggleProjectMenu"
        >
          <span class="title">{{ panelTitle }}</span>
          <ChevronDown :size="14" class="title-caret" />
        </button>
      </div>
      <div v-if="rootPath" class="header-actions">
        <button
          type="button"
          class="icon-btn"
          :title="t('explorer.newFile')"
          @click.stop="createFromToolbar(false)"
        >
          <FilePlus :size="15" />
        </button>
        <button
          type="button"
          class="icon-btn"
          :title="t('explorer.newFolder')"
          @click.stop="createFromToolbar(true)"
        >
          <FolderPlus :size="15" />
        </button>
        <button
          type="button"
          class="icon-btn"
          :title="t('explorer.refreshAll')"
          :disabled="refreshing"
          @click.stop="workspace.refreshFromDisk()"
        >
          <RefreshCw :size="15" :class="{ spin: refreshing }" />
        </button>
        <button
          type="button"
          class="icon-btn"
          :title="locateFileTitle"
          :disabled="!canLocate"
          @click.stop="locateActiveFile"
        >
          <Crosshair :size="15" />
        </button>
        <button
          type="button"
          class="icon-btn"
          :title="t('explorer.collapseAllFolders')"
          @click.stop="workspace.collapseAll()"
        >
          <ChevronsDownUp :size="15" />
        </button>
      </div>
    </header>

    <Transition name="dialog">
      <div
        v-if="pendingOpenPath"
        class="mode-overlay"
        @mousedown.self="cancelOpenMode"
      >
        <div class="mode-card" @click.stop>
          <p class="mode-title">{{ t("explorer.openProject") }}</p>
          <p class="mode-path" :title="pendingOpenPath">
            {{ basename(pendingOpenPath) }}
          </p>
          <button
            type="button"
            class="mode-btn"
            :disabled="openingMode"
            @click="confirmOpenMode('current')"
          >
            {{ t("explorer.openInThisWindow") }}
          </button>
          <button
            type="button"
            class="mode-btn accent"
            :disabled="openingMode"
            @click="confirmOpenMode('new')"
          >
            {{ t("explorer.openInNewWindow") }}
          </button>
          <button
            type="button"
            class="mode-cancel"
            :disabled="openingMode"
            @click="cancelOpenMode"
          >
            {{ t("common.cancel") }}
          </button>
        </div>
      </div>
    </Transition>

    <div ref="treeBodyRef" class="body">
      <template v-if="!rootPath">
        <div class="empty">
          <FileText v-if="lightMode" :size="28" :stroke-width="1.5" class="icon" />
          <FolderOpen v-else :size="28" :stroke-width="1.5" class="icon" />
          <p class="name">
            {{ lightMode ? t("explorer.lightTitle") : rootName }}
          </p>
          <p class="hint">
            {{ lightMode ? t("explorer.lightHint") : t("explorer.emptyHint") }}
          </p>
          <button class="cta" type="button" @click="onOpen">
            {{ t("explorer.openFolder") }}
          </button>
          <div v-if="recentFolders.length" class="recent">
            <div class="recent-head">
              <p class="recent-title">{{ t("explorer.recentOpened") }}</p>
              <button
                type="button"
                class="recent-clear"
                :title="t('explorer.clearRecentProjects')"
                @click="clearAllRecent"
              >
                {{ t("explorer.clearRecentProjects") }}
              </button>
            </div>
            <div v-for="item in recentFolders" :key="item" class="recent-row">
              <button
                type="button"
                class="recent-item"
                :title="item"
                @click="onOpenRecent(item)"
              >
                {{ basename(item) }}
              </button>
              <button
                type="button"
                class="recent-remove"
                :title="t('explorer.removeRecentProject')"
                @click="removeRecent(item, $event)"
              >
                <X :size="12" />
              </button>
            </div>
          </div>
        </div>
      </template>

      <template v-else>
        <div
          class="tree"
          :class="{
            'drop-root':
              Boolean(dragSource) && dropValid && dropHoverPath === rootPath,
          }"
          :title="t('explorer.dragMoveHint')"
          @contextmenu="onContext($event, rootPath, true)"
        >
          <button
            v-for="node in flatTree"
            :key="node.path"
            type="button"
            class="row"
            :class="{
              active: selectedPath === node.path,
              selected: selectedPaths.includes(node.path),
              dirty: dirtySet.has(node.path),
              dragging: dragSource?.path === node.path,
              'drop-into':
                dropHoverPath === node.path && dropValid && node.isDir,
              'drop-sibling':
                dropHoverPath === node.path && dropValid && !node.isDir,
              'drop-invalid': dropHoverPath === node.path && !dropValid,
            }"
            :data-tree-path="node.path"
            :style="{ paddingLeft: `${10 + node.depth * 14}px` }"
            @pointerdown="onRowPointerDown($event, node.path, node.isDir)"
            @click="onRowClick($event, node.path, node.isDir)"
            @contextmenu="onContext($event, node.path, node.isDir)"
          >
            <span class="twist">
              <template v-if="node.isDir">
                <ChevronRight
                  :size="14"
                  class="chev"
                  :class="{ expanded: node.expanded }"
                />
              </template>
            </span>
            <FileTypeIcon
              :path="node.path"
              :is-dir="node.isDir"
              :expanded="node.expanded"
              :size="14"
            />
            <span class="label">{{ node.name }}</span>
            <template v-if="!node.isDir && gitStatusByPath.get(node.path)">
              <span
                class="git-badge"
                :class="git.statusClass(gitStatusByPath.get(node.path)!.status)"
                :title="git.statusTitle(gitStatusByPath.get(node.path)!.status)"
                >{{
                  git.statusLabel(gitStatusByPath.get(node.path)!.status)
                }}</span
              >
            </template>
            <template v-else-if="gitDirtyDirMap.get(node.path)">
              <span
                class="git-badge st-modified dir-dirty"
                :title="
                  t('explorer.dirDirtyTitle', {
                    count: gitDirtyDirMap.get(node.path)!.count,
                  })
                "
                @click.stop.prevent="revealDirFirstChanged(node)"
                >{{ gitDirtyDirMap.get(node.path)!.count }}</span
              >
            </template>
            <span v-if="dirtySet.has(node.path)" class="dirty-dot" />
          </button>
        </div>
      </template>
    </div>

    <Transition name="ctx">
      <div
        v-if="menu"
        ref="menuRef"
        class="menu"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
        @click.stop
        @contextmenu.prevent
      >
        <button type="button" @click="runMenu('new-file')">
          {{ t("explorer.newFile") }}
        </button>
        <button type="button" @click="runMenu('new-folder')">
          {{ t("explorer.newFolder") }}
        </button>
        <hr />
        <button
          type="button"
          :disabled="isRootTarget"
          @click="runMenu('rename')"
        >
          {{ t("explorer.rename") }}
        </button>
        <button
          type="button"
          :disabled="isRootTarget"
          @click="runMenu('delete')"
        >
          {{ deleteMenuLabel }}
        </button>
        <hr />
        <button type="button" @click="runMenu('copy')">
          {{ t("explorer.copy") }}
        </button>
        <button type="button" :disabled="isRootTarget" @click="runMenu('cut')">
          {{ t("explorer.cut") }}
        </button>
        <button type="button" :disabled="!clipboard" @click="runMenu('paste')">
          {{ t("explorer.paste") }}
        </button>
        <hr />
        <button type="button" @click="runMenu('copy-abs-path')">
          {{ t("explorer.copyAbsPath") }}
        </button>
        <button type="button" @click="runMenu('copy-rel-path')">
          {{ t("explorer.copyRelPath") }}
        </button>
        <button
          v-if="isFileTarget"
          type="button"
          @click="runMenu('copy-file-name')"
        >
          {{ t("explorer.copyFileName") }}
        </button>
        <button type="button" @click="runMenu('open-in-terminal')">
          {{ t("explorer.openInTerminal") }}
        </button>
        <hr />
        <button type="button" @click="runMenu('reveal-in-os')">
          {{ t("explorer.revealInOs") }}
        </button>
      </div>
    </Transition>

    <!-- 项目下拉浮层：Teleport 到 body 避免被 SideBar overflow:hidden 裁切 -->
    <Teleport to="body">
      <Transition name="ctx">
        <div
          v-if="projectMenuOpen && projectMenuPos"
          class="project-menu"
          :style="{
            top: `${projectMenuPos.top}px`,
            left: `${projectMenuPos.left}px`,
          }"
          @click.stop
        >
          <button
            type="button"
            class="project-item primary"
            @click="onOpenNewProject"
          >
            <FolderInput :size="14" />
            <span>{{ t("explorer.openNewProject") }}</span>
          </button>
          <template v-if="switchCandidates.length">
            <div class="project-sep" />
            <div class="project-label-row">
              <p class="project-label">{{ t("explorer.recentProjects") }}</p>
              <button
                type="button"
                class="project-clear"
                :title="t('explorer.clearRecentProjects')"
                @click="clearAllRecent"
              >
                {{ t("explorer.clearRecentProjects") }}
              </button>
            </div>
            <div
              v-for="item in switchCandidates"
              :key="item"
              class="project-item-wrap"
            >
              <button
                type="button"
                class="project-item"
                :title="item"
                @click="requestOpenPath(item)"
              >
                <span class="project-name">{{ basename(item) }}</span>
                <span class="project-path">{{ item }}</span>
              </button>
              <button
                type="button"
                class="project-remove"
                :title="t('explorer.removeRecentProject')"
                @click="removeRecent(item, $event)"
              >
                <X :size="12" />
              </button>
            </div>
          </template>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.panel {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.header {
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 6px 0 12px;
  border-bottom: 1px solid var(--border-subtle);
  background: color-mix(in srgb, var(--bg-panel) 88%, var(--bg-header));
}

.title-wrap {
  position: relative;
  min-width: 0;
  flex: 1;
  margin-right: 6px;
}

.title-btn {
  max-width: 100%;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 26px;
  padding: 2px 6px 2px 4px;
  border-radius: 6px;
  color: var(--text-secondary);
  transition:
    background var(--transition-fast) var(--ease-out),
    color var(--transition-fast) var(--ease-out);
}

.title-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.title {
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.title-caret {
  flex-shrink: 0;
  opacity: 0.7;
}

.project-menu {
  position: fixed;
  z-index: 30;
  min-width: 220px;
  max-width: min(320px, 70vw);
  padding: 6px;
  border-radius: 10px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  transform-origin: top left;
}

.project-item {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  text-align: left;
  color: var(--text-primary);
  transition:
    background var(--transition-fast) var(--ease-out),
    color var(--transition-fast) var(--ease-out);
}

.project-item.primary {
  align-items: center;
  font-weight: 600;
  color: var(--accent);
}

.project-item:hover {
  background: var(--accent-soft);
}

.project-item .project-name {
  display: block;
  font-size: 12.5px;
  font-weight: 600;
}

.project-item .project-path {
  display: block;
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-item:not(.primary) {
  flex-direction: column;
  gap: 2px;
}

.project-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 2px 10px 4px;
}

.project-label {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted);
}

.project-clear {
  flex-shrink: 0;
  padding: 2px 4px;
  border-radius: 4px;
  font-size: 10px;
  color: var(--text-muted);
  transition:
    background var(--transition-fast) var(--ease-out),
    color var(--transition-fast) var(--ease-out);
}

.project-clear:hover {
  color: var(--accent);
  background: var(--accent-soft);
}

.project-item-wrap {
  display: flex;
  align-items: stretch;
  gap: 2px;
}

.project-item-wrap .project-item {
  flex: 1;
  min-width: 0;
}

.project-remove {
  flex-shrink: 0;
  width: 28px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  color: var(--text-muted);
  transition:
    background var(--transition-fast) var(--ease-out),
    color var(--transition-fast) var(--ease-out);
}

.project-remove:hover {
  color: var(--danger, #e5484d);
  background: color-mix(in srgb, var(--danger, #e5484d) 12%, transparent);
}

.project-sep {
  height: 1px;
  margin: 4px 2px;
  background: var(--border-subtle);
}

.mode-overlay {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  background: var(--bg-overlay);
}

.mode-card {
  width: min(280px, calc(100% - 24px));
  padding: 16px;
  border-radius: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mode-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.mode-path {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mode-btn {
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-app);
  color: var(--text-primary);
  font-weight: 500;
}

.mode-btn.accent {
  background: var(--accent);
  border-color: transparent;
  color: var(--accent-fg);
}

.mode-btn:disabled,
.mode-cancel:disabled {
  opacity: 0.55;
  cursor: wait;
}

.mode-cancel {
  height: 28px;
  color: var(--text-muted);
  font-size: 12px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.icon-btn {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--text-muted);
  transition:
    background var(--transition-fast) var(--ease-out),
    color var(--transition-fast) var(--ease-out),
    opacity var(--transition-fast) var(--ease-out);
}

.icon-btn:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--text-primary);
}

.icon-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.spin {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
}

.icon {
  color: var(--text-muted);
}

.name {
  margin: 0;
  font-weight: 600;
}

.hint {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
}

.cta {
  margin-top: 8px;
  height: 32px;
  padding: 0 14px;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--accent-fg);
  font-weight: 500;
}

.recent {
  margin-top: 16px;
  width: 100%;
  text-align: left;
}

.recent-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.recent-title {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted);
}

.recent-clear {
  padding: 2px 4px;
  border-radius: 4px;
  font-size: 10px;
  color: var(--text-muted);
}

.recent-clear:hover {
  color: var(--accent);
  background: var(--accent-soft);
}

.recent-row {
  display: flex;
  align-items: center;
  gap: 2px;
}

.recent-item {
  flex: 1;
  min-width: 0;
  display: block;
  text-align: left;
  padding: 6px 8px;
  border-radius: 6px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    background var(--transition-fast) var(--ease-out),
    color var(--transition-fast) var(--ease-out);
}

.recent-remove {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  color: var(--text-muted);
}

.recent-remove:hover {
  color: var(--danger, #e5484d);
  background: color-mix(in srgb, var(--danger, #e5484d) 12%, transparent);
}

.recent-item:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

.tree {
  min-height: 100%;
  padding: 4px 6px 12px;
}

.tree.drop-root {
  box-shadow: inset 0 0 0 1px var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}

.row {
  width: 100%;
  min-height: 28px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 8px;
  border-radius: 6px;
  color: var(--text-primary);
  text-align: left;
  touch-action: none;
  cursor: default;
  transition:
    background var(--transition-fast) var(--ease-out),
    color var(--transition-fast) var(--ease-out),
    box-shadow var(--transition-fast) var(--ease-out),
    opacity var(--transition-fast) var(--ease-out);
}

.row:hover {
  background: var(--bg-hover);
}

.row.dragging {
  opacity: 0.45;
  cursor: grabbing;
}

.row.drop-into {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.row.drop-sibling {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  box-shadow: inset 0 -2px 0 var(--accent);
}

.row.drop-invalid {
  box-shadow: inset 0 0 0 1px
    color-mix(in srgb, var(--danger, #e5484d) 55%, transparent);
}

.row.active {
  background: var(--bg-active);
  color: var(--accent);
  box-shadow: inset 2px 0 0 var(--accent);
}

.row.selected {
  background: var(--bg-active);
  color: var(--accent);
}

.row.selected.active {
  box-shadow: inset 2px 0 0 var(--accent);
}

.row:deep(.flash),
.row.flash {
  animation: flash-row 0.9s ease;
}

@keyframes flash-row {
  0% {
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  100% {
    box-shadow: none;
  }
}

.twist {
  width: 14px;
  height: 14px;
  display: grid;
  place-items: center;
  color: var(--text-muted);
  flex-shrink: 0;
}

.chev {
  transition: transform var(--transition-fast) var(--ease-out);
}

.chev.expanded {
  transform: rotate(90deg);
}

.label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}

.git-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  margin-left: auto;
  border-radius: 3px;
  font-size: 9.5px;
  font-weight: 600;
  line-height: 1;
  font-family: var(--font-mono);
  letter-spacing: 0.02em;
  flex-shrink: 0;
  animation: prism-dot-pop 0.32s var(--ease-out) both;
}
.git-badge.st-modified {
  background: var(--warning);
  color: var(--bg-app);
}
.git-badge.st-untracked {
  background: var(--success);
  color: var(--bg-app);
}
.git-badge.st-deleted {
  background: var(--danger);
  color: var(--accent-fg);
}
.git-badge.st-renamed {
  background: var(--accent);
  color: var(--accent-fg);
}
.git-badge.st-conflict {
  background: var(--danger);
  color: var(--accent-fg);
}
.git-badge.dir-dirty {
  cursor: pointer;
}
.git-badge.dir-dirty:hover {
  filter: brightness(1.12);
}

.dirty-dot {
  margin-left: 4px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
  animation: prism-dot-pop 0.32s var(--ease-out) both;
}

.menu {
  position: fixed;
  /* 与 GitLog/Branches 等浮层同级，避免被编辑器等更高 z-index 浮层遮挡 */
  z-index: 90;
  min-width: 180px;
  padding: 6px;
  border-radius: 10px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
  transform-origin: top left;
}

.menu button {
  text-align: left;
  padding: 7px 10px;
  border-radius: 6px;
  color: var(--text-primary);
}

.menu button:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent);
}

.menu button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.menu hr {
  border: none;
  border-top: 1px solid var(--border-subtle);
  margin: 4px 0;
}

/* ctx：project-menu / right-click menu */
.ctx-enter-active {
  transition:
    opacity var(--transition-medium) var(--ease-out),
    transform var(--transition-medium) var(--ease-out);
}
.ctx-leave-active {
  transition:
    opacity var(--transition-fast) var(--ease-out),
    transform var(--transition-fast) var(--ease-out);
}
.ctx-enter-from,
.ctx-leave-to {
  opacity: 0;
  transform: scale(0.96) translateY(-3px);
}

/* dialog：mode-overlay / mode-card */
.dialog-enter-active,
.dialog-leave-active {
  transition: opacity var(--transition-medium) var(--ease-out);
}
.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}
.dialog-enter-active .mode-card,
.dialog-leave-active .mode-card {
  transition:
    opacity var(--transition-medium) var(--ease-out),
    transform var(--transition-medium) var(--ease-out);
}
.dialog-enter-from .mode-card,
.dialog-leave-to .mode-card {
  opacity: 0;
  transform: translateY(6px) scale(0.98);
}
</style>
