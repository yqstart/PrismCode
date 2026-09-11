<script setup lang="ts">
import {
  computed,
  nextTick,
  ref,
  watch,
  type ComponentPublicInstance,
} from "vue";
import { Replace, Search, X } from "lucide-vue-next";
import { storeToRefs } from "pinia";
import { PLAIN_INPUT_ATTRS } from "@/shared/plainInput";
import { formatShortcut } from "@/shared/platform";
import { useI18n } from "@/i18n";
import { useEditorStore } from "@/stores/editor";
import { useSearchStore } from "@/stores/search";
import { getSearchKeyAction } from "@/features/search/navigation";

const { t } = useI18n();
const findShortcutHint = computed(
  () => t("search.styleHint", { shortcut: formatShortcut("mod", "shift", "F") }),
);
const resultShortcutHint = computed(
  () =>
    t("search.resultNavHint", {
      shortcut: formatShortcut("mod", "Enter"),
    }),
);

const search = useSearchStore();
const editor = useEditorStore();
const {
  contentQuery,
  replaceText,
  caseSensitive,
  extensions,
  contentResults,
  replacePreview,
  loading,
  findInFilesVisible,
} = storeToRefs(search);

const queryRef = ref<HTMLInputElement | null>(null);
const showReplace = ref(false);
const activeIndex = ref(0);
const rowElements = new Map<number, HTMLElement>();

watch(findInFilesVisible, async (open) => {
  if (!open) return;
  activeIndex.value = 0;
  await nextTick();
  queryRef.value?.focus();
  queryRef.value?.select();
});

watch(contentResults, () => {
  activeIndex.value = 0;
  rowElements.clear();
});

watch(activeIndex, async (index) => {
  await nextTick();
  rowElements.get(index)?.scrollIntoView({ block: "nearest" });
});

watch([contentQuery, replaceText, caseSensitive, extensions], () => {
  search.invalidateFindInFiles();
});

function close() {
  search.closeFindInFiles();
}

function onOverlay(event: MouseEvent) {
  if (event.target === event.currentTarget) close();
}

async function onSearch() {
  await search.runContentSearch();
}

async function onPreviewReplace() {
  showReplace.value = true;
  await search.previewReplace();
}

async function onApplyReplace() {
  if (!replacePreview.value) {
    await search.previewReplace();
  }
  if (!replacePreview.value?.replacements) return;
  const ok = window.confirm(
    t("search.replaceConfirm", {
      replacements: replacePreview.value.replacements,
      files: replacePreview.value.changedFiles,
    }),
  );
  if (!ok) return;
  await search.applyReplace();
}

async function openHit(index: number, keepOpen = false) {
  const hit = contentResults.value[index];
  if (!hit) return;
  await editor.openFileAt(hit.path, hit.line, hit.column);
  if (!keepOpen) close();
}

function setRowElement(
  element: Element | ComponentPublicInstance | null,
  index: number,
) {
  if (element instanceof HTMLElement) rowElements.set(index, element);
}

function onKeydown(event: KeyboardEvent) {
  const action = getSearchKeyAction(event, {
    hasResults: contentResults.value.length > 0,
    isQueryInput: document.activeElement === queryRef.value,
  });
  if (!action) return;

  event.preventDefault();
  if (action.type === "close") {
    close();
    return;
  }
  if (action.type === "move") {
    activeIndex.value = Math.max(
      0,
      Math.min(
        activeIndex.value + action.delta,
        Math.max(contentResults.value.length - 1, 0),
      ),
    );
    return;
  }
  if (action.type === "search") {
    void onSearch();
    return;
  }
  void openHit(activeIndex.value, action.keepOpen);
}
</script>

<template>
  <div
    v-if="findInFilesVisible"
    class="overlay"
    @mousedown="onOverlay"
    @keydown="onKeydown"
  >
    <div class="dialog" role="dialog" aria-modal="true" :aria-label="t('search.findInFiles')">
      <header class="header">
        <div class="title-row">
          <Search :size="18" class="title-icon" />
          <h1>{{ t("search.findInFiles") }}</h1>
          <span class="hint">{{ findShortcutHint }}</span>
        </div>
        <button type="button" class="icon-btn" :title="t('common.close')" @click="close">
          <X :size="18" />
        </button>
      </header>

      <div class="form">
        <label class="field">
          <span class="label">{{ t("search.findLabel") }}</span>
          <input
            ref="queryRef"
            v-model="contentQuery"
            v-bind="PLAIN_INPUT_ATTRS"
            class="ui-input"
            type="text"
            name="prism-find-query"
            :placeholder="t('search.findInputPlaceholder')"
          />
        </label>

        <div v-if="showReplace" class="field">
          <span class="label">{{ t("search.replacePlaceholder") }}</span>
          <div class="replace-row">
            <Replace :size="14" class="inline-icon" />
            <input
              v-model="replaceText"
              v-bind="PLAIN_INPUT_ATTRS"
              class="ui-input"
              type="text"
              name="prism-find-replace"
              :placeholder="t('search.replaceInputPlaceholder')"
            />
          </div>
        </div>

        <div class="options">
          <label class="check">
            <input v-model="caseSensitive" type="checkbox" />
            {{ t("search.caseSensitive") }}
          </label>
          <label class="field inline">
            <span class="label">{{ t("search.fileMask") }}</span>
            <input
              v-model="extensions"
              v-bind="PLAIN_INPUT_ATTRS"
              class="ui-input mask"
              type="text"
              name="prism-find-mask"
              :placeholder="t('search.fileMaskPlaceholder')"
            />
          </label>
          <div class="actions">
            <button
              type="button"
              class="btn ghost"
              @click="showReplace = !showReplace"
            >
              {{ showReplace ? t("search.hideReplace") : t("search.replace") }}
            </button>
            <button
              v-if="showReplace"
              type="button"
              class="btn ghost"
              :disabled="loading"
              @click="onPreviewReplace"
            >
              {{ t("search.preview") }}
            </button>
            <button
              v-if="showReplace"
              type="button"
              class="btn"
              :disabled="loading"
              @click="onApplyReplace"
            >
              {{ t("search.replaceAll") }}
            </button>
            <button
              type="button"
              class="btn"
              :disabled="loading || !contentQuery.trim()"
              @click="onSearch"
            >
              {{ loading ? t("search.searching") : t("search.find") }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="replacePreview" class="preview-banner">
        {{
          t("search.previewBanner", {
            replacements: replacePreview.replacements,
            files: replacePreview.changedFiles,
          })
        }}
        <span v-if="replacePreview.files.length">
          — {{ replacePreview.files.slice(0, 4).join(", ")
          }}{{ replacePreview.files.length > 4 ? "…" : "" }}
        </span>
      </div>

      <div class="results">
        <div class="results-meta">
          <template v-if="loading">{{ t("search.searchingProject") }}</template>
          <template v-else-if="contentResults.length">
            {{ t("search.matchCount", { count: contentResults.length }) }}
            <span class="meta-hint">{{ resultShortcutHint }}</span>
          </template>
          <template v-else-if="contentQuery.trim()">{{ t("search.noMatch") }}</template>
          <template v-else>{{ t("search.findEmptyHint") }}</template>
        </div>

        <div class="list">
          <button
            v-for="(hit, index) in contentResults"
            :key="`${hit.path}:${hit.line}:${hit.column}`"
            :ref="(element) => setRowElement(element, index)"
            type="button"
            class="hit"
            :class="{ active: index === activeIndex }"
            @click="openHit(index)"
          >
            <span class="loc">{{ hit.relative }}:{{ hit.line }}</span>
            <span class="preview">{{ hit.preview }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: 32px;
  background: var(--bg-overlay);
  backdrop-filter: blur(6px);
  animation: prism-overlay-in var(--transition-normal) var(--ease-out);
}

.dialog {
  width: min(860px, 100%);
  animation: prism-dialog-in var(--transition-normal) var(--ease-out);
  height: min(640px, 100%);
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-xl);
  background: var(--bg-panel);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  overflow: hidden;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--border-subtle);
}

.title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.title-row h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
}

.title-icon {
  color: var(--accent);
}

.hint {
  font-size: 11px;
  color: var(--text-muted);
}

.icon-btn {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: var(--text-muted);
}

.icon-btn:hover {
  background: var(--accent-soft);
  color: var(--text-primary);
}

.form {
  padding: 14px 16px 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-bottom: 1px solid var(--border-subtle);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field.inline {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.label {
  font-size: 12px;
  color: var(--text-secondary);
  min-width: 48px;
}

.ui-input {
  width: 100%;
}

.replace-row {
  position: relative;
}

.inline-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
}

.replace-row .ui-input {
  padding-left: 32px;
}

.options {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 12px;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}

.mask {
  width: 180px;
}

.actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.btn {
  height: 32px;
  padding: 0 12px;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--accent-fg);
  font-weight: 600;
  font-size: 12px;
}

.btn.ghost {
  background: var(--accent-soft);
  color: var(--accent);
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.preview-banner {
  padding: 8px 16px;
  font-size: 12px;
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 12%, transparent);
  border-bottom: 1px solid var(--border-subtle);
}

.results {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.results-meta {
  padding: 8px 16px;
  font-size: 12px;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-subtle);
}

.meta-hint {
  margin-left: 10px;
  color: var(--text-muted);
  opacity: 0.85;
}

.list {
  flex: 1;
  overflow: auto;
  padding: 8px;
}

.hit {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 9px 12px;
  border-radius: 8px;
  text-align: left;
}

.hit:hover,
.hit.active {
  background: var(--accent-soft);
}

.loc {
  font-size: 12px;
  color: var(--accent);
  font-family: var(--font-mono);
}

.preview {
  font-size: 12px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
