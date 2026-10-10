<script setup lang="ts">
import { storeToRefs } from "pinia";
import { X } from "reicon-vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { useI18n } from "@/i18n";

const { t } = useI18n();
const workspace = useWorkspaceStore();
const { toasts } = storeToRefs(workspace);

/** 点击 toast 操作按钮：执行回调后关闭该 toast */
function onAction(toast: { id: number; action?: { label: string; onClick: () => void } }) {
  try {
    toast.action?.onClick();
  } finally {
    workspace.dismissNotice(toast.id);
  }
}
</script>

<template>
  <TransitionGroup
    name="toast"
    tag="div"
    class="toast-host"
    aria-live="polite"
  >
    <div
      v-for="toast in toasts"
      :key="toast.id"
      class="toast"
      role="status"
    >
      <span class="toast-msg">{{ toast.message }}</span>
      <button
        v-if="toast.action"
        type="button"
        class="toast-action"
        @click="onAction(toast)"
      >
        {{ toast.action.label }}
      </button>
      <button
        type="button"
        class="toast-close"
        :aria-label="t('common.close')"
        :title="t('common.close')"
        @click="workspace.dismissNotice(toast.id)"
      >
        <X weight="Filled" :size="12" />
      </button>
    </div>
  </TransitionGroup>
</template>

<style scoped>
.toast-host {
  position: fixed;
  right: 16px;
  bottom: 44px;
  z-index: 200;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: none;
  max-width: min(420px, calc(100vw - 32px));
}

.toast {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px 9px 14px;
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  color: var(--text-primary);
  font-size: 12px;
  line-height: 1.4;
  pointer-events: auto;
}

.toast-msg {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toast-action {
  flex-shrink: 0;
  padding: 3px 10px;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--bg-elevated);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
  transition: opacity var(--transition-fast);
}

.toast-action:hover {
  opacity: 0.85;
}

.toast-close {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  display: grid;
  place-items: center;
  color: var(--text-muted);
  opacity: 0;
  transition: opacity var(--transition-fast), background var(--transition-fast),
    color var(--transition-fast);
}

.toast:hover .toast-close {
  opacity: 1;
}

.toast-close:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

/* TransitionGroup：滑入 + 淡出 */
.toast-enter-active,
.toast-leave-active {
  transition: opacity var(--transition-normal) var(--ease-out),
    transform var(--transition-normal) var(--ease-out);
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}

.toast-leave-active {
  position: absolute;
}

.toast-move {
  transition: transform var(--transition-normal) var(--ease-out);
}
</style>
