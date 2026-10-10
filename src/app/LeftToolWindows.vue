<script setup lang="ts">
// ==================== 左侧工具窗口区 ====================
// 编辑器左侧的垂直工具窗口列（IDEA 布局）：Project / Commit 二选一显示。
// 列本身常驻挂载（v-show 收起），KeepAlive 保证收起再展开时面板状态不丢；
// 右缘拖拽调整列宽并持久化。
import { computed, onBeforeUnmount } from "vue";
import { storeToRefs } from "pinia";
import ToolWindowCard from "@/app/ToolWindowCard.vue";
import ExplorerPanel from "@/features/explorer/ExplorerPanel.vue";
import CommitPanel from "@/features/git/CommitPanel.vue";
import { useSettingsStore } from "@/stores/settings";
import { useI18n } from "@/i18n";

const { t } = useI18n();
const settings = useSettingsStore();
const { layout } = storeToRefs(settings);

const active = computed(() => layout.value.left.active);

let dragging = false;
/** 拖拽期间挂在 window 上的监听，卸载时必须移除 */
let cleanupDrag: (() => void) | null = null;

function onResizeStart(event: MouseEvent) {
  if (event.button !== 0) return;
  // 取消浏览器默认文本选区，避免拖动侧栏时选中面板内容
  event.preventDefault();
  dragging = true;
  const startX = event.clientX;
  const startWidth = layout.value.left.width;
  const previousUserSelect = document.body.style.getPropertyValue("user-select");
  const previousWebkitUserSelect = document.body.style.getPropertyValue(
    "-webkit-user-select",
  );

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    settings.setLeftWidth(startWidth + (e.clientX - startX));
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
  // 拖拽中组件被卸载或鼠标在窗口外释放：清理监听并复位全局样式
  if (cleanupDrag) cleanupDrag();
});
</script>

<template>
  <div
    v-show="active"
    class="left-area"
    :class="{ maximized: layout.left.maximized }"
    :style="
      layout.left.maximized ? undefined : { width: `${layout.left.width}px` }
    "
  >
    <ToolWindowCard
      reset-area="left"
      :title="active === 'commit' ? t('toolWindow.commitTitle') : t('activity.explorer')"
      @close="settings.setLeftWindow(null)"
    >
      <KeepAlive>
        <ExplorerPanel v-if="active === 'project'" key="project" />
        <CommitPanel v-else key="commit" />
      </KeepAlive>
    </ToolWindowCard>
    <div
      class="resizer"
      :title="t('app.resizeSidebar')"
      @mousedown="onResizeStart"
    />
  </div>
</template>

<style scoped>
.left-area {
  position: relative;
  height: 100%;
  flex-shrink: 0;
  min-width: 200px;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border-right: 1px solid var(--border-subtle);
}

/* 最大化：铺满工作区（宽度由 flex 决定，可拖拽的 resizer 隐藏） */
.left-area.maximized {
  flex: 1 1 auto;
  min-width: 0;
}

.left-area.maximized .resizer {
  display: none;
}

.resizer {
  position: absolute;
  top: 0;
  right: -2px;
  width: 4px;
  height: 100%;
  cursor: col-resize;
  z-index: 5;
}

.resizer:hover {
  background: var(--accent-soft);
}
</style>
