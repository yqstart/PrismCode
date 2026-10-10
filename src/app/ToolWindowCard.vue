<script setup lang="ts">
// ==================== IDEA 工具窗口外壳 ====================
// 工具窗口统一外壳：标题行（名称 + 附加动作 + ⋮ 菜单 + 隐藏按钮）+ 内容区。
// 各工具窗口只负责内容；标题排版、⋮ 菜单（隐藏 / 重置尺寸）与隐藏行为在这里统一，
// 保证 Project / Commit / Terminal / Problems / Debug / Spring 呈现同一套视觉语言。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { More, X } from "reicon-vue";
import { useSettingsStore } from "@/stores/settings";
import { useI18n } from "@/i18n";

const props = defineProps<{
  /** 标题行文案（工具窗口名称） */
  title: string;
  /** 所属区域：提供「重置尺寸」菜单项（不传则菜单只有隐藏） */
  resetArea?: "left" | "bottom" | "right";
}>();

const emit = defineEmits<{
  /** 点击隐藏按钮（✕）或菜单「隐藏」：收起当前工具窗口 */
  close: [];
}>();

const { t } = useI18n();
const settings = useSettingsStore();

/** 所属区是否处于最大化（IDEA Maximize Tool Window） */
const maximized = computed(() =>
  props.resetArea ? settings.layout[props.resetArea].maximized : false,
);

function toggleMaximize() {
  menuOpen.value = false;
  if (!props.resetArea) return;
  settings.toggleToolWindowMaximize(props.resetArea);
}

const menuOpen = ref(false);
const menuBtn = ref<HTMLButtonElement | null>(null);
const menuStyle = ref<Record<string, string>>({});

async function toggleMenu() {
  if (menuOpen.value) {
    menuOpen.value = false;
    return;
  }
  menuOpen.value = true;
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const el = menuBtn.value;
  if (el) {
    const rect = el.getBoundingClientRect();
    menuStyle.value = {
      left: `${rect.right - 180}px`,
      top: `${rect.bottom + 4}px`,
    };
  }
}

function hide() {
  menuOpen.value = false;
  emit("close");
}

function resetSize() {
  menuOpen.value = false;
  if (props.resetArea) settings.resetToolWindowSize(props.resetArea);
}

function onDocPointer(event: MouseEvent) {
  if (!menuOpen.value) return;
  const target = event.target as Node | null;
  if (menuBtn.value?.contains(target)) return;
  const menu = document.getElementById("prism-toolwindow-menu");
  if (menu?.contains(target)) return;
  menuOpen.value = false;
}

function onKey(event: KeyboardEvent) {
  if (event.key === "Escape") menuOpen.value = false;
}

onMounted(() => {
  document.addEventListener("mousedown", onDocPointer);
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", () => (menuOpen.value = false));
});

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocPointer);
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <section class="tool-window">
    <header class="tw-header">
      <span class="tw-title">{{ title }}</span>
      <div class="tw-actions">
        <slot name="actions" />
        <button
          ref="menuBtn"
          type="button"
          class="tw-icon-btn"
          :title="t('toolWindow.more')"
          :aria-label="t('toolWindow.more')"
          :aria-expanded="menuOpen"
          @click="toggleMenu"
        >
          <More :size="14" />
        </button>
        <button
          type="button"
          class="tw-icon-btn"
          :title="t('toolWindow.hide')"
          :aria-label="t('toolWindow.hide')"
          @click="emit('close')"
        >
          <X :size="14" />
        </button>
      </div>
    </header>
    <div class="tw-body">
      <slot />
    </div>
  </section>

  <Teleport to="body">
    <Transition name="popover">
      <div
        v-if="menuOpen"
        id="prism-toolwindow-menu"
        class="tw-menu"
        :style="menuStyle"
        role="menu"
      >
        <button type="button" class="tw-menu-row" @click="hide">
          {{ t("toolWindow.hide") }}
        </button>
        <button
          v-if="resetArea"
          type="button"
          class="tw-menu-row"
          @click="toggleMaximize"
        >
          {{
            maximized ? t("toolWindow.restore") : t("toolWindow.maximize")
          }}
        </button>
        <button
          v-if="resetArea"
          type="button"
          class="tw-menu-row"
          @click="resetSize"
        >
          {{ t("toolWindow.resetSize") }}
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.tool-window {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  overflow: hidden;
}

/* IDEA ToolWindow.Header：标题行高度 32px */
.tw-header {
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px 0 10px;
  border-bottom: 1px solid var(--border-subtle);
  user-select: none;
}

.tw-title {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tw-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.tw-icon-btn {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  display: grid;
  place-items: center;
  color: var(--text-muted);
  transition: background var(--transition-fast), color var(--transition-fast);
}

.tw-icon-btn:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.tw-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ⋮ 菜单：与工具栏下拉同一套浮层样式 */
.tw-menu {
  position: fixed;
  z-index: 70;
  min-width: 180px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  transform-origin: top right;
}

.tw-menu-row {
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  transition: background var(--transition-fast), color var(--transition-fast);
}

.tw-menu-row:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
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
