<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "@/i18n";
import { PLAIN_INPUT_ATTRS } from "@/shared/plainInput";
import {
  registerInteractiveRebaseHandler,
  type InteractiveRebaseOptions,
} from "@/shared/gitRebaseDialog";
import type { GitRebaseStep } from "@/shared/gitApi";
import { useGitStore } from "@/stores/git";

interface Row {
  commitId: string;
  action: string;
  message: string;
  author: string;
  time: string;
}

const { t } = useI18n();
const git = useGitStore();
const visible = ref(false);
const title = ref("");
const onto = ref("");
const rows = ref<Row[]>([]);
const loading = ref(false);
const dragIndex = ref<number | null>(null);

let resolveFn: ((started: boolean) => void) | null = null;

const ACTIONS = ["pick", "reword", "squash", "fix", "drop"] as const;

async function open(options: InteractiveRebaseOptions): Promise<boolean> {
  if (resolveFn) {
    resolveFn(false);
    resolveFn = null;
  }
  title.value = options.title ?? t("interactiveRebase.title");
  onto.value = options.onto;
  visible.value = true;
  loading.value = true;
  rows.value = [];
  await nextTick();
  const commits = await git.loadRebasePlan(options.onto);
  rows.value = commits.map((c) => ({
    commitId: c.id,
    action: "pick",
    message: c.summary,
    author: c.author,
    time: c.time,
  }));
  loading.value = false;
  return new Promise((resolve) => {
    resolveFn = resolve;
  });
}

function finish(started: boolean) {
  visible.value = false;
  const fn = resolveFn;
  resolveFn = null;
  fn?.(started);
}

function onCancel() {
  finish(false);
}

async function onStart() {
  if (!rows.value.length) {
    finish(false);
    return;
  }
  const steps: GitRebaseStep[] = rows.value.map((r) => ({
    action: r.action,
    commitId: r.commitId,
    message: r.message,
  }));
  finish(true);
  await git.startInteractiveRebase(onto.value, steps);
}

function onDragStart(index: number) {
  dragIndex.value = index;
}

function onDrop(index: number) {
  if (dragIndex.value == null || dragIndex.value === index) {
    dragIndex.value = null;
    return;
  }
  const list = [...rows.value];
  const [item] = list.splice(dragIndex.value, 1);
  if (!item) {
    dragIndex.value = null;
    return;
  }
  list.splice(index, 0, item);
  rows.value = list;
  dragIndex.value = null;
}

function onKeydown(event: KeyboardEvent) {
  if (!visible.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    onCancel();
  }
}

onMounted(() => {
  registerInteractiveRebaseHandler(open);
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  registerInteractiveRebaseHandler(null);
  window.removeEventListener("keydown", onKeydown);
  if (resolveFn) finish(false);
});
</script>

<template>
  <div v-if="visible" class="overlay" @mousedown.self="onCancel">
    <div class="dialog" role="dialog" aria-modal="true" :aria-label="title">
      <h3 class="title">{{ title }}</h3>
      <p class="hint">
        {{ t("interactiveRebase.hint", { onto: onto.slice(0, 12) }) }}
      </p>

      <div v-if="loading" class="empty">{{ t("interactiveRebase.loading") }}</div>
      <div v-else-if="!rows.length" class="empty">{{ t("interactiveRebase.empty") }}</div>
      <div v-else class="list">
        <div
          v-for="(row, index) in rows"
          :key="row.commitId"
          class="row"
          draggable="true"
          @dragstart="onDragStart(index)"
          @dragover.prevent
          @drop="onDrop(index)"
        >
          <span class="grip" :title="t('interactiveRebase.dragTitle')">⋮⋮</span>
          <select v-model="row.action" class="action">
            <option v-for="a in ACTIONS" :key="a" :value="a">{{ a }}</option>
          </select>
          <code class="id">{{ row.commitId.slice(0, 7) }}</code>
          <input
            v-model="row.message"
            v-bind="PLAIN_INPUT_ATTRS"
            class="msg"
            type="text"
            :disabled="row.action === 'drop' || row.action === 'fix'"
          />
          <span class="meta">{{ row.author }}</span>
        </div>
      </div>

      <div class="actions">
        <button type="button" class="btn ghost" @click="onCancel">{{ t("common.cancel") }}</button>
        <button
          type="button"
          class="btn primary"
          :disabled="loading || !rows.length"
          @click="onStart"
        >
          {{ t("interactiveRebase.start") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 85;
  display: grid;
  place-items: center;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  animation: prism-overlay-in var(--transition-normal) var(--ease-out);
  padding: 24px;
}
.dialog {
  width: min(720px, 100%);
  animation: prism-dialog-in var(--transition-normal) var(--ease-out);
  max-height: min(80vh, 640px);
  padding: 16px;
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
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}
.hint code {
  color: var(--accent);
  font-family: var(--font-mono);
}
.empty {
  padding: 24px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}
.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.row {
  display: grid;
  grid-template-columns: 18px 88px 64px 1fr auto;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--bg-app);
  border: 1px solid var(--border-subtle);
}
.grip {
  color: var(--text-muted);
  cursor: grab;
  font-size: 11px;
  user-select: none;
}
.action {
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-size: 12px;
}
.id {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--accent);
}
.msg {
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-size: 12px;
  min-width: 0;
}
.msg:disabled {
  opacity: 0.5;
}
.meta {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
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
.btn.primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
