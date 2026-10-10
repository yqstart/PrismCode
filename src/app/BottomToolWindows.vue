<script setup lang="ts">
// ==================== 底部工具窗口区 ====================
// 编辑器下方的水平工具窗口区（IDEA 布局）：Terminal / Problems / Debug 三选一显示。
// 区域常驻挂载（v-show 收起）：终端会话与 PTY 在切换视图、收起区域时都保持存活，
// 只有关闭全部终端标签才销毁。顶缘拖拽调整区高并持久化。
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import ToolWindowCard from "@/app/ToolWindowCard.vue";
import DebugPanel from "@/features/debug/DebugPanel.vue";
import ProblemsPanel from "@/features/problems/ProblemsPanel.vue";
import SessionsView from "@/features/sessions/SessionsView.vue";
import { useSessionsStore } from "@/stores/sessions";
import { useSettingsStore } from "@/stores/settings";
import { useI18n } from "@/i18n";

const { t } = useI18n();
const settings = useSettingsStore();
const sessions = useSessionsStore();
const { layout } = storeToRefs(settings);

const active = computed(() => layout.value.bottom.active);
/** 区域是否有内容可显示（终端视图要求已创建会话，避免提前拉起 xterm） */
const terminalReady = computed(() => sessions.mounted);

/** 首次访问才挂载，之后 v-show 保活（问题/调试面板的展开状态不丢） */
const problemsVisited = ref(false);
const debugVisited = ref(false);
watch(
  active,
  (value) => {
    if (value === "problems") problemsVisited.value = true;
    if (value === "debug") debugVisited.value = true;
  },
  { immediate: true },
);

function hide() {
  settings.setBottomWindow(null);
}

function notifyTerminalHidden() {
  // 收起底部区域时终端不结束会话（保活语义与 ⌘J 一致）
  sessions.blurSessions();
  hide();
}

let dragging = false;
let cleanupDrag: (() => void) | null = null;

function onResizeStart(event: MouseEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  dragging = true;
  const startY = event.clientY;
  const startHeight = layout.value.bottom.height;
  const previousUserSelect = document.body.style.getPropertyValue("user-select");

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    // 鼠标上移（startY - clientY > 0）时区域变高
    settings.setBottomHeight(startHeight + (startY - e.clientY));
  };

  const onUp = () => {
    dragging = false;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
    document.body.style.setProperty("user-select", previousUserSelect);
    cleanupDrag = null;
  };

  document.body.style.cursor = "row-resize";
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
    class="bottom-area"
    :style="{ height: `${layout.bottom.height}px` }"
  >
    <div
      class="resizer"
      role="separator"
      aria-orientation="horizontal"
      :aria-label="t('app.resizeBottomArea')"
      @mousedown="onResizeStart"
    />

    <ToolWindowCard
      reset-area="bottom"
      v-if="terminalReady"
      v-show="active === 'terminal'"
      class="bottom-window"
      :title="t('terminal.title')"
      @close="notifyTerminalHidden"
    >
      <SessionsView />
    </ToolWindowCard>

    <ToolWindowCard
      reset-area="bottom"
      v-if="problemsVisited"
      v-show="active === 'problems'"
      class="bottom-window"
      :title="t('problems.tab')"
      @close="hide"
    >
      <ProblemsPanel />
    </ToolWindowCard>

    <ToolWindowCard
      reset-area="bottom"
      v-if="debugVisited"
      v-show="active === 'debug'"
      class="bottom-window"
      :title="t('debug.tab')"
      @close="hide"
    >
      <DebugPanel />
    </ToolWindowCard>
  </div>
</template>

<style scoped>
.bottom-area {
  position: relative;
  flex-shrink: 0;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border-top: 1px solid var(--border-subtle);
  /* 防御：小窗口下区高上限以窗口剩余空间为界 */
  max-height: calc(100vh - var(--titlebar-height) - var(--status-bar-height) - 48px);
}

.bottom-window {
  flex: 1;
  min-height: 0;
}

.resizer {
  position: absolute;
  top: -2px;
  left: 0;
  width: 100%;
  height: 4px;
  cursor: row-resize;
  z-index: 5;
}

.resizer:hover {
  background: var(--accent-soft);
}
</style>
