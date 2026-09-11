<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type ComponentPublicInstance,
} from "vue";
import { Search } from "lucide-vue-next";
import { storeToRefs } from "pinia";
import FileTypeIcon from "@/shared/FileTypeIcon.vue";
import { PLAIN_INPUT_ATTRS } from "@/shared/plainInput";
import {
  basename,
  isPathUnder,
  pathExists,
  relativeToRoot,
} from "@/shared/fs";
import type { FileSearchHit } from "@/shared/searchApi";
import {
  parseQuickOpenQuery,
  rankQuickOpenResults,
} from "@/features/search/quickOpen";
import { useI18n } from "@/i18n";
import { useEditorStore } from "@/stores/editor";
import { useSearchStore } from "@/stores/search";
import { useWorkspaceStore } from "@/stores/workspace";

const { t } = useI18n();
const search = useSearchStore();
const editor = useEditorStore();
const workspace = useWorkspaceStore();
const { fileQuery, fileResults, quickOpenVisible, loading } = storeToRefs(search);
const { recentPaths } = storeToRefs(editor);

const inputRef = ref<HTMLInputElement | null>(null);
const activeIndex = ref(0);
const verifiedRecentPaths = ref<string[]>([]);
const checkingRecent = ref(false);
const rowElements = new Map<number, HTMLElement>();
let searchTimer: number | null = null;
let recentCheckSeq = 0;

const parsedQuery = computed(() => parseQuickOpenQuery(fileQuery.value));
const recentResults = computed<FileSearchHit[]>(() => {
  const root = workspace.rootPath;
  if (!root) return [];
  return verifiedRecentPaths.value
    .map((path, index) => ({
      path,
      name: basename(path),
      relative: relativeToRoot(root, path),
      score: 1_000 - index,
    }));
});
const displayResults = computed(() =>
  parsedQuery.value.searchText
    ? rankQuickOpenResults(fileResults.value, recentPaths.value)
    : recentResults.value,
);

async function verifyRecentFiles() {
  const root = workspace.rootPath;
  const seq = ++recentCheckSeq;
  verifiedRecentPaths.value = [];
  checkingRecent.value = false;
  if (!root) return;
  const candidates = recentPaths.value.filter((path) =>
    isPathUnder(root, path),
  );
  checkingRecent.value = true;
  try {
    const checks = await Promise.all(
      candidates.map(async (path) => {
        try {
          return (await pathExists(root, path)) ? path : null;
        } catch {
          return null;
        }
      }),
    );
    if (seq === recentCheckSeq && workspace.rootPath === root) {
      verifiedRecentPaths.value = checks.filter(
        (path): path is string => path !== null,
      );
    }
  } finally {
    if (seq === recentCheckSeq) checkingRecent.value = false;
  }
}

watch(
  () => parsedQuery.value.searchText,
  (q) => {
    activeIndex.value = 0;
    search.invalidateFileSearch();
    if (!q) {
      if (searchTimer != null) window.clearTimeout(searchTimer);
      return;
    }
    // 防抖 150ms：连续输入时只发最后一次，避免每键一次全量搜索
    if (searchTimer != null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      void search.runFileSearch(q);
    }, 150);
  },
);

watch(displayResults, () => {
  activeIndex.value = 0;
  rowElements.clear();
});

watch(activeIndex, async (index) => {
  await nextTick();
  rowElements.get(index)?.scrollIntoView({ block: "nearest" });
});

watch(quickOpenVisible, async (open) => {
  if (open) {
    activeIndex.value = 0;
    void verifyRecentFiles();
    await nextTick();
    inputRef.value?.focus();
    inputRef.value?.select();
  }
});

function close() {
  search.closeQuickOpen();
}

async function openHit(index: number) {
  const hit = displayResults.value[index];
  if (!hit) return;
  close();
  const { line, column } = parsedQuery.value;
  if (line !== null) await editor.openFileAt(hit.path, line, column);
  else await editor.openFile(hit.path);
}

function setRowElement(
  element: Element | ComponentPublicInstance | null,
  index: number,
) {
  if (element instanceof HTMLElement) rowElements.set(index, element);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    activeIndex.value = Math.min(
      activeIndex.value + 1,
      Math.max(displayResults.value.length - 1, 0),
    );
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    activeIndex.value = Math.max(activeIndex.value - 1, 0);
    return;
  }
  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    activeIndex.value =
      event.key === "Home"
        ? 0
        : Math.max(displayResults.value.length - 1, 0);
    return;
  }
  if (event.key === "PageDown" || event.key === "PageUp") {
    event.preventDefault();
    const delta = event.key === "PageDown" ? 8 : -8;
    activeIndex.value = Math.max(
      0,
      Math.min(displayResults.value.length - 1, activeIndex.value + delta),
    );
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    if (displayResults.value.length) {
      void openHit(activeIndex.value);
    }
  }
}

onMounted(() => {
  if (quickOpenVisible.value) {
    inputRef.value?.focus();
  }
});

onBeforeUnmount(() => {
  if (searchTimer != null) window.clearTimeout(searchTimer);
});
</script>

<template>
  <div v-if="quickOpenVisible" class="overlay" @mousedown.self="close">
    <div class="panel" role="dialog" :aria-label="t('search.quickOpenTitle')">
      <form class="input-row" autocomplete="off" @submit.prevent>
        <Search :size="16" class="icon" />
        <input
          ref="inputRef"
          v-model="fileQuery"
          v-bind="PLAIN_INPUT_ATTRS"
          class="query"
          type="text"
          name="prism-quick-open"
          :placeholder="t('search.quickOpenPlaceholder')"
          @keydown="onKeydown"
        />
        <span v-if="loading || checkingRecent" class="hint">{{ t("search.searching") }}</span>
      </form>

      <div v-if="displayResults.length" class="results">
        <div v-if="!parsedQuery.searchText" class="section-label">
          {{ t("search.recentFiles") }}
        </div>
        <button
          v-for="(hit, index) in displayResults"
          :key="hit.path"
          :ref="(element) => setRowElement(element, index)"
          type="button"
          class="row"
          :class="{ active: index === activeIndex }"
          @click="openHit(index)"
          @mouseenter="activeIndex = index"
        >
          <FileTypeIcon :path="hit.path" :size="14" />
          <span class="name">{{ hit.name }}</span>
          <span class="relative">{{ hit.relative }}</span>
        </button>
      </div>

      <div v-else-if="fileQuery.trim() && !loading" class="empty">
        {{ t("search.noMatchingFiles") }}
      </div>
      <div v-else-if="!loading && !checkingRecent" class="empty">{{ t("search.noRecentFiles") }}</div>

      <div class="footer">
        <span>{{ t("search.quickOpenKeys") }}</span>
        <span v-if="parsedQuery.line !== null">
          {{ t("search.quickOpenLocation", { line: parsedQuery.line, column: parsedQuery.column }) }}
        </span>
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
  place-items: start center;
  padding-top: 12vh;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  animation: prism-overlay-in var(--transition-normal) var(--ease-out);
}

.panel {
  width: min(640px, calc(100vw - 32px));
  animation: prism-dialog-in var(--transition-normal) var(--ease-out);
  max-height: 60vh;
  overflow: auto;
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
}

.input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-subtle);
  position: sticky;
  top: 0;
  background: var(--bg-elevated);
  margin: 0;
}

.icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.query {
  flex: 1;
  height: 32px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  outline: none;
}

.hint {
  font-size: 12px;
  color: var(--text-muted);
}

.results {
  padding: 6px;
}

.section-label {
  padding: 4px 10px 6px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  text-align: left;
  color: var(--text-primary);
}

.row:hover,
.row.active {
  background: var(--accent-soft);
  color: var(--accent);
}

.name {
  font-weight: 500;
}

.relative {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-muted);
}

.empty {
  padding: 20px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.footer {
  position: sticky;
  bottom: 0;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 14px;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
  color: var(--text-muted);
  font-size: 11px;
}
</style>
