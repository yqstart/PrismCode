// ==================== MD 预览查找 · 纯文本匹配 ====================
// 与编辑器内查找（SearchQuery）同语义：空查询无结果、大小写 / 正则 / 全词
// 三开关、无效正则吞掉返回空。DOM 包裹逻辑在 MdPreviewFind.vue（需浏览器
// 环境），此处只做可单测的字符串区间计算与正则构造。

export interface PreviewFindOptions {
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
}

export interface PreviewFindRange {
  from: number;
  to: number;
}

/** 查询串编译为全文正则；空查询 / 非法正则返回 null（调用方按无结果处理） */
export function buildPreviewFindRegExp(
  query: string,
  opts: PreviewFindOptions,
): RegExp | null {
  if (!query.trim()) return null;
  // 非正则模式转义为字面匹配（与 SearchQuery 纯文本语义一致）
  const base = opts.regexp ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = opts.wholeWord ? `\\b(?:${base})\\b` : base;
  try {
    return new RegExp(source, opts.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

/** 全文匹配区间（上限 cap，与 CM getMatchStats 的 10000 对齐） */
export function findPreviewMatches(
  text: string,
  query: string,
  opts: PreviewFindOptions,
  cap = 10000,
): PreviewFindRange[] {
  const re = buildPreviewFindRegExp(query, opts);
  if (!re) return [];
  const out: PreviewFindRange[] = [];
  re.lastIndex = 0;
  for (; ;) {
    const m = re.exec(text);
    if (!m) break;
    const from = m.index;
    const to = from + m[0].length;
    if (to === from) {
      // 零宽匹配（^ / $ / \b* 等）不收录，手动推进避免死循环
      re.lastIndex += 1;
      if (re.lastIndex > text.length) break;
      continue;
    }
    out.push({ from, to });
    if (out.length >= cap) break;
  }
  return out;
}
