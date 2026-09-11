<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { ImportPatch } from "@/shared/importReferences";
import {
  registerMoveReferencesHandler,
  type MoveReferencesDialogOptions,
} from "@/shared/moveReferencesDialog";
import { relativeToRoot } from "@/shared/fs";
import { useWorkspaceStore } from "@/stores/workspace";
import { useI18n } from "@/i18n";

const { t } = useI18n();
const workspace = useWorkspaceStore();

const visible = ref(false);
const title = ref("");
const hint = ref("");
const confirmText = ref("");
const cancelText = ref("");
const patches = ref<ImportPatch[]>([]);
const selected = ref<Set<string>>(new Set());
const panelRef = ref<HTMLElement | null>(null);

let resolveFn: ((result: ImportPatch[] | null) => void) | null = null;

const allSelected = computed(
  () =>
    patches.value.length > 0 &&
    patches.value.every((p) => selected.value.has(p.id)),
);

async function open(options: MoveReferencesDialogOptions): Promise<ImportPatch[] | null> {
  if (resolveFn) {
    resolveFn(null);
    resolveFn = null;
  }
  title.value = options.title;
  hint.value = options.hint;
  confirmText.value = options.confirmText;
  cancelText.value = options.cancelText;
  patches.value = options.patches;
  selected.value = new Set(options.patches.map((p) => p.id));
  visible.value = true;
  await nextTick();
  panelRef.value?.querySelector<HTMLButtonElement>("button.btn.primary")?.focus();
  return new Promise((resolve) => {
    resolveFn = resolve;
  });
}

function finish(result: ImportPatch[] | null) {
  visible.value = false;
  const fn = resolveFn;
  resolveFn = null;
  fn?.(result);
}

function onConfirm() {
  const picked = patches.value.filter((p) => selected.value.has(p.id));
  finish(picked.length ? picked : null);
}

function onCancel() {
  finish(null);
}

function toggleAll() {
  if (allSelected.value) {
    selected.value = new Set();
  } else {
    selected.value = new Set(patches.value.map((p) => p.id));
  }
}

function toggleOne(id: string) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function relPath(abs: string): string {
  const root = workspace.rootPath;
  if (!root) return abs;
  return relativeToRoot(root, abs);
}

function onKeydown(event: KeyboardEvent) {
  if (!visible.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    onCancel();
  }
}

onMounted(() => {
  registerMoveReferencesHandler(open);
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  registerMoveReferencesHandler(null);
  window.removeEventListener("keydown", onKeydown);
  if (resolveFn) finish(null);
});
</script>

<template>
  <div v-if="visible" class="overlay" @mousedown.self="onCancel">
    <div ref="panelRef" class="panel" @click.stop>
      <header class="head">
        <h3>{{ title }}</h3>
        <p class="hint">{{ hint }}</p>
      </header>

      <div class="toolbar">
        <button type="button" class="link" @click="toggleAll">
          {{ allSelected ? t("moveReferences.deselectAll") : t("moveReferences.selectAll") }}
        </button>
        <span class="count">{{ t("moveReferences.count", { count: selected.size }) }}</span>
      </div>

      <ul class="list">
        <li v-for="item in patches" :key="item.id" class="row">
          <label class="check-wrap">
            <input
              type="checkbox"
              :checked="selected.has(item.id)"
              @change="toggleOne(item.id)"
            />
            <span class="meta">
              <span class="file">{{ relPath(item.file) }}</span>
              <span class="line">{{ t("moveReferences.line", { line: item.line }) }}</span>
              <code class="change">{{ item.oldSpec }} → {{ item.newSpec }}</code>
              <span v-if="item.preview" class="preview">{{ item.preview }}</span>
            </span>
          </label>
        </li>
      </ul>

      <footer class="actions">
        <button type="button" class="btn" @click="onCancel">{{ cancelText }}</button>
        <button
          type="button"
          class="btn primary"
          :disabled="!selected.size"
          @click="onConfirm"
        >
          {{ confirmText }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: center;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  animation: prism-overlay-in var(--transition-normal) var(--ease-out);
}

.panel {
  width: min(560px, calc(100vw - 32px));
  animation: prism-dialog-in var(--transition-normal) var(--ease-out);
  max-height: min(70vh, 640px);
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
}

.head {
  padding: 16px 18px 8px;
}

.head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.45;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 18px 8px;
  font-size: 12px;
}

.link {
  color: var(--accent);
}

.count {
  color: var(--text-muted);
}

.list {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0 10px;
  overflow: auto;
  list-style: none;
}

.row {
  border-radius: 8px;
}

.row:hover {
  background: var(--accent-soft);
}

.check-wrap {
  display: flex;
  gap: 10px;
  padding: 8px;
  cursor: pointer;
}

.meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.file {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.line {
  font-size: 11px;
  color: var(--text-muted);
}

.change {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--accent);
}

.preview {
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px 16px;
  border-top: 1px solid var(--border-subtle);
}

.btn {
  height: 32px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-app);
  color: var(--text-primary);
}

.btn.primary {
  background: var(--accent);
  border-color: transparent;
  color: var(--accent-fg);
}

.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
