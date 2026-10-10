<script setup lang="ts">
// ==================== Search Everywhere（对齐 IDEA 2026.2） ====================
// 顶部输入框 + All / Files / Symbols / Actions 四个分组：
// - Tab / Shift+Tab 在不同分组间循环，也可点击分组标签切换；
// - ↑↓ 选择、Enter 执行（文件→打开、符号→跳转行列、动作→执行注册表动作）、Esc 关闭；
// - 空查询时文件组回退到最近文件（复用 QuickOpen 的路径校验逻辑），动作组列出前 12 条；
// - 符号数据来自 workspaceSymbols 的后台懒构建索引，索引就绪后自动重查补齐，不阻塞 UI。

import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type Component,
  type ComponentPublicInstance,
} from "vue";
import {
  Box,
  Braces,
  ListTree,
  Search,
  SquareFunction,
  Type,
  Variable,
  Zap,
} from "lucide-vue-next";
import { storeToRefs } from "pinia";
import { executeAction, searchActions, type ActionDef } from "@/shared/actions";
import FileTypeIcon from "@/shared/FileTypeIcon.vue";
import { basename, isPathUnder, pathExists, relativeToRoot } from "@/shared/fs";
import { PLAIN_INPUT_ATTRS } from "@/shared/plainInput";
import { rankQuickOpenResults } from "@/features/search/quickOpen";
import type { SymbolKind } from "@/features/editor/documentSymbols";
import { workspaceSymbols, type WorkspaceSymbolHit } from "@/features/editor/workspaceSymbols";
import { useI18n } from "@/i18n";
import { useEditorStore } from "@/stores/editor";
import { useSearchStore, type SearchEverywhereMode } from "@/stores/search";
import { useWorkspaceStore } from "@/stores/workspace";

/** 弹层内的一行：文件 / 符号 / 动作 */
type Row =
  | { kind: "file"; key: string; path: string; name: string; detail: string }
  | { kind: "symbol"; key: string; hit: WorkspaceSymbolHit }
  | { kind: "action"; key: string; action: ActionDef; title: string; detail: string; shortcut?: string };

/** 渲染分组：items 的 index 为跨分组连续的扁平序号，供 ↑↓ / Enter 定位 */
interface Section {
  id: "files" | "symbols" | "actions";
  label: string;
  items: Array<{ row: Row; index: number }>;
}

/** Tab 循环顺序 */
const MODE_CYCLE: SearchEverywhereMode[] = ["all", "files", "symbols", "actions"];

const MODE_LABEL_KEYS: Record<SearchEverywhereMode, string> = {
  all: "searchEverywhere.tabAll",
  files: "searchEverywhere.tabFiles",
  symbols: "searchEverywhere.tabSymbols",
  actions: "searchEverywhere.tabActions",
};

/** 符号类型 → 行首图标 */
const SYMBOL_ICONS: Record<SymbolKind, Component> = {
  function: SquareFunction,
  method: Braces,
  class: Box,
  interface: Type,
  type: Type,
  enum: ListTree,
  variable: Variable,
};

/** All 分组下每段最多展示的条数（IDEA 的 All 视图每段都很短） */
const ALL_SECTION_LIMIT = 8;
/** 单分组视图与符号查询的条数上限 */
const SINGLE_SECTION_LIMIT = 50;
/** 空查询时动作组展示的条数 */
const EMPTY_ACTION_LIMIT = 12;
/** 输入防抖：连续输入只发最后一次搜索 */
const QUERY_DEBOUNCE_MS = 150;

const { t } = useI18n();
const search = useSearchStore();
const editor = useEditorStore();
const workspace = useWorkspaceStore();
const { searchEverywhereVisible, searchEverywhereMode, searchEverywhereQuery } =
  storeToRefs(search);
const { recentPaths } = storeToRefs(editor);

const inputRef = ref<HTMLInputElement | null>(null);
const activeIndex = ref(0);
const symbolHits = ref<WorkspaceSymbolHit[]>([]);
const verifiedRecentPaths = ref<string[]>([]);
const checkingRecent = ref(false);
const rowElements = new Map<number, HTMLElement>();
let searchTimer: number | null = null;
let recentCheckSeq = 0;
let symbolSearchSeq = 0;
let symbolRerunPending = false;
/** 最近一次实际发起请求的查询串：避免切分组时对同一查询重复打 IPC */
let lastFileQuery = "";
let lastSymbolQuery = "";

const trimmedQuery = computed(() => searchEverywhereQuery.value.trim());
const sectionLimit = computed(() =>
  searchEverywhereMode.value === "all" ? ALL_SECTION_LIMIT : SINGLE_SECTION_LIMIT,
);

const recentRows = computed<Row[]>(() => {
  const root = workspace.rootPath;
  if (!root) return [];
  return verifiedRecentPaths.value.map((path) => ({
    kind: "file",
    key: `file:${path}`,
    path,
    name: basename(path),
    detail: relativeToRoot(root, path),
  }));
});

const fileRows = computed<Row[]>(() => {
  const root = workspace.rootPath;
  if (!root) return [];
  const limit = sectionLimit.value;
  if (!trimmedQuery.value) return recentRows.value.slice(0, limit);
  return rankQuickOpenResults(search.fileResults, recentPaths.value)
    .slice(0, limit)
    .map((hit) => ({
      kind: "file",
      key: `file:${hit.path}`,
      path: hit.path,
      name: hit.name,
      detail: hit.relative,
    }));
});

const symbolRows = computed<Row[]>(() => {
  if (!trimmedQuery.value) return [];
  return symbolHits.value.slice(0, sectionLimit.value).map((hit) => ({
    kind: "symbol",
    key: `symbol:${hit.path}:${hit.line}:${hit.column}:${hit.name}`,
    hit,
  }));
});

const actionRows = computed<Row[]>(() => {
  const actions = trimmedQuery.value
    ? searchActions(trimmedQuery.value).slice(0, sectionLimit.value)
    : searchActions("").slice(0, EMPTY_ACTION_LIMIT);
  return actions.map((action) => ({
    kind: "action",
    key: `action:${action.id}`,
    action,
    title: action.title(),
    detail: action.category?.() ?? "",
    shortcut: action.shortcut,
  }));
});

const sections = computed<Section[]>(() => {
  const mode = searchEverywhereMode.value;
  const candidates: Array<{ id: Section["id"]; label: string; rows: Row[] }> = [];
  if (mode === "all" || mode === "files") {
    candidates.push({
      id: "files",
      label: t("searchEverywhere.groupFiles"),
      rows: fileRows.value,
    });
  }
  if (mode === "all" || mode === "symbols") {
    candidates.push({
      id: "symbols",
      label: t("searchEverywhere.groupSymbols"),
      rows: symbolRows.value,
    });
  }
  if (mode === "all" || mode === "actions") {
    candidates.push({
      id: "actions",
      label: t("searchEverywhere.groupActions"),
      rows: actionRows.value,
    });
  }
  // 空分组不渲染；扁平序号跨分组连续编号
  let flatIndex = 0;
  return candidates
    .filter((section) => section.rows.length > 0)
    .map((section) => ({
      id: section.id,
      label: section.label,
      items: section.rows.map((row) => ({ row, index: flatIndex++ })),
    }));
});

const flatRows = computed<Row[]>(() =>
  sections.value.flatMap((section) => section.items.map((item) => item.row)),
);

const emptyHint = computed(() =>
  trimmedQuery.value
    ? t("searchEverywhere.noResults", { query: trimmedQuery.value })
    : t("searchEverywhere.emptyHint"),
);

// ==================== 数据加载 ====================

/** 校验最近文件仍然存在（工作区切换 / 文件删除后不展示幽灵条目） */
async function verifyRecentFiles() {
  const root = workspace.rootPath;
  const seq = ++recentCheckSeq;
  verifiedRecentPaths.value = [];
  checkingRecent.value = false;
  if (!root) return;
  const candidates = recentPaths.value.filter((path) => isPathUnder(root, path));
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

async function runSymbolSearch(query: string) {
  const root = workspace.rootPath;
  const seq = ++symbolSearchSeq;
  if (!root) {
    symbolHits.value = [];
    return;
  }
  const hits = await workspaceSymbols.searchWorkspaceSymbols(
    root,
    query,
    SINGLE_SECTION_LIMIT,
  );
  if (seq !== symbolSearchSeq || !searchEverywhereVisible.value) return;
  symbolHits.value = hits;
  // 索引首次构建在后台进行：完成后自动重查一次，让结果从部分索引补齐
  const pending = workspaceSymbols.pendingIndexScan();
  if (pending && !symbolRerunPending) {
    symbolRerunPending = true;
    void pending.then(() => {
      symbolRerunPending = false;
      if (
        seq === symbolSearchSeq &&
        searchEverywhereVisible.value &&
        searchEverywhereQuery.value.trim() === query
      ) {
        void runSymbolSearch(query);
      }
    });
  }
}

/** 按当前分组触发所需的数据加载；同一查询只发一次，Tab 切组不重复打 IPC */
function runSearches(query: string) {
  if (!query) return;
  const mode = searchEverywhereMode.value;
  if ((mode === "all" || mode === "files") && query !== lastFileQuery) {
    lastFileQuery = query;
    void search.runFileSearch(query);
  }
  if ((mode === "all" || mode === "symbols") && query !== lastSymbolQuery) {
    lastSymbolQuery = query;
    void runSymbolSearch(query);
  }
}

// ==================== 交互 ====================

function closeOverlay() {
  search.closeSearchEverywhere();
}

function setMode(mode: SearchEverywhereMode) {
  searchEverywhereMode.value = mode;
}

async function executeRow(index: number) {
  const row = flatRows.value[index];
  if (!row) return;
  // 先关闭再执行：动作可能打开设置 / 提交面板等新弹层，避免两层叠加
  closeOverlay();
  if (row.kind === "file") {
    await editor.openFile(row.path);
    return;
  }
  if (row.kind === "symbol") {
    await editor.openFileAt(row.hit.path, row.hit.line, row.hit.column);
    return;
  }
  executeAction(row.action.id);
}

function onKeydown(event: KeyboardEvent) {
  const count = flatRows.value.length;
  if (event.key === "Escape") {
    event.preventDefault();
    closeOverlay();
    return;
  }
  if (event.key === "Tab") {
    // Tab / Shift+Tab：All → Files → Symbols → Actions 循环
    event.preventDefault();
    const step = event.shiftKey ? -1 : 1;
    const current = MODE_CYCLE.indexOf(searchEverywhereMode.value);
    setMode(MODE_CYCLE[(current + step + MODE_CYCLE.length) % MODE_CYCLE.length]);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    void executeRow(activeIndex.value);
    return;
  }
  if (count === 0) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    activeIndex.value = Math.min(activeIndex.value + 1, count - 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    activeIndex.value = Math.max(activeIndex.value - 1, 0);
  } else if (event.key === "Home") {
    event.preventDefault();
    activeIndex.value = 0;
  } else if (event.key === "End") {
    event.preventDefault();
    activeIndex.value = count - 1;
  } else if (event.key === "PageDown") {
    event.preventDefault();
    activeIndex.value = Math.min(count - 1, activeIndex.value + 8);
  } else if (event.key === "PageUp") {
    event.preventDefault();
    activeIndex.value = Math.max(0, activeIndex.value - 8);
  }
}

function setRowElement(
  element: Element | ComponentPublicInstance | null,
  index: number,
) {
  if (element instanceof HTMLElement) rowElements.set(index, element);
}

// ==================== 响应式联动 ====================

watch(searchEverywhereQuery, (value) => {
  activeIndex.value = 0;
  if (searchTimer !== null) window.clearTimeout(searchTimer);
  // 先作废旧文件结果与在途符号搜索，避免旧查询结果错配到新查询；
  // 请求标记一并重置：同一串重新出现时仍要重新发起（结果已被作废）
  search.invalidateFileSearch();
  symbolSearchSeq += 1;
  lastFileQuery = "";
  lastSymbolQuery = "";
  const query = value.trim();
  if (!query) {
    symbolHits.value = [];
    return;
  }
  searchTimer = window.setTimeout(() => {
    runSearches(query);
  }, QUERY_DEBOUNCE_MS);
});

watch(searchEverywhereMode, () => {
  activeIndex.value = 0;
  runSearches(trimmedQuery.value);
});

watch(searchEverywhereVisible, async (open) => {
  if (!open) {
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    symbolSearchSeq += 1;
    lastFileQuery = "";
    lastSymbolQuery = "";
    return;
  }
  activeIndex.value = 0;
  symbolHits.value = [];
  void verifyRecentFiles();
  await nextTick();
  inputRef.value?.focus();
  inputRef.value?.select();
});

watch(flatRows, (rows) => {
  rowElements.clear();
  activeIndex.value = Math.min(activeIndex.value, Math.max(0, rows.length - 1));
});

watch(activeIndex, async (index) => {
  await nextTick();
  rowElements.get(index)?.scrollIntoView({ block: "nearest" });
});

onMounted(() => {
  if (searchEverywhereVisible.value) {
    void verifyRecentFiles();
    inputRef.value?.focus();
  }
});

onBeforeUnmount(() => {
  if (searchTimer !== null) window.clearTimeout(searchTimer);
});
</script>

<template>
  <div
    v-if="searchEverywhereVisible"
    class="overlay"
    @mousedown.self="closeOverlay"
    @keydown="onKeydown"
  >
    <div class="panel" role="dialog" :aria-label="t('searchEverywhere.title')">
      <div class="input-row">
        <Search :size="16" class="icon" />
        <input
          ref="inputRef"
          v-model="searchEverywhereQuery"
          v-bind="PLAIN_INPUT_ATTRS"
          class="query"
          type="text"
          name="prism-search-everywhere"
          :placeholder="t('searchEverywhere.placeholder')"
        />
        <span v-if="search.loading || checkingRecent" class="hint">
          {{ t("search.searching") }}
        </span>
      </div>

      <div class="tabs" role="tablist">
        <button
          v-for="mode in MODE_CYCLE"
          :key="mode"
          type="button"
          class="tab"
          :class="{ active: searchEverywhereMode === mode }"
          role="tab"
          :aria-selected="searchEverywhereMode === mode"
          tabindex="-1"
          @mousedown.prevent
          @click="setMode(mode)"
        >
          {{ t(MODE_LABEL_KEYS[mode]) }}
        </button>
      </div>

      <div v-if="flatRows.length" class="results">
        <template v-for="section in sections" :key="section.id">
          <div class="group-label">{{ section.label }}</div>
          <button
            v-for="item in section.items"
            :key="item.row.key"
            :ref="(element) => setRowElement(element, item.index)"
            type="button"
            class="row"
            :class="{ active: item.index === activeIndex }"
            tabindex="-1"
            @mousedown.prevent
            @click="executeRow(item.index)"
            @mouseenter="activeIndex = item.index"
          >
            <template v-if="item.row.kind === 'file'">
              <FileTypeIcon :path="item.row.path" :size="14" />
              <span class="name">{{ item.row.name }}</span>
              <span class="detail">{{ item.row.detail }}</span>
            </template>
            <template v-else-if="item.row.kind === 'symbol'">
              <component
                :is="SYMBOL_ICONS[item.row.hit.kind]"
                :size="14"
                class="kind-icon"
              />
              <span class="name">{{ item.row.hit.name }}</span>
              <span class="detail">{{ item.row.hit.containerPath }}</span>
            </template>
            <template v-else>
              <Zap :size="14" class="kind-icon" />
              <span class="name">{{ item.row.title }}</span>
              <span class="detail">{{ item.row.detail }}</span>
              <span v-if="item.row.shortcut" class="shortcut">{{ item.row.shortcut }}</span>
            </template>
          </button>
        </template>
      </div>

      <div v-else class="empty">{{ emptyHint }}</div>

      <div class="footer">
        <span>{{ t("searchEverywhere.hint") }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  /* 与 QuickOpen / FindInFiles 同层：同一时刻只会打开一个搜索弹层 */
  z-index: 60;
  display: grid;
  place-items: start center;
  padding-top: 12vh;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  animation: prism-overlay-in var(--transition-normal) var(--ease-out);
}

.panel {
  display: flex;
  flex-direction: column;
  width: min(760px, calc(100vw - 32px));
  max-height: 64vh;
  overflow: hidden;
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-modal);
  animation: prism-dialog-in var(--transition-normal) var(--ease-out);
}

.input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-subtle);
}

.icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.query {
  flex: 1;
  height: 30px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-md);
  outline: none;
}

.hint {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.tabs {
  display: flex;
  gap: 4px;
  padding: 4px 10px 0;
  border-bottom: 1px solid var(--border-subtle);
}

.tab {
  padding: 4px 10px 6px;
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.tab:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

.results {
  flex: 1;
  overflow: auto;
  padding: 4px 6px 6px;
}

.group-label {
  padding: 6px 10px 4px;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-md);
  text-align: left;
}

.row.active {
  background: var(--bg-active);
}

.row.active .kind-icon {
  color: var(--accent);
}

.name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.kind-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.detail {
  margin-left: auto;
  flex-shrink: 0;
  max-width: 45%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.shortcut {
  flex-shrink: 0;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
}

.empty {
  padding: 28px 20px;
  color: var(--text-muted);
  font-size: var(--font-size-md);
  text-align: center;
}

.footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 14px;
  border-top: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}
</style>
