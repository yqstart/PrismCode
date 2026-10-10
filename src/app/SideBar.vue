<script setup lang="ts">
import { onBeforeUnmount } from "vue";
import { storeToRefs } from "pinia";
import { useSettingsStore } from "@/stores/settings";
import ExplorerPanel from "@/features/explorer/ExplorerPanel.vue";
import CommitPanel from "@/features/git/CommitPanel.vue";
import { useI18n } from "@/i18n";

const { t } = useI18n();
const settings = useSettingsStore();
const { layout } = storeToRefs(settings);

let dragging = false;
/** 拖拽期间挂在 window 上的监听，卸载时必须移除 */
let cleanupDrag: (() => void) | null = null;

function onResizeStart(event: MouseEvent) {
  if (event.button !== 0) return;
  // 取消浏览器默认文本选区，避免拖动侧栏时选中面板内容
  event.preventDefault();
  dragging = true;
  const startX = event.clientX;
  const startWidth = layout.value.sidebarWidth;
  const previousUserSelect = document.body.style.getPropertyValue("user-select");
  const previousWebkitUserSelect = document.body.style.getPropertyValue(
    "-webkit-user-select",
  );

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    settings.setSidebarWidth(startWidth + (e.clientX - startX));
  };

  const onUp = () => {
    dragging = false;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
    document.body.style.setProperty("user-select", previousUserSelect);
    document.body.style.setProperty(
      "-webkit-user-select",
      previousWebkitUserSelect,
    );
    cleanupDrag = null;
  };

  document.body.style.cursor = "col-resize";
  document.body.style.setProperty("user-select", "none");
  document.body.style.setProperty("-webkit-user-select", "none");
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  cleanupDrag = onUp;
}

onBeforeUnmount(() => {
  // 拖拽中侧栏被收起（组件 v-if 卸载）或鼠标在窗口外释放：
  // 清理监听并复位全局样式，避免 cursor/userSelect 永久残留
  if (cleanupDrag) cleanupDrag();
});
</script>

<template>
  <!-- 侧边栏显隐使用 v-show + 纯 CSS animation，而不是 Vue Transition：
       前者由渲染引擎驱动、display 切换立即可见，不依赖 transitionend 事件；
       后者在 WKWebView 窗口失焦/遮挡时过渡事件会丢失，导致侧边栏
       卡在收起态「消失后点不出来」。 -->
  <aside
    v-show="!layout.sidebarCollapsed"
    class="sidebar"
    :style="{ width: `${layout.sidebarWidth}px` }"
    :aria-label="t('app.sidebar')"
  >
    <KeepAlive>
      <ExplorerPanel
        v-if="layout.activePanel === 'explorer'"
        key="explorer"
      />
      <CommitPanel
        v-else-if="layout.activePanel === 'commit'"
        key="commit"
      />
    </KeepAlive>
    <div
      class="resizer"
      :title="t('app.resizeSidebar')"
      @mousedown="onResizeStart"
    />
  </aside>
</template>

<style scoped>
.sidebar {
  position: relative;
  height: 100%;
  flex-shrink: 0;
  background: var(--bg-panel);
  border-right: 1px solid var(--border-subtle);
  min-width: 200px;
  max-width: 520px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* 展开动画：display:none → 显示时 animation 自动从头播放，
     播放结束元素自然停在终态；动画被暂停/跳过也不会影响最终可见性 */
  animation: sidebar-reveal var(--transition-medium) var(--ease-out);
}

@keyframes sidebar-reveal {
  from {
    opacity: 0;
    transform: translateX(-8px);
  }
}

.sidebar > :deep(*) {
  flex-shrink: 0;
}

.resizer {
  position: absolute;
  top: 0;
  right: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 2;
}

/* ==================== 面板头对齐 IDEA New UI ====================
   面板头样式由 ExplorerPanel / CommitPanel 自身定义，这里在侧栏容器上统一收口：
   标题 12px 常规字重 / --text-primary（去掉大写与字距），操作图标 hover 用 4px 圆角灰块。
   头部高度两个面板均为 36px，无需干预。 */
.sidebar :deep(.header .title) {
  font-weight: 400;
  letter-spacing: normal;
  text-transform: none;
  color: var(--text-primary);
}

.sidebar :deep(.header .icon-btn) {
  border-radius: 4px;
  transition:
    background var(--transition-fast) var(--ease-out),
    color var(--transition-fast) var(--ease-out);
}

.sidebar :deep(.header .icon-btn:hover:not(:disabled)) {
  background: var(--bg-hover);
  color: var(--text-primary);
}
</style>
