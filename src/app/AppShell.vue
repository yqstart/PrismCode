<script setup lang="ts">
import { defineAsyncComponent, onMounted, onUnmounted, watch } from "vue";
import { storeToRefs } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ActivityBar from "@/app/ActivityBar.vue";
import SideBar from "@/app/SideBar.vue";
import TitleBar from "@/app/TitleBar.vue";
import UpdateBadge from "@/app/UpdateBadge.vue";
import EditorArea from "@/app/EditorArea.vue";
import StatusBar from "@/app/StatusBar.vue";
import FindInFilesDialog from "@/features/search/FindInFilesDialog.vue";
import QuickOpen from "@/features/search/QuickOpen.vue";
import SettingsModal from "@/features/settings/SettingsModal.vue";
import ChoiceDialog from "@/shared/ChoiceDialog.vue";
import GitAuthDialog from "@/shared/GitAuthDialog.vue";
import PromptDialog from "@/shared/PromptDialog.vue";
import ReferencesPanel from "@/features/editor/ReferencesPanel.vue";
import MoveReferencesDialog from "@/shared/MoveReferencesDialog.vue";
import ToastHost from "@/shared/ToastHost.vue";
import UpdateProgressDialog from "@/shared/UpdateProgressDialog.vue";
import UpdateNotesDialog from "@/shared/UpdateNotesDialog.vue";
import PushDialog from "@/features/git/PushDialog.vue";
import UpdateProjectDialog from "@/features/git/UpdateProjectDialog.vue";
import InteractiveRebaseDialog from "@/features/git/InteractiveRebaseDialog.vue";
import { basename, isPathUnder } from "@/shared/fs";
import type { ExternalOpenRequest, ExternalOpenTarget } from "@/shared/externalOpen";
import { dispatchDockMenuEvent, type DockMenuEvent } from "@/shared/dockMenu";
import {
  planExternalOpen,
  takeBootFiles,
} from "@/shared/externalOpenRoute";
import { setupAutoSave } from "@/features/editor/autoSave";
import { checkForAppUpdate } from "@/shared/appUpdate";
import { isMacOS } from "@/shared/platform";
import {
  openFolderInNewWindow,
  openLightInNewWindow,
  readBootState,
} from "@/shared/openWorkspace";
import {
  clearMainWindowRoot,
  getWindowSessionId,
  isMainWindowSession,
  loadMainWindowRoot,
} from "@/shared/windowSession";
import { useEditorStore } from "@/stores/editor";
import { useGitStore } from "@/stores/git";
import { useSearchStore } from "@/stores/search";
import { useSessionsStore } from "@/stores/sessions";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { useWorkspaceStore } from "@/stores/workspace";
import { t } from "@/i18n";

/** 终端及 xterm 不属于首屏；首次真正挂载终端面板时再加载。 */
const TerminalPanel = defineAsyncComponent(
  () => import("@/features/sessions/TerminalPanel.vue"),
);

/** macOS 标题栏已挂更新入口；其它平台用右上角浮动徽章 */
const showFloatingUpdateBadge = !isMacOS();
const windowSessionId = getWindowSessionId();
const isPrimaryWindow = isMainWindowSession(windowSessionId);

const ui = useUiStore();
const workspace = useWorkspaceStore();
const editor = useEditorStore();
const search = useSearchStore();
const sessions = useSessionsStore();
const settings = useSettingsStore();
const git = useGitStore();
const { settingsOpen } = storeToRefs(ui);

let unlistenMenu: (() => void) | undefined;
let unlistenDockMenu: (() => void) | undefined;
let unlistenAppExit: (() => void) | undefined;
let unlistenExternalOpen: (() => void) | undefined;
let teardownAutoSave: (() => void) | undefined;
let stopLightTitleWatch: (() => void) | undefined;
let stopLightUnsavedWatch: (() => void) | undefined;
let appQuitting = false;
let externalOpenAccepting = false;
let externalOpenBacklog: ExternalOpenRequest[] = [];
let externalOpenQueue = Promise.resolve();
/** 菜单加速键与 window keydown 可能各触发一次，合并为单次切换 */
let lastTerminalToggleAt = 0;
let lastSidebarToggleAt = 0;
let lastCommitToggleAt = 0;
let pendingCommitChordTimer: number | null = null;

function toggleTerminal() {
  const now = Date.now();
  if (now - lastTerminalToggleAt < 120) return;
  lastTerminalToggleAt = now;
  sessions.toggleSessions(workspace.rootPath);
}

function toggleSidebar() {
  const now = Date.now();
  if (now - lastSidebarToggleAt < 120) return;
  lastSidebarToggleAt = now;
  settings.toggleSidebar();
}

function toggleCommitPanel() {
  const now = Date.now();
  if (now - lastCommitToggleAt < 120) return;
  lastCommitToggleAt = now;
  settings.toggleCommitPanel();
  if (
    settings.layout.activePanel === "commit" &&
    !settings.layout.sidebarCollapsed &&
    workspace.rootPath
  ) {
    void git.scheduleRefresh();
  }
}

async function locateActiveInExplorer() {
  if (!editor.activePath) {
    workspace.showNotice(t("notice.noActiveFile"));
    return;
  }
  settings.setActivePanel("explorer");
  settings.setSidebarCollapsed(false);
  await workspace.revealPath(editor.activePath);
  workspace.showNotice(t("notice.revealed", { name: basename(editor.activePath) }));
}

function handleMenuAction(action: string) {
  if (action === "open_folder") void workspace.openFolder();
  if (action === "save") void editor.saveActive();
  if (action === "settings") ui.openSettings();
  if (action === "find_file") search.openQuickOpen();
  if (action === "find_in_editor") editor.requestFind();
  if (action === "search") search.openFindInFiles();
  if (action === "terminal") toggleTerminal();
  if (action === "toggle_sidebar") toggleSidebar();
  if (action === "reveal_in_explorer") void locateActiveInExplorer();
  if (action === "git_commit") toggleCommitPanel();
}

function onKeydown(event: KeyboardEvent) {
  const mod = event.metaKey || event.ctrlKey;
  // 编辑器的 ⌘K ⌘F 是 CodeMirror chord。⌘K 单独仍保留 Commit 面板命令，
  // 但要延迟一小段时间，避免在 chord 第一笔就被窗口级快捷键抢走。
  if (pendingCommitChordTimer !== null) {
    window.clearTimeout(pendingCommitChordTimer);
    pendingCommitChordTimer = null;
  }
  if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
    if (isEditorTarget(event.target)) {
      if (!event.defaultPrevented) event.preventDefault();
      pendingCommitChordTimer = window.setTimeout(() => {
        pendingCommitChordTimer = null;
        if (isEditorTarget(document.activeElement)) toggleCommitPanel();
      }, 800);
      return;
    }
    event.preventDefault();
    toggleCommitPanel();
    return;
  }
  if (mod && event.key === ",") {
    event.preventDefault();
    ui.toggleSettings();
    return;
  }
  if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "o") {
    event.preventDefault();
    void workspace.openFolder();
    return;
  }
  if (mod && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void editor.saveActive();
    return;
  }
  // WebStorm：Recent Files（⌘/Ctrl+E）。Quick Open 的空查询即最近文件。
  if (
    mod &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "e" &&
    !search.quickOpenVisible &&
    (isEditorTarget(event.target) || !isEditableTarget(event.target))
  ) {
    event.preventDefault();
    search.openQuickOpen();
    return;
  }
  // WebStorm Go to File：macOS ⌘⇧O；Windows/Linux Ctrl+Shift+N。
  if (
    mod &&
    event.shiftKey &&
    !event.altKey &&
    ((isMacOS() && event.key.toLowerCase() === "o") ||
      (!isMacOS() && event.key.toLowerCase() === "n"))
  ) {
    event.preventDefault();
    search.openQuickOpen();
    return;
  }
  if (mod && event.key.toLowerCase() === "p") {
    event.preventDefault();
    search.openQuickOpen();
    return;
  }
  if (mod && event.shiftKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    search.openFindInFiles();
    return;
  }
  // ⌘F：打开编辑器内查找。编辑器聚焦时 CM 的 Prec.highest keymap 已处理并
  // preventDefault（defaultPrevented 为 true 时跳过，避免重复打开）；
  // 失焦场景（侧边栏/终端/状态栏）靠这里兜底——macOS 原生菜单也会触发
  // requestFind，重复调用幂等无害，Windows/Linux 无原生菜单则全依赖此路径。
  if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
    if (!event.defaultPrevented) {
      event.preventDefault();
      editor.requestFind();
    }
    return;
  }
  if (mod && event.key.toLowerCase() === "j") {
    event.preventDefault();
    toggleTerminal();
    return;
  }
  if (mod && event.key.toLowerCase() === "b") {
    // 编辑器内 ⌘/Ctrl+B 由 CodeMirror 执行「跳转到声明」；其它区域仍折叠侧栏。
    if (isEditorTarget(event.target)) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    toggleSidebar();
    return;
  }
  // Alt+F1：在资源管理器中定位当前文件（对齐 WebStorm）
  if (event.altKey && !mod && event.key === "F1") {
    event.preventDefault();
    void locateActiveInExplorer();
    return;
  }
  // 工作台快捷键在 CodeMirror 内仍应生效；只避开普通输入框、xterm、查找面板等。
  if (isEditableTarget(event.target) && !isEditorTarget(event.target)) return;
  // ⌘W：关闭当前标签
  if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "w") {
    event.preventDefault();
    if (editor.activePath) {
      void editor.closeTab(editor.activePath);
    }
    return;
  }
  // ⌘⌥→ / ⌘⌥←：切换到下一个 / 上一个标签
  if (mod && event.altKey && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
    event.preventDefault();
    if (event.key === "ArrowRight") editor.activateNextTab();
    else editor.activatePrevTab();
    return;
  }
  // ⌘R：刷新资源树
  if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "r") {
    event.preventDefault();
    void workspace.refreshFromDisk();
    return;
  }
  if (event.key === "Escape") {
    if (search.findInFilesVisible) {
      search.closeFindInFiles();
      return;
    }
    if (search.quickOpenVisible) {
      search.closeQuickOpen();
      return;
    }
    if (settingsOpen.value) {
      ui.closeSettings();
    }
  }
}

/** 判断快捷键事件是否来自 CodeMirror 编辑区（不把普通输入框算入 chord）。 */
function isEditorTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest(".cm-content, .cm-editor"));
}

/** 命中输入控件时跳过文本编辑类快捷键 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  // xterm / CodeMirror 内容区
  if (target.closest(".xterm, .cm-content, .cm-editor")) return true;
  return false;
}

function onWindowFocus() {
  if (workspace.rootPath) {
    void workspace.refreshFromDisk([], { quiet: true });
    return;
  }
  // light 模式（无工作区）没有文件监听：回到窗口时同步一次打开标签的磁盘
  // 内容，让其它编辑器 / 终端的改动也能被发现（脏标签按既有规则询问）。
  if (editor.tabs.length) {
    void editor.syncExternalChanges(editor.tabs.map((tab) => tab.path));
  }
}

/**
 * 关闭/退出前同步该窗口当前工作区的文件和终端快照；主窗口工作区锚点在打开工作区时已写入。
 */
function persistWindowState() {
  const root = workspace.rootPath;
  settings.persistNow();
  editor.persistSession(root);
  sessions.persistSession(root);
}

/** light 模式未保存文件的提示文案（最多列 3 个文件名） */
function lightDirtyLabel(): string {
  const dirtyTabs = editor.tabs.filter((tab) => editor.dirtyPaths.has(tab.path));
  const names = dirtyTabs
    .slice(0, 3)
    .map((tab) => tab.name)
    .join("、");
  return dirtyTabs.length > 3 ? `${names} 等 ${dirtyTabs.length} 个文件` : names;
}

/**
 * light 模式（无工作区）没有按工作区持久化的会话快照可用，关闭窗口前必须让用户
 * 确认未保存的独立文件；返回 false 表示取消本次关闭。
 */
function confirmDiscardLightTabs(): boolean {
  if (workspace.rootPath || !editor.dirtyPaths.size) return true;
  return window.confirm(
    `${lightDirtyLabel()} 有未保存更改，关闭窗口将丢弃这些更改。继续？`,
  );
}

/** 上报本窗口 light 模式未保存状态：Rust 在应用退出前据此拦住退出。 */
function reportLightUnsaved(dirty: boolean) {
  void invoke("set_light_unsaved", { dirty }).catch(() => undefined);
}

function onBeforeUnload() {
  persistWindowState();
  // 主窗口正常关闭时清除工作区锚点；应用整体退出由 app://will-exit 标记后保留。
  if (!appQuitting) clearMainWindowRoot();
}

/**
 * 主进程发出应用退出通知后，各 WebView 先保存，再按原生流程退出。
 * light 模式没有工作区会话快照：自动保存开启时先落盘再放行退出，关闭自动保存时
 * 由用户确认（Rust 侧已 prevent_exit，取消即留在应用内）。
 */
async function onAppWillExit() {
  appQuitting = true;
  persistWindowState();
  if (workspace.rootPath || !editor.dirtyPaths.size) return;
  if (settings.settings.editor.autoSave) {
    await editor.saveAll({ quiet: true, auto: true });
    reportLightUnsaved(false);
    void invoke("confirm_app_exit").catch(() => undefined);
    return;
  }
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFocus();
  } catch {
    // 纯 Vite 预览时无 Tauri runtime
  }
  if (window.confirm(`${lightDirtyLabel()} 有未保存更改，退出将丢弃这些更改。继续？`)) {
    reportLightUnsaved(false);
    void invoke("confirm_app_exit").catch(() => undefined);
  } else {
    // 取消退出：复位退出标记，窗口保持可用，下次退出重新判定。
    appQuitting = false;
  }
}

function openExternalFiles(targets: ExternalOpenTarget[]) {
  for (const target of targets) {
    const path = target.path;
    try {
      const line =
        typeof target.line === "number" && Number.isFinite(target.line)
          ? Math.max(1, Math.floor(target.line))
          : null;
      const column =
        typeof target.column === "number" && Number.isFinite(target.column)
          ? Math.max(1, Math.floor(target.column))
          : 1;
      const openPromise =
        line !== null
          ? editor.openFileAt(path, line, column)
          : editor.openFile(path);
      void openPromise.catch((error: unknown) => {
        workspace.showNotice(
          error instanceof Error ? error.message : String(error),
          3200,
        );
      });
    } catch (error) {
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }
}

async function openExternalTargets(targets: ExternalOpenTarget[]) {
  const plan = planExternalOpen(targets, workspace.rootPath);

  // 目录：与当前工作区相同时忽略（之前会整窗切换过去，属于打扰）；
  // 新目录逐个开新窗口，不占用当前窗口。
  for (const dir of plan.newWindowDirs) {
    try {
      await openFolderInNewWindow(dir.path);
    } catch (error) {
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  // 工作区外文件：新窗口以 light 模式打开（单个/多个文件，无工作区），
  // 不再把文件所在目录当成项目整窗打开。
  if (plan.lightFiles.length) {
    try {
      await openLightInNewWindow(plan.lightFiles);
    } catch (error) {
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }

  // 本窗口只处理两类：启动目录、本窗口要打开的文件。
  for (const dir of plan.inCurrentDirs) {
    try {
      await workspace.openFolder(dir.path);
    } catch (error) {
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }
  if (!plan.inCurrentFiles.length) return;
  // 无工作区（欢迎页 / light 窗口）时文件就地打开：窗口进入 light 模式，
  // 与项目无关；工作区内的文件则继续叠加在本窗口。
  const root = workspace.rootPath;
  if (!root) {
    workspace.enterLightMode();
    openExternalFiles(plan.inCurrentFiles);
    return;
  }
  // 分流后工作区已被切走（用户在排队期间打开了别的项目）：不在工作区内的
  // 文件改走 light 窗口，避免触发「禁止访问工作区外的路径」。
  const inRoot = plan.inCurrentFiles.filter((target) =>
    isPathUnder(root, target.path),
  );
  const outside = plan.inCurrentFiles.filter(
    (target) => !isPathUnder(root, target.path),
  );
  if (outside.length) {
    try {
      await openLightInNewWindow(outside);
    } catch (error) {
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    }
  }
  openExternalFiles(inRoot);
}

function queueExternalOpenRequest(request: ExternalOpenRequest) {
  if (!request?.targets?.length) return;
  if (!externalOpenAccepting) {
    externalOpenBacklog.push(request);
    return;
  }
  externalOpenQueue = externalOpenQueue.then(() => openExternalTargets(request.targets));
}

/** 先注册监听，再取 Rust 端的冷启动队列，避免 Launch Services 事件丢失。 */
async function setupExternalOpenBridge() {
  if (!isPrimaryWindow) return;
  try {
    unlistenExternalOpen = await listen<ExternalOpenRequest>(
      "app://open-external",
      (event) => queueExternalOpenRequest(event.payload),
    );
    const pending = await invoke<ExternalOpenRequest[]>(
      "take_pending_external_opens",
    );
    if (Array.isArray(pending)) externalOpenBacklog.push(...pending);
  } catch {
    // 纯 Vite 预览时无 Tauri runtime；桌面运行时由 Rust 命令提供队列。
  }
}

function openRecentProjectInNewWindow(path: string) {
  void openFolderInNewWindow(path).catch((error) => {
    workspace.showNotice(error instanceof Error ? error.message : String(error), 3200);
  });
}

async function restoreApplicationWindows(bootFolder: string | null) {
  // 动态窗口：URL 带 folder 时恢复成项目窗口，否则是 light 窗口
  // （用 Prism Code 打开文件创建，只展示随窗口透传的独立文件）。
  if (!isPrimaryWindow) {
    const bootFiles = takeBootFiles(windowSessionId);
    if (!bootFolder) {
      if (bootFiles.length) {
        workspace.enterLightMode();
        openExternalFiles(bootFiles);
      }
      return;
    }
    const opened = await workspace.openFolder(bootFolder, { quiet: true });
    // 外部打开落到新窗口时，随窗口透传待开文件；新窗口打开目录成功后再
    // 打开文件，行列定位复用普通编辑器链路。目录打开失败也要取走透传，
    // 避免残留文件下次误打开。
    if (opened && bootFiles.length) openExternalFiles(bootFiles);
    return;
  }

  // 主窗口只恢复自己的工作区；应用重启不再重建退出时的多窗口布局。
  const lastRoot = loadMainWindowRoot();
  if (lastRoot) {
    const opened = await workspace.openFolder(lastRoot, { quiet: true });
    if (opened) return;
  }
  await workspace.restoreLastFolder();
}

onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("focus", onWindowFocus);
  window.addEventListener("beforeunload", onBeforeUnload);
  teardownAutoSave = setupAutoSave({
    beforeClose: () => {
      if (!confirmDiscardLightTabs()) return false;
      persistWindowState();
      reportLightUnsaved(false);
      // 主窗口正常关闭时不应在下次启动自动打开工作区；应用整体退出则保留。
      if (!appQuitting) clearMainWindowRoot();
      return true;
    },
  });
  // macOS：启动后立即把主窗口拉前（解决自动更新后需手动点 dock 才能前置的问题）。
  // 不能在 Rust setup 闭包里调 NSApp.setActivationPolicy()，会跟 tao 0.35
  // did_finish_launching 内部的 AppState::launched 时序冲突，触发
  // "panic in a function that cannot unwind"。前端 mount 时调
  // setFocus + unminimize 即可达成同样效果。
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.unminimize();
    await win.setFocus();
  } catch {
    // 纯 Vite 预览时无 Tauri runtime
  }
  try {
    unlistenAppExit = await listen("app://will-exit", onAppWillExit);
  } catch {
    // 纯 Vite 预览时无 Tauri runtime
  }
  try {
    unlistenMenu = await listen<string>("menu://action", (event) => {
      handleMenuAction(event.payload);
    });
  } catch {
    // 纯 Vite 预览时无 Tauri runtime
  }
  // macOS Dock 菜单（右键 Dock 图标弹出的菜单）点击事件。
  // Rust 端用 app.emit 广播给全部 WebView，因此只让主窗口注册监听，
  // 避免已有多个窗口时一次点击被重复处理。
  if (isPrimaryWindow) {
    try {
      unlistenDockMenu = await listen<DockMenuEvent>(
        "menu://dock",
        (event) => {
          dispatchDockMenuEvent(event.payload, {
            openFolder: () => {
              void workspace.openFolder();
            },
            openRecentInNewWindow: openRecentProjectInNewWindow,
          });
        },
      );
    } catch {
      // 非 macOS / 纯 Vite 预览时无此事件源
    }
  }

  // light 窗口（无工作区）的原生标题跟随活动文件；项目窗口的标题由
  // workspace store 内的 rootPath watcher 负责。
  stopLightTitleWatch = watch(
    () => [workspace.rootPath, editor.activePath] as const,
    ([root, file]) => {
      if (!root) void workspace.syncWindowTitle(file);
    },
    { immediate: true },
  );

  // light 模式未保存状态上报 Rust：应用退出前由本窗口先落盘或请用户确认，
  // 避免「关闭窗口会提示、⌘Q 却静默丢改」的不一致。
  stopLightUnsavedWatch = watch(
    () => !workspace.rootPath && editor.dirtyPaths.size > 0,
    (dirty) => reportLightUnsaved(dirty),
    { immediate: true },
  );

  await setupExternalOpenBridge();
  const { folder: bootFolder } = readBootState();
  await restoreApplicationWindows(bootFolder);

  if (isPrimaryWindow) {
    externalOpenAccepting = true;
    const backlog = externalOpenBacklog;
    externalOpenBacklog = [];
    for (const request of backlog) queueExternalOpenRequest(request);
  }

  if (settings.settings.autoCheckUpdates && !import.meta.env.DEV) {
    window.setTimeout(() => {
      void checkForAppUpdate("auto", (message, ms) =>
        workspace.showNotice(message, ms),
      );
    }, 4000);
  }
});

onUnmounted(() => {
  if (pendingCommitChordTimer !== null) {
    window.clearTimeout(pendingCommitChordTimer);
    pendingCommitChordTimer = null;
  }
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("focus", onWindowFocus);
  window.removeEventListener("beforeunload", onBeforeUnload);
  editor.persistSession();
  teardownAutoSave?.();
  stopLightTitleWatch?.();
  stopLightUnsavedWatch?.();
  workspace.stopWatch();
  unlistenMenu?.();
  unlistenDockMenu?.();
  unlistenAppExit?.();
  externalOpenAccepting = false;
  externalOpenBacklog = [];
  unlistenExternalOpen?.();
});
</script>

<template>
  <div class="shell">
    <TitleBar />
    <div
      v-if="showFloatingUpdateBadge"
      class="floating-update"
    >
      <UpdateBadge />
    </div>
    <div class="main">
      <ActivityBar />
      <SideBar />
      <div class="center">
        <EditorArea />
        <!-- 终端面板只占编辑器列：资源管理器（ActivityBar+SideBar）保持整列高度 -->
        <TerminalPanel v-if="sessions.mounted" v-show="sessions.open" />
      </div>
    </div>
    <StatusBar />
    <QuickOpen />
    <FindInFilesDialog />
    <PromptDialog />
    <ReferencesPanel />
    <MoveReferencesDialog />
    <ChoiceDialog />
    <UpdateProgressDialog />
    <UpdateNotesDialog />
    <GitAuthDialog />
    <PushDialog />
    <UpdateProjectDialog />
    <InteractiveRebaseDialog />
    <Transition name="dialog">
      <SettingsModal v-if="settingsOpen" />
    </Transition>
    <ToastHost />
  </div>
</template>

<style scoped>
.shell {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-app);
  color: var(--text-primary);
  position: relative;
}

.floating-update {
  position: absolute;
  top: 8px;
  right: 4px;
  z-index: 40;
  pointer-events: none;
}

.floating-update :deep(.update-cluster) {
  pointer-events: auto;
}

.main {
  flex: 1;
  min-height: 0;
  display: flex;
  background: var(--bg-app);
}

.center {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* dialog：SettingsModal 父级统一 leave 动画；其它 modal 仍走组件内 animation */
.dialog-enter-active,
.dialog-leave-active {
  transition: opacity var(--transition-medium) var(--ease-out);
}
.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}
</style>
