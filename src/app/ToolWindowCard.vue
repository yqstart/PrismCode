<script setup lang="ts">
// ==================== IDEA 工具窗口外壳 ====================
// 工具窗口统一外壳：标题行（名称 + 附加动作 + 隐藏按钮）+ 内容区。
// 各工具窗口只负责内容；标题排版与隐藏行为在这里统一，
// 保证 Project / Commit / Terminal / Problems / Debug 呈现同一套视觉语言。
import { X } from "lucide-vue-next";
import { useI18n } from "@/i18n";

defineProps<{
  /** 标题行文案（工具窗口名称） */
  title: string;
}>();

const emit = defineEmits<{
  /** 点击隐藏按钮：收起当前工具窗口 */
  close: [];
}>();

const { t } = useI18n();
</script>

<template>
  <section class="tool-window">
    <header class="tw-header">
      <span class="tw-title">{{ title }}</span>
      <div class="tw-actions">
        <slot name="actions" />
        <button
          type="button"
          class="tw-hide"
          :title="t('toolWindow.hide')"
          :aria-label="t('toolWindow.hide')"
          @click="emit('close')"
        >
          <X :size="14" :stroke-width="1.75" />
        </button>
      </div>
    </header>
    <div class="tw-body">
      <slot />
    </div>
  </section>
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

/* IDEA ToolWindow.Header：标题行高度 32px，hover 时显示隐藏动作 */
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

.tw-hide {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  display: grid;
  place-items: center;
  color: var(--text-muted);
  transition: background var(--transition-fast), color var(--transition-fast);
}

.tw-hide:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.tw-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
