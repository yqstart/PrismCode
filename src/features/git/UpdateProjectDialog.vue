<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "@/i18n";
import {
  registerUpdateDialogHandler,
  type UpdateStrategy,
} from "@/shared/gitDialogs";
import { useGitStore } from "@/stores/git";

const { t } = useI18n();
const visible = ref(false);
const strategy = ref<UpdateStrategy>("merge");
const git = useGitStore();
const { snapshot } = storeToRefs(git);

let resolveFn: ((r: UpdateStrategy | null) => void) | null = null;

async function open(): Promise<UpdateStrategy | null> {
  if (resolveFn) {
    resolveFn(null);
    resolveFn = null;
  }
  strategy.value = "merge";
  visible.value = true;
  return new Promise((resolve) => {
    resolveFn = resolve;
  });
}

function finish(result: UpdateStrategy | null) {
  visible.value = false;
  const fn = resolveFn;
  resolveFn = null;
  fn?.(result);
}

function onConfirm() {
  finish(strategy.value);
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
  registerUpdateDialogHandler(open);
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  registerUpdateDialogHandler(null);
  window.removeEventListener("keydown", onKeydown);
  if (resolveFn) finish(null);
});
</script>

<template>
  <div v-if="visible" class="overlay" @mousedown.self="onCancel">
    <div class="dialog" role="dialog" aria-modal="true" :aria-label="t('updateProject.title')">
      <h3 class="title">{{ t("updateProject.title") }}</h3>
      <p class="meta">
        {{ snapshot.branch ?? "—" }}
        <template v-if="snapshot.upstream"> ← {{ snapshot.upstream }}</template>
        <span v-if="snapshot.behind" class="behind">↓{{ snapshot.behind }}</span>
      </p>
      <p class="desc">{{ t("updateProject.desc") }}</p>

      <label class="radio">
        <input v-model="strategy" type="radio" value="merge" />
        <span>
          <strong>{{ t("updateProject.merge") }}</strong>
          <small>{{ t("updateProject.mergeDesc") }}</small>
        </span>
      </label>
      <label class="radio">
        <input v-model="strategy" type="radio" value="rebase" />
        <span>
          <strong>{{ t("updateProject.rebase") }}</strong>
          <small>{{ t("updateProject.rebaseDesc") }}</small>
        </span>
      </label>

      <div class="actions">
        <button type="button" class="btn ghost" @click="onCancel">{{ t("common.cancel") }}</button>
        <button type="button" class="btn primary" @click="onConfirm">
          {{ t("updateProject.confirm") }}
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
  padding: 18px;
  border-radius: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.meta {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
}
.behind {
  margin-left: 8px;
  color: var(--warning);
  font-weight: 600;
}
.desc {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
}
.radio {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-subtle);
  cursor: pointer;
}
.radio:has(input:checked) {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.radio span {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.radio strong {
  font-size: 13px;
  color: var(--text-primary);
}
.radio small {
  font-size: 11px;
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
}
.btn.primary {
  background: var(--accent);
  color: var(--accent-fg);
}
</style>
