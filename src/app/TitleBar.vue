<script setup lang="ts">
import { onMounted, onUnmounted, computed, ref } from "vue";
import { PanelLeft, PanelLeftClose, Copy, Check } from "lucide-vue-next";
import { storeToRefs } from "pinia";
import UpdateBadge from "@/app/UpdateBadge.vue";
import { formatShortcut, isMacOS } from "@/shared/platform";
import { basename } from "@/shared/fs";
import { useEditorStore } from "@/stores/editor";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import { useI18n } from "@/i18n";

const { t } = useI18n();
const settings = useSettingsStore();
const workspace = useWorkspaceStore();
const editor = useEditorStore();
const { layout } = storeToRefs(settings);
const { rootPath } = storeToRefs(workspace);

/** 仅 macOS Overlay 标题栏需要与红绿灯同排的控件 */
const visible = isMacOS();

const collapsed = computed(() => layout.value.sidebarCollapsed);
const tip = computed(() =>
  t(collapsed.value ? "title.expandSidebar" : "title.collapseSidebar", {
    shortcut: formatShortcut("mod", "B"),
  }),
);

/** 全屏时原生红绿灯隐藏，折叠按钮应贴左 */
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

/** 全局项目标题：项目名（粗体 ≤24 字符自动截断）+ 完整路径（淡灰，ellipsis）。
 *  light 模式（无工作区）显示当前独立文件名与所在目录，不再是「未打开文件夹」。 */
const MAX_NAME = 24;
const clampName = (name: string) =>
  name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name;
const projectTitle = computed(() => {
  if (!rootPath.value) {
    const path = editor.activePath;
    return path ? clampName(basename(path)) : t("title.noFolder");
  }
  const name = rootPath.value.split("/").filter(Boolean).pop() ?? t("title.noFolder");
  return clampName(name);
});
/** 标题栏可复制/展示的完整路径：工作区根；light 模式为当前文件路径 */
const titlePath = computed(
  () => rootPath.value ?? editor.activePath ?? "",
);

/** 点击标题复制完整路径到剪贴板（带视觉反馈） */
const copied = ref(false);
let copiedTimer: number | null = null;
async function copyProjectPath() {
  if (!titlePath.value) return;
  try {
    await navigator.clipboard.writeText(titlePath.value);
    copied.value = true;
    if (copiedTimer != null) window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => {
      copied.value = false;
    }, 1200);
  } catch {
    // 剪贴板被拒权，忽略
  }
}

let unlistenResize: (() => void) | undefined;
const timers: number[] = [];

onMounted(() => {
  if (!visible) return;

  void refreshFullscreen();
  // 启动瞬间调一次即可；后续由 Rust 端 install_traffic_light_hooks
  // 监听 Resized/Moved/ThemeChanged/ScaleFactorChanged/Focused 事件统一重排。
  // 不在前端做 80/300/900ms 延迟补排，避免与 AppKit 自身 layout 反复 setFrame
  // 抢位置造成抖动。
  void syncTrafficLights();

  void (async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      // Tauri 后端没有原生 Fullscreen 事件，前端监听进入/退出全屏做两件事：
      // 1) 更新 isFullscreen（折叠按钮贴左）；
      // 2) 退出全屏后补一次红绿灯重排——AppKit 进出全屏会重置标题栏布局，
      //    而后端 apply_traffic_lights 在全屏期间主动跳过，需在退出后补排。
      let wasFullscreen = isFullscreen.value;
      unlistenResize = await win.onResized(() => {
        void (async () => {
          await refreshFullscreen();
          // onResized 在全屏过渡中也会触发；退出全屏的最后一次重排
          // 落在 isFullscreen 翻回 false 之后，补一次即可，平时后端已处理。
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
  for (const id of timers) window.clearTimeout(id);
  if (copiedTimer != null) window.clearTimeout(copiedTimer);
});
</script>

<template>
  <header v-if="visible" class="titlebar" :aria-label="t('app.titleBar')">
    <!-- 为原生红绿灯预留空间；全屏时收起，折叠按钮贴左 -->
    <div
      class="traffic-spacer"
      :class="{ fullscreen: isFullscreen }"
      data-tauri-drag-region
    />
    <button
      type="button"
      class="sidebar-btn"
      :title="tip"
      :aria-label="tip"
      :aria-pressed="!collapsed"
      @click="settings.toggleSidebar()"
    >
      <!-- 图标切换用纯 CSS animation（key 变化重挂载即重播），
           不依赖 transitionend 事件，避免 WKWebView 下卡住后图标消失 -->
      <PanelLeftClose
        v-if="!collapsed"
        :key="'open'"
        class="icon-swap"
        :size="15"
        :stroke-width="1.75"
      />
      <PanelLeft
        v-else
        :key="'closed'"
        class="icon-swap"
        :size="15"
        :stroke-width="1.75"
      />
    </button>
    <div class="drag-fill" data-tauri-drag-region />
    <!-- 全局项目标题：项目名（粗）+ 路径（淡灰），点击复制完整路径；
         light 模式显示当前独立文件名与路径 -->
    <button
      type="button"
      class="project-title"
      :disabled="!titlePath"
      :title="titlePath ? t('title.copyPath') : ''"
      :aria-label="titlePath"
      data-tauri-drag-region="false"
      @click="copyProjectPath"
    >
      <span class="project-name" data-tauri-drag-region>{{ projectTitle }}</span>
      <span v-if="titlePath" class="project-sep" data-tauri-drag-region>·</span>
      <span v-if="titlePath" class="project-path" data-tauri-drag-region>{{ titlePath }}</span>
      <Transition name="copied" mode="out-in">
        <Check v-if="copied" :size="12" class="copy-check" />
        <Copy v-else-if="titlePath" :size="12" class="copy-icon" />
      </Transition>
    </button>
    <div class="drag-fill" data-tauri-drag-region />
    <UpdateBadge />
  </header>
</template>

<style scoped>
.titlebar {
  height: var(--titlebar-height);
  /* 杀掉 <header> UA 默认 margin: 1em 0（约 13px），否则会撑高标题栏
     导致原生红绿灯（垂直中线 19pt）与 .titlebar 内的折叠按钮（被挤到 ~32pt）错位 */
  margin: 0;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  /* 与左侧红绿灯 x:14（window_chrome.rs TRAFFIC_LIGHT_X）对称的右侧留白，
     让右上角终端按钮离窗口右边缘 14pt（红绿灯离左也是 14pt） */
  padding-right: 14px;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--bg-header) 92%, var(--text-primary) 8%),
    var(--bg-header)
  );
  border-bottom: 1px solid var(--border-subtle);
  box-shadow: 0 1px 0 color-mix(in srgb, var(--bg-header) 55%, transparent);
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

.sidebar-btn {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  transition: background var(--transition-fast), color var(--transition-fast);
}

.sidebar-btn:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

/* 全局项目标题：可点击整行复制路径；内部文字继续走 data-tauri-drag-region 让标题栏可拖 */
.project-title {
  flex-shrink: 0;
  min-width: 0;
  max-width: 50%;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1;
  background: transparent;
  border: none;
  cursor: default;
  transition: background var(--transition-fast), color var(--transition-fast);
  /* 标题区域默认吃掉点击作为拖拽，但 button 本身可点；按钮禁用时不响应事件 */
  -webkit-app-region: no-drag;
}
.project-title:not(:disabled):hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}
.project-name {
  font-weight: 600;
  white-space: nowrap;
  -webkit-app-region: drag;
}
.project-sep {
  color: var(--text-muted);
  -webkit-app-region: drag;
}
.project-path {
  color: var(--text-muted);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  -webkit-app-region: drag;
}
.copy-icon,
.copy-check {
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--transition-fast);
  -webkit-app-region: no-drag;
}
.project-title:hover .copy-icon {
  opacity: 0.7;
}
.copy-check {
  color: #34d399;
  opacity: 1;
}

/* icon crossfade：sidebar 折叠按钮切换（纯 CSS animation，
   不依赖 transitionend，WKWebView 失焦/遮挡下不会卡住导致图标消失） */
.icon-swap {
  animation: icon-swap-in var(--transition-fast) var(--ease-out);
}

@keyframes icon-swap-in {
  from {
    opacity: 0;
    transform: rotate(-90deg) scale(0.85);
  }
}

/* 复制成功 tick 淡入淡出 */
.copied-enter-active,
.copied-leave-active {
  transition: opacity var(--transition-fast) var(--ease-out),
    transform var(--transition-fast) var(--ease-out);
}
.copied-enter-from,
.copied-leave-to {
  opacity: 0;
  transform: scale(0.6);
}

.drag-fill {
  flex: 1;
  height: 100%;
  min-width: 0;
}
</style>
