<script setup lang="ts">
// ==================== 右侧工具窗口区 ====================
// 编辑器右侧的垂直工具窗口列（IDEA 布局）：Spring 端点等只读辅助面板。
// 列常驻挂载（v-show 收起），左缘拖拽调整列宽并持久化。
import { computed, onBeforeUnmount } from "vue";
import { storeToRefs } from "pinia";
import ToolWindowCard from "@/app/ToolWindowCard.vue";
import SpringEndpointsPanel from "@/features/java/SpringEndpointsPanel.vue";
import { useSettingsStore } from "@/stores/settings";
import { useI18n } from "@/i18n";

const { t } = useI18n();
const settings = useSettingsStore();
const { layout } = storeToRefs(settings);

const active = computed(() => layout.value.right.active);

let dragging = false;
/** 拖拽期间挂在 window 上的监听，卸载时必须移除 */
let cleanupDrag: (() => void) | null = null;

function onResizeStart(event: MouseEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  dragging = true;
  const startX = event.clientX;
  const startWidth = layout.value.right.width;
  const previousUserSelect = document.body.style.getPropertyValue("user-select");

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    // 鼠标左移（startX - clientX > 0）时右列变宽
    settings.setRightWidth(startWidth + (startX - e.clientX));
  };

  const onUp = () => {
    dragging = false;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
    document.body.style.setProperty("user-select", previousUserSelect);
    cleanupDrag = null;
  };

  document.body.style.cursor = "col-resize";
  document.body.style.setProperty("user-select", "none");
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  cleanupDrag = onUp;
}

onBeforeUnmount(() => {
  if (cleanupDrag) cleanupDrag();
});
</script>

<template>
  <div
    v-show="active"
    class="right-area"
    :style="{ width: `${layout.right.width}px` }"
  >
    <div
      class="resizer"
      :title="t('app.resizeSidebar')"
      @mousedown="onResizeStart"
    />
    <ToolWindowCard
      reset-area="right"
      :title="t('spring.endpoints.title')"
      @close="settings.setRightWindow(null)"
    >
      <SpringEndpointsPanel v-if="active === 'spring'" />
    </ToolWindowCard>
  </div>
</template>

<style scoped>
.right-area {
  position: relative;
  height: 100%;
  flex-shrink: 0;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border-left: 1px solid var(--border-subtle);
}

.resizer {
  position: absolute;
  top: 0;
  left: -2px;
  width: 4px;
  height: 100%;
  cursor: col-resize;
  z-index: 5;
}

.resizer:hover {
  background: var(--accent-soft);
}
</style>
