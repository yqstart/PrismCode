<script setup lang="ts">
// ==================== IDEA 主工具栏（窗口头） ====================
// IDEA New UI 的 window header，从左到右：
//   红绿灯留白 → 项目 widget（切换/打开项目）→ VCS widget（分支与常用动作）
//   → 居中 Run widget（运行配置 + 运行/调试）→ 右侧搜索 / 设置 / 更新徽章。
// macOS 用系统菜单栏，因此这里不放主菜单按钮；整个头是窗口拖拽区。
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import {
  Bug,
  ChevronDown,
  FolderOpen,
  GitBranch,
  Play,
  Search,
  Settings,
} from "lucide-vue-next";
import UpdateBadge from "@/app/UpdateBadge.vue";
import BranchesPopup from "@/features/git/BranchesPopup.vue";
import { formatShortcut, isMacOS } from "@/shared/platform";
import { basename } from "@/shared/fs";
import type { RunConfiguration } from "@/stores/java";
import { useDebugStore } from "@/stores/debug";
import { useEditorStore } from "@/stores/editor";
import { useGitStore } from "@/stores/git";
import { useJavaStore } from "@/stores/java";
import { usePackageScriptsStore } from "@/stores/packageScripts";
import { useSearchStore } from "@/stores/search";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { useWorkspaceStore } from "@/stores/workspace";
import { useI18n } from "@/i18n";

const { t } = useI18n();
const workspace = useWorkspaceStore();
const editor = useEditorStore();
const git = useGitStore();
const java = useJavaStore();
const pkg = usePackageScriptsStore();
const debug = useDebugStore();
const search = useSearchStore();
const sessions = useSessionsStore();
const ui = useUiStore();

const { rootPath, rootName, recentFolders } = storeToRefs(workspace);
const { snapshot } = storeToRefs(git);
const { runConfigurations } = storeToRefs(java);
const { allScripts } = storeToRefs(pkg);
const { state: debugState } = storeToRefs(debug);

/** 仅 macOS Overlay 标题栏需要与红绿灯同排；全屏时红绿灯隐藏，左留白收起 */
const isMac = isMacOS();
const isFullscreen = ref(false);

async function syncTrafficLights() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("sync_traffic_lights");
  } catch {
    // 纯 Vite 预览或非 macOS
  }
}

async function refreshFullscreen() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    isFullscreen.value = await getCurrentWindow().isFullscreen();
  } catch {
    isFullscreen.value = false;
  }
}

let unlistenResize: (() => void) | undefined;

onMounted(() => {
  if (!isMac) return;
  void refreshFullscreen();
  void syncTrafficLights();
  void (async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      let wasFullscreen = isFullscreen.value;
      unlistenResize = await win.onResized(() => {
        void (async () => {
          await refreshFullscreen();
          // 退出全屏后补一次红绿灯重排（AppKit 进出全屏会重置标题栏布局）
          if (wasFullscreen && !isFullscreen.value) void syncTrafficLights();
          wasFullscreen = isFullscreen.value;
        })();
      });
    } catch {
      // 非桌面壳
    }
  })();
});

onUnmounted(() => {
  unlistenResize?.();
});

// ==================== 项目 widget ====================

const projectMenuOpen = ref(false);
const projectBtn = ref<HTMLButtonElement | null>(null);
const projectMenuStyle = ref<Record<string, string>>({});

const projectLabel = computed(() => {
  if (rootPath.value) return rootName.value;
  const path = editor.activePath;
  return path ? basename(path) : t("title.noFolder");
});

function placeProjectMenu() {
  const el = projectBtn.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  projectMenuStyle.value = {
    left: `${rect.left}px`,
    top: `${rect.bottom + 4}px`,
  };
}

async function toggleProjectMenu() {
  if (projectMenuOpen.value) {
    projectMenuOpen.value = false;
    return;
  }
  projectMenuOpen.value = true;
  await new Promise((resolve) => requestAnimationFrame(resolve));
  placeProjectMenu();
}

async function openFolderDialog() {
  projectMenuOpen.value = false;
  await workspace.openFolder();
}

async function openRecentFolder(path: string) {
  projectMenuOpen.value = false;
  await workspace.openFolder(path);
}

/** 复制当前项目（或独立文件）路径到剪贴板 */
async function copyProjectPath() {
  const target = rootPath.value ?? editor.activePath;
  if (!target) return;
  try {
    await navigator.clipboard.writeText(target);
    workspace.showNotice(t("title.copyPath"));
  } catch {
    // 剪贴板被拒权，忽略
  }
  projectMenuOpen.value = false;
}

// ==================== VCS widget ====================

const branchesOpen = ref(false);
const branch = computed(() =>
  snapshot.value.initialized ? snapshot.value.branch : null,
);

function toggleBranches() {
  if (!branch.value) return;
  branchesOpen.value = !branchesOpen.value;
}

// 菜单 / Find Action 触发的「分支」请求 → 打开 VCS widget 的分支弹层
watch(
  () => git.branchesRequestSeq,
  () => {
    projectMenuOpen.value = false;
    runMenuOpen.value = false;
    if (branch.value) branchesOpen.value = true;
  },
);

// ==================== Run widget ====================

/** 运行目标：Java 运行配置与 package.json 脚本共用同一个 Run widget（前端 + Java 一体化入口） */
interface RunTarget {
  key: string;
  label: string;
  hint: string;
  javaConfig?: RunConfiguration;
  npmScript?: { name: string; custom: boolean };
}

const javaTargets = computed<RunTarget[]>(() =>
  runConfigurations.value.map((item) => ({
    key: `java:${item.id}`,
    label: item.label,
    hint: item.module === "." || !item.module ? t("run.group.root") : item.module,
    javaConfig: item,
  })),
);

const scriptTargets = computed<RunTarget[]>(() =>
  allScripts.value.map((item) => ({
    key: `script:${item.custom ? "custom:" : ""}${item.name}`,
    label: item.name,
    hint: item.script,
    npmScript: { name: item.name, custom: item.custom },
  })),
);

const runTargets = computed<RunTarget[]>(() => [
  ...javaTargets.value,
  ...scriptTargets.value,
]);

/** 当前选中的运行目标；为空时退到第一条（Java 配置在前，脚本在后） */
const selectedKey = ref<string | null>(null);
const selectedTarget = computed<RunTarget | null>(() => {
  const list = runTargets.value;
  if (!list.length) return null;
  return list.find((item) => item.key === selectedKey.value) ?? list[0] ?? null;
});

const runMenuOpen = ref(false);
const runBtn = ref<HTMLButtonElement | null>(null);
const runMenuStyle = ref<Record<string, string>>({});

const runBusy = computed(
  () => debugState.value === "starting" || debugState.value === "running",
);

/** 只有 Java 运行配置支持 DAP 调试，package.json 脚本暂不提供 */
const canDebug = computed(() => Boolean(selectedTarget.value?.javaConfig));

// 脚本清单随工作区刷新（Run widget 下拉里与 Java 运行配置并列）
watch(
  () => workspace.rootPath,
  () => {
    void pkg.refresh();
  },
  { immediate: true },
);

async function toggleRunMenu() {
  if (runMenuOpen.value) {
    runMenuOpen.value = false;
    return;
  }
  runMenuOpen.value = true;
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const el = runBtn.value;
  if (el) {
    const rect = el.getBoundingClientRect();
    runMenuStyle.value = { left: `${rect.left}px`, top: `${rect.bottom + 4}px` };
  }
}

function selectRunTarget(target: RunTarget) {
  selectedKey.value = target.key;
  runMenuOpen.value = false;
}

async function launchRun() {
  const target = selectedTarget.value;
  if (!target) return;
  runMenuOpen.value = false;
  if (target.javaConfig) {
    await java.launchConfiguration(target.javaConfig.id, false);
    return;
  }
  if (target.npmScript) {
    await pkg.runScript(target.npmScript.name, target.npmScript.custom);
  }
}

async function launchDebug() {
  const target = selectedTarget.value;
  if (!target?.javaConfig) return;
  runMenuOpen.value = false;
  sessions.showDebug();
  await debug.start(target.javaConfig.id);
}

// ==================== 右侧动作 ====================

function openSearchEverywhere() {
  search.openSearchEverywhere("all");
}

/** 全局点击关闭：项目菜单 / 运行配置菜单 / 分支弹层互斥 */
function onDocPointer(event: MouseEvent) {
  const target = event.target as Node | null;
  if (projectMenuOpen.value) {
    const menu = document.getElementById("prism-project-menu");
    if (!projectBtn.value?.contains(target) && !menu?.contains(target)) {
      projectMenuOpen.value = false;
    }
  }
  if (runMenuOpen.value) {
    const menu = document.getElementById("prism-run-menu");
    if (!runBtn.value?.contains(target) && !menu?.contains(target)) {
      runMenuOpen.value = false;
    }
  }
}

function onKey(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  projectMenuOpen.value = false;
  runMenuOpen.value = false;
}

onMounted(() => {
  document.addEventListener("mousedown", onDocPointer);
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", placeProjectMenu);
});

onUnmounted(() => {
  document.removeEventListener("mousedown", onDocPointer);
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("resize", placeProjectMenu);
});
</script>

<template>
  <header class="main-toolbar" :aria-label="t('app.mainToolbar')">
    <div
      v-if="isMac"
      class="traffic-spacer"
      :class="{ fullscreen: isFullscreen }"
      data-tauri-drag-region
    />

    <!-- 项目 widget：当前项目名，点击切换/打开项目（IDEA New UI 主工具栏最左） -->
    <button
      ref="projectBtn"
      type="button"
      class="widget"
      :title="rootPath ?? editor.activePath ?? t('title.noFolder')"
      @click="toggleProjectMenu"
    >
      <span class="widget-label strong">{{ projectLabel }}</span>
      <ChevronDown :size="14" :stroke-width="2" class="caret" />
    </button>

    <!-- VCS widget：当前分支，点击分支操作（IDEA 用 VCS widget 取代旧状态栏分支） -->
    <button
      v-if="branch"
      type="button"
      class="widget"
      :title="`${t('activity.branches')} · ${branch}`"
      @click="toggleBranches"
    >
      <GitBranch :size="14" :stroke-width="1.75" />
      <span class="widget-label">{{ branch }}</span>
      <ChevronDown :size="14" :stroke-width="2" class="caret" />
    </button>

    <div class="drag-fill" data-tauri-drag-region />

    <!-- Run widget：运行配置（Java / Maven / Spring）+ package.json 脚本，IDEA 居中位置 -->
    <div v-if="selectedTarget" class="run-widget">
      <button
        ref="runBtn"
        type="button"
        class="widget run-config"
        :title="selectedTarget.hint"
        @click="toggleRunMenu"
      >
        <span class="widget-label">{{ selectedTarget.label }}</span>
        <ChevronDown :size="14" :stroke-width="2" class="caret" />
      </button>
      <button
        type="button"
        class="tool-btn"
        :title="t('run.action.run')"
        :disabled="runBusy"
        @click="launchRun"
      >
        <Play :size="15" :stroke-width="1.75" />
      </button>
      <button
        type="button"
        class="tool-btn"
        :title="canDebug ? t('run.action.debug') : t('run.debugUnsupported')"
        :disabled="runBusy || !canDebug"
        @click="launchDebug"
      >
        <Bug :size="15" :stroke-width="1.75" />
      </button>
    </div>

    <div class="drag-fill" data-tauri-drag-region />

    <UpdateBadge v-if="isMac" />
    <button
      type="button"
      class="tool-btn"
      :title="t('searchEverywhere.openHint')"
      @click="openSearchEverywhere"
    >
      <Search :size="15" :stroke-width="1.75" />
    </button>
    <button
      type="button"
      class="tool-btn"
      :title="`${t('activity.settings')} · ${formatShortcut('mod', ',')}`"
      @click="ui.openSettings()"
    >
      <Settings :size="15" :stroke-width="1.75" />
    </button>
    <span class="right-pad" />
  </header>

  <Teleport to="body">
    <Transition name="popover">
      <div
        v-if="projectMenuOpen"
        id="prism-project-menu"
        class="toolbar-pop"
        :style="projectMenuStyle"
        role="menu"
      >
        <button
          type="button"
          class="pop-row"
          :disabled="!rootPath && !editor.activePath"
          @click="copyProjectPath"
        >
          {{ t("title.copyPath") }}
        </button>
        <button type="button" class="pop-row" @click="openFolderDialog">
          {{ t("explorer.openFolder") }}
        </button>
        <template v-if="recentFolders.length">
          <div class="pop-sep" />
          <div class="pop-caption">{{ t("title.recentProjects") }}</div>
          <button
            v-for="path in recentFolders"
            :key="path"
            type="button"
            class="pop-row"
            :title="path"
            @click="openRecentFolder(path)"
          >
            <FolderOpen :size="13" :stroke-width="1.75" />
            <span class="pop-row-label">{{ basename(path) }}</span>
            <span class="pop-row-path">{{ path }}</span>
          </button>
        </template>
      </div>
    </Transition>
  </Teleport>

  <Teleport to="body">
    <Transition name="popover">
      <div
        v-if="runMenuOpen"
        id="prism-run-menu"
        class="toolbar-pop"
        :style="runMenuStyle"
        role="menu"
      >
        <template v-if="javaTargets.length">
          <div class="pop-caption">{{ t("run.configurations") }}</div>
          <button
            v-for="item in javaTargets"
            :key="item.key"
            type="button"
            class="pop-row"
            :class="{ active: item.key === selectedTarget?.key }"
            @click="selectRunTarget(item)"
          >
            <span class="pop-row-label">{{ item.label }}</span>
            <span class="pop-row-path">{{ item.hint }}</span>
          </button>
        </template>
        <template v-if="scriptTargets.length">
          <div class="pop-sep" v-if="javaTargets.length" />
          <div class="pop-caption">{{ t("run.scripts") }}</div>
          <button
            v-for="item in scriptTargets"
            :key="item.key"
            type="button"
            class="pop-row"
            :class="{ active: item.key === selectedTarget?.key }"
            @click="selectRunTarget(item)"
          >
            <span class="pop-row-label">{{ item.label }}</span>
            <span class="pop-row-path">{{ item.hint }}</span>
          </button>
        </template>
      </div>
    </Transition>
  </Teleport>

  <BranchesPopup :open="branchesOpen" @close="branchesOpen = false" />
</template>

<style scoped>
.main-toolbar {
  height: var(--titlebar-height);
  /* 杀掉 <header> UA 默认 margin: 1em 0（约 13px），否则会撑高工具栏
     导致原生红绿灯（垂直中线 19pt）与内部控件错位 */
  margin: 0;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 0;
  background: var(--bg-header);
  border-bottom: 1px solid var(--border-subtle);
}

.traffic-spacer {
  width: var(--traffic-light-pad);
  height: 100%;
  flex-shrink: 0;
  transition: width var(--transition-fast);
}

.traffic-spacer.fullscreen {
  width: var(--space-2);
}

/* IDEA 主工具栏 widget：26px 高、圆角、hover 浅叠加 */
.widget {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  white-space: nowrap;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.widget:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.widget-label {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.widget-label.strong {
  font-weight: 600;
  color: var(--text-primary);
  max-width: 180px;
}

.caret {
  color: var(--text-muted);
  flex-shrink: 0;
}

.run-widget {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.run-config .widget-label {
  max-width: 200px;
}

.tool-btn {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  display: grid;
  place-items: center;
  color: var(--text-secondary);
  transition: background var(--transition-fast), color var(--transition-fast);
}

.tool-btn:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.tool-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 与左侧红绿灯留白对称的右侧留白（红绿灯离左 14pt） */
.right-pad {
  width: 10px;
  flex-shrink: 0;
}

.drag-fill {
  flex: 1;
  height: 100%;
  min-width: 8px;
}

/* 工具栏下拉：项目 / 运行配置 */
.toolbar-pop {
  position: fixed;
  z-index: 70;
  min-width: 220px;
  max-width: 380px;
  max-height: min(440px, 70vh);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 4px;
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  transform-origin: top left;
}

.pop-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  text-align: left;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.pop-row:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.pop-row.active {
  color: var(--accent);
}

.pop-row:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.pop-row-label {
  flex-shrink: 0;
  color: var(--text-primary);
}

.pop-row-path {
  flex: 1;
  min-width: 0;
  direction: rtl;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}

.pop-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border-subtle);
}

.pop-caption {
  padding: 6px 8px 2px;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}

.popover-enter-active {
  transition: opacity var(--transition-medium) var(--ease-out),
    transform var(--transition-medium) var(--ease-out);
}
.popover-leave-active {
  transition: opacity var(--transition-fast) var(--ease-out),
    transform var(--transition-fast) var(--ease-out);
}
.popover-enter-from,
.popover-leave-to {
  opacity: 0;
  transform: scale(0.96) translateY(-4px);
}
</style>
