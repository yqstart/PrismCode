// ==================== File Structure（⌘F12）弹层状态 ====================
// 对齐 IDEA「File Structure」：对当前活动文件的最新缓冲区内容做符号索引，
// 弹层内过滤 / 选择 / 跳转。索引复用 documentSymbols（与编辑器导航同源，
// 可命中其记忆化缓存）；跳转复用 editor store 的 openFileAt（与 ReferencesPanel
// 同路径，会写入导航历史，可用返回快捷键回跳）。

import { computed, ref } from "vue";
import { defineStore } from "pinia";
import {
  indexDocumentSymbols,
  type DocumentSymbol,
  type SymbolKind,
} from "@/features/editor/documentSymbols";
import { useEditorStore } from "@/stores/editor";

/** 弹层列表项：索引符号 + 展示用缩进层级 */
export interface StructureSymbol extends DocumentSymbol {
  /** 展示层级：按同文件符号行的缩进宽度归一化得出，0 = 顶层 */
  depth: number;
}

// ==================== 纯函数（无 store 依赖） ====================

/**
 * 同一点位可能被多个声明模式同时命中（如 `const foo = () => {}` 同时是
 * function 与 variable）；去重时保留语义更贴近的 kind（数字越小越优先）。
 */
const KIND_PRIORITY: Record<SymbolKind, number> = {
  class: 0,
  interface: 0,
  enum: 0,
  function: 0,
  method: 0,
  type: 1,
  variable: 2,
};

/** 行首缩进宽度：tab 按 2 空格折算 */
function leadingWidth(line: string): number {
  const match = /^[ \t]*/.exec(line);
  if (!match) return 0;
  let width = 0;
  for (const ch of match[0]) width += ch === "\t" ? 2 : 1;
  return width;
}

/**
 * 把「名称 → 定义列表」索引摊平为按位置排序的符号列表：
 * ① 同点位去重（保留优先级更高的 kind）；
 * ② depth = 该行缩进在同文件符号行缩进集合中的排名：2/4 空格缩进都归一化，
 *    避免缩进风格不同导致层级深浅不一致。
 */
function flattenStructureSymbols(
  index: Map<string, DocumentSymbol[]>,
  text: string,
): StructureSymbol[] {
  const byPosition = new Map<string, DocumentSymbol>();
  for (const list of index.values()) {
    for (const symbol of list) {
      const key = `${symbol.name}\u0000${symbol.line}\u0000${symbol.column}`;
      const current = byPosition.get(key);
      if (!current || KIND_PRIORITY[symbol.kind] < KIND_PRIORITY[current.kind]) {
        byPosition.set(key, symbol);
      }
    }
  }
  const flat = [...byPosition.values()].sort(
    (a, b) => a.line - b.line || a.column - b.column,
  );
  const lines = text.split("\n");
  const indents = flat.map((symbol) => leadingWidth(lines[symbol.line - 1] ?? ""));
  const levels = [...new Set(indents)].sort((a, b) => a - b);
  const depthOf = new Map(levels.map((width, rank) => [width, rank]));
  const MAX_DEPTH = 6;
  return flat.map((symbol, i) => ({
    ...symbol,
    depth: Math.min(depthOf.get(indents[i]) ?? 0, MAX_DEPTH),
  }));
}

/**
 * 子序列模糊匹配（大小写不敏感）：子串命中或按输入顺序命中的字符都算匹配。
 * IDEA 的过滤是速度搜索语义：名称缩写（如 `mOpt` 命中 `mergeOptions`）也应命中。
 */
export function fuzzyMatch(query: string, name: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const lower = name.toLowerCase();
  if (lower.includes(q)) return true;
  let qi = 0;
  for (let i = 0; i < lower.length && qi < q.length; i += 1) {
    if (lower[i] === q[qi]) qi += 1;
  }
  return qi === q.length;
}

/** 过滤符号：空词返回全量；保持文件顺序（对齐 IDEA 速度搜索的树内过滤） */
export function filterStructureSymbols(
  symbols: readonly StructureSymbol[],
  query: string,
): StructureSymbol[] {
  const q = query.trim();
  if (!q) return [...symbols];
  return symbols.filter((symbol) => fuzzyMatch(q, symbol.name));
}

/** 默认选中：光标所在行之前（含本行）的最后一个符号；无则第一项 */
function pickIndexForCursor(
  symbols: readonly StructureSymbol[],
  cursor: { line: number },
): number {
  let index = 0;
  for (let i = 0; i < symbols.length; i += 1) {
    if (symbols[i].line <= cursor.line) index = i;
    else break;
  }
  return index;
}

// ==================== 弹层状态 ====================

export const useStructureStore = defineStore("structure", () => {
  const visible = ref(false);
  /** 当前目标文件的符号（按文件位置排序） */
  const symbols = ref<StructureSymbol[]>([]);
  /** 过滤输入框内容 */
  const filter = ref("");
  /** 选中下标（作用于 filtered） */
  const activeIndex = ref(0);
  /** 打开时锁定的目标文件：弹层存续期间跳转始终指向它 */
  const targetPath = ref<string | null>(null);
  /** 打开时的默认选中项（清空过滤词后恢复） */
  const defaultIndex = ref(0);

  const filtered = computed(() =>
    filterStructureSymbols(symbols.value, filter.value),
  );

  /** 打开弹层：对当前活动文件的最新缓冲区内容构建符号列表并显示 */
  function open(): void {
    const tab = useEditorStore().activeTab;
    // 无活动文件时无可展示的结构：保持关闭（对齐 IDEA 无编辑器时动作无效）
    if (!tab) {
      close();
      return;
    }
    symbols.value = flattenStructureSymbols(
      indexDocumentSymbols(tab.content, tab.path),
      tab.content,
    );
    targetPath.value = tab.path;
    filter.value = "";
    defaultIndex.value = pickIndexForCursor(symbols.value, tab.cursor);
    activeIndex.value = defaultIndex.value;
    visible.value = true;
  }

  function close(): void {
    visible.value = false;
  }

  /** 过滤词变化：有词时选中首个命中，清空时回到光标所在符号 */
  function setFilter(value: string): void {
    filter.value = value;
    activeIndex.value = value.trim() ? 0 : defaultIndex.value;
  }

  /** 键盘移动选中项（越界钳制） */
  function moveActive(delta: number): void {
    const count = filtered.value.length;
    activeIndex.value = Math.max(
      0,
      Math.min(count - 1, activeIndex.value + delta),
    );
  }

  /** 悬停 / Home / End 直接指定选中项（越界钳制） */
  function setActiveIndex(index: number): void {
    activeIndex.value = Math.max(
      0,
      Math.min(index, filtered.value.length - 1),
    );
  }

  /** Enter / 点击：跳转到选中符号并关闭弹层 */
  function activate(index = activeIndex.value): void {
    const symbol = filtered.value[index];
    const path = targetPath.value;
    if (!symbol || !path) return;
    close();
    // openFileAt：切到目标文件并定位行列（编辑器 store 公开 API，会记录导航历史）
    void useEditorStore().openFileAt(path, symbol.line, symbol.column);
  }

  return {
    visible,
    symbols,
    filter,
    activeIndex,
    filtered,
    open,
    close,
    setFilter,
    moveActive,
    setActiveIndex,
    activate,
  };
});
