<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { PLAIN_INPUT_ATTRS } from "@/shared/plainInput";
import {
  registerPromptHandler,
  type PromptDialogOptions,
} from "@/shared/promptDialog";
import { t } from "@/i18n";

const visible = ref(false);
const title = ref("");
const label = ref("");
const placeholder = ref("");
const confirmText = ref("");
const cancelText = ref("");
const value = ref("");
const inputRef = ref<HTMLInputElement | null>(null);

let resolveFn: ((result: string | null) => void) | null = null;

async function open(options: PromptDialogOptions): Promise<string | null> {
  if (resolveFn) {
    resolveFn(null);
    resolveFn = null;
  }
  title.value = options.title;
  label.value = options.label ?? "";
  placeholder.value = options.placeholder ?? "";
  confirmText.value = options.confirmText ?? t("dialog.ok");
  cancelText.value = options.cancelText ?? t("dialog.cancel");
  value.value = options.defaultValue ?? "";
  visible.value = true;
  await nextTick();
  inputRef.value?.focus();
  inputRef.value?.select();
  return new Promise((resolve) => {
    resolveFn = resolve;
  });
}

function finish(result: string | null) {
  visible.value = false;
  const fn = resolveFn;
  resolveFn = null;
  fn?.(result);
}

function onConfirm() {
  const text = value.value.trim();
  if (!text) return;
  finish(text);
}

function onCancel() {
  finish(null);
}

function onKeydown(event: KeyboardEvent) {
  if (!visible.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    onCancel();
  }
}

onMounted(() => {
  registerPromptHandler(open);
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  registerPromptHandler(null);
  window.removeEventListener("keydown", onKeydown);
  if (resolveFn) finish(null);
});
</script>

<template>
  <div
    v-if="visible"
    class="overlay"
    @mousedown.self="onCancel"
  >
    <div class="dialog" role="dialog" aria-modal="true" :aria-label="title">
      <h3 class="title">{{ title }}</h3>
      <label v-if="label" class="label">{{ label }}</label>
      <input
        ref="inputRef"
        v-model="value"
        v-bind="PLAIN_INPUT_ATTRS"
        class="ui-input"
        type="text"
        name="prism-prompt"
        :placeholder="placeholder"
        @keydown.enter.prevent="onConfirm"
      />
      <div class="actions">
        <button type="button" class="btn ghost" @click="onCancel">
          {{ cancelText }}
        </button>
        <button
          type="button"
          class="btn primary"
          :disabled="!value.trim()"
          @click="onConfirm"
        >
          {{ confirmText }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  animation: prism-overlay-in var(--transition-normal) var(--ease-out);
  padding: 24px;
}

.dialog {
  width: min(420px, 100%);
  animation: prism-dialog-in var(--transition-normal) var(--ease-out);
  padding: 18px 18px 14px;
  border-radius: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.label {
  font-size: 12px;
  color: var(--text-muted);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.btn {
  height: 32px;
  padding: 0 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
}

.btn.ghost {
  color: var(--text-secondary);
}

.btn.ghost:hover {
  background: var(--accent-soft);
  color: var(--text-primary);
}

.btn.primary {
  background: var(--accent);
  color: var(--accent-fg);
}

.btn.primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
