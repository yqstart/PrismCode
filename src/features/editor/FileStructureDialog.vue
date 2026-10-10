<script setup lang="ts">
// ==================== File Structure 弹层（⌘F12） ====================
// 对齐 IDEA File Structure：顶部过滤输入 + 下方符号树列表，↑↓ 选择、Enter 跳转、
// Esc / 点击遮罩关闭。符号索引与跳转都在 structure store，组件只做渲染与按键分发。
import {
  computed,
  nextTick,
  onMounted,
  ref,
  watch,
  type Component,
  type ComponentPublicInstance,
} from "vue";
import {
  Box,
  Cable,
  CircleDot,
  ListOrdered,
  Search,
  SquareFunction,
  Type,
  Variable,
} from "lucide-vue-next";
import { storeToRefs } from "pinia";
import { PLAIN_INPUT_ATTRS } from "@/shared/plainInput";
import { useI18n } from "@/i18n";
import type { SymbolKind } from "@/features/editor/documentSymbols";
import { useStructureStore } from "@/stores/structure";

const { t } = useI18n();
const structure = useStructureStore();
const { visible, activeIndex, filtered } = storeToRefs(structure);

/** 输入框经 setFilter 写回 store：过滤词变化时同步重置选中项 */
const filterText = computed({
  get: () => structure.filter,
  set: (value: string) => structure.setFilter(value),
});

const inputRef = ref<HTMLInputElement | null>(null);
const rowElements = new Map<number, HTMLElement>();

/** kind → 图标（近似 IDEA 图标语义：class 方框 / method 圆点 / interface 连接器…） */
const KIND_ICONS: Record<SymbolKind, Component> = {
  class: Box,
  interface: Cable,
  enum: ListOrdered,
  function: SquareFunction,
  method: CircleDot,
  type: Type,
  variable: Variable,
};

function iconFor(kind: SymbolKind): Component {
  return KIND_ICONS[kind];
}

function close(): void {
  structure.close();
}

function setRowElement(
  element: Element | ComponentPublicInstance | null,
  index: number,
): void {
  if (element instanceof HTMLElement) rowElements.set(index, element);
}

// 键盘处理范式与 QuickOpen 一致：Esc 关闭，↑↓ 移动，Home/End 首尾，
// PageUp/PageDown 翻页，Enter 跳转。
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    structure.moveActive(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    structure.moveActive(-1);
    return;
  }
  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    structure.setActiveIndex(
      event.key === "Home" ? 0 : filtered.value.length - 1,
    );
    return;
  }
  if (event.key === "PageDown" || event.key === "PageUp") {
    event.preventDefault();
    structure.moveActive(event.key === "PageDown" ? 8 : -8);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    if (filtered.value.length) structure.activate();
  }
}

// 选中项滚动跟随（block: nearest，与 QuickOpen 一致）
watch(activeIndex, async (index) => {
  await nextTick();
  rowElements.get(index)?.scrollIntoView({ block: "nearest" });
});

// 过滤结果变化后行 DOM 重建：清掉旧引用，由 :ref 回调重新登记
watch(filtered, () => {
  rowElements.clear();
});

// 打开时聚焦过滤框（与 QuickOpen 一致）
watch(visible, async (open) => {
  if (!open) return;
  await nextTick();
  inputRef.value?.focus();
});

onMounted(() => {
  if (visible.value) inputRef.value?.focus();
});
</script>

<template>
  <div v-if="visible" class="overlay" @mousedown.self="close">
    <div
      class="panel"
      role="dialog"
      aria-modal="true"
      :aria-label="t('structure.title')"
    >
      <form class="input-row" autocomplete="off" @submit.prevent>
        <Search :size="16" class="icon" />
        <input
          ref="inputRef"
          v-model="filterText"
          v-bind="PLAIN_INPUT_ATTRS"
          class="query"
          type="text"
          name="prism-file-structure"
          @keydown="onKeydown"
        />
      </form>

      <div v-if="filtered.length" class="results">
        <button
          v-for="(symbol, index) in filtered"
          :key="`${symbol.kind}:${symbol.name}:${symbol.line}:${symbol.column}`"
          :ref="(element) => setRowElement(element, index)"
          type="button"
          class="row"
          :class="{ active: index === activeIndex }"
          :style="{ paddingLeft: `${8 + symbol.depth * 14}px` }"
          @click="structure.activate(index)"
          @mouseenter="structure.setActiveIndex(index)"
        >
          <component :is="iconFor(symbol.kind)" :size="14" class="kind" />
          <span class="name">{{ symbol.name }}</span>
          <span class="line">{{ symbol.line }}</span>
        </button>
      </div>

      <div v-else class="empty">{{ t("structure.empty") }}</div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  /* 与 QuickOpen 同层：同为顶层导航弹层，后挂载者渲染在上 */
  z-index: 60;
  display: grid;
  place-items: start center;
  padding-top: 12vh;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  animation: prism-overlay-in var(--transition-normal) var(--ease-out);
}

.panel {
  width: min(420px, calc(100vw - 32px));
  max-height: 56vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-modal);
  animation: prism-dialog-in var(--transition-normal) var(--ease-out);
}

.input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-subtle);
}

.icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.query {
  flex: 1;
  height: var(--control-height-sm);
  border: none;
  background: transparent;
  color: var(--text-primary);
  outline: none;
  font-size: var(--font-size-md);
}

.results {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 6px 6px;
}

.row {
  width: 100%;
  height: 24px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding-right: 8px;
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  text-align: left;
  white-space: nowrap;
}

.row:hover {
  background: var(--bg-hover);
}

.row.active {
  background: var(--bg-active);
}

.kind {
  flex-shrink: 0;
  color: var(--text-muted);
}

.row.active .kind {
  color: var(--accent);
}

.name {
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
}

.line {
  margin-left: auto;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}

.empty {
  padding: 20px;
  color: var(--text-muted);
  font-size: var(--font-size-md);
  text-align: center;
}
</style>
