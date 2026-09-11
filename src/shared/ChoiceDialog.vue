<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import {
  registerChoiceHandler,
  type ChoiceDialogOptions,
  type ChoiceOption,
} from "@/shared/choiceDialog";

const visible = ref(false);
const title = ref("");
const message = ref("");
const choices = ref<ChoiceOption[]>([]);
const dismissId = ref<string | null>(null);
const panelRef = ref<HTMLElement | null>(null);

let resolveFn: ((result: string | null) => void) | null = null;

async function open(options: ChoiceDialogOptions): Promise<string | null> {
  if (resolveFn) {
    resolveFn(null);
    resolveFn = null;
  }
  title.value = options.title;
  message.value = options.message;
  choices.value = options.choices;
  dismissId.value =
    options.dismissId === undefined ? null : options.dismissId;
  visible.value = true;
  await nextTick();
  panelRef.value
    ?.querySelector<HTMLButtonElement>("button.btn.primary, button.btn")
    ?.focus();
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

function onPick(id: string) {
  finish(id);
}

function onDismiss() {
  finish(dismissId.value);
}

function onKeydown(event: KeyboardEvent) {
  if (!visible.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    onDismiss();
  }
}

onMounted(() => {
  registerChoiceHandler(open);
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  registerChoiceHandler(null);
  window.removeEventListener("keydown", onKeydown);
  if (resolveFn) finish(null);
});
</script>

<template>
  <div
    v-if="visible"
    class="overlay"
    @mousedown.self="onDismiss"
  >
    <div
      ref="panelRef"
      class="dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
    >
      <h3 class="title">{{ title }}</h3>
      <p class="message">{{ message }}</p>
      <div class="actions">
        <button
          v-for="item in choices"
          :key="item.id"
          type="button"
          class="btn"
          :class="item.variant ?? 'ghost'"
          @click="onPick(item.id)"
        >
          {{ item.label }}
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
  width: min(440px, 100%);
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

.message {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
}

.actions {
  display: flex;
  flex-wrap: wrap;
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

.btn.danger {
  background: color-mix(in srgb, var(--danger) 18%, var(--bg-elevated));
  color: var(--danger);
}

.btn.danger:hover {
  background: color-mix(in srgb, var(--danger) 28%, var(--bg-elevated));
}
</style>
