// ==================== Emmet 缩写展开（VS Code 同款） ====================
// 只保留与内核无关的纯函数：缩写匹配、缩进对齐、语法判定。
// 展开动作由 Monaco 的补全 provider 承担（monaco/emmetProvider.ts）。


/** 取文件名（POSIX 语义，零依赖保持可直测） */
function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** Emmet 缩写匹配：光标前允许的标记缩写字符集 */
const ABBR_RE = /([a-zA-Z][\w+>#.\[\]()$*^!-]*)$/;

/** 缩写长度上限（防误匹配长文本） */
const ABBR_MAX_LEN = 80;

/**
 * 匹配光标前的 Emmet 缩写（纯函数，可直测）
 *
 * 规则：缩写必须以字母开头，且前一个字符不能是词符（避免把普通标识符当缩写）。
 */
export function matchEmmetAbbreviation(beforeCursor: string): string | null {
  const m = beforeCursor.match(ABBR_RE);
  if (!m) return null;
  const abbr = m[1];
  if (abbr.length > ABBR_MAX_LEN) return null;
  const prev = beforeCursor[(m.index ?? 0) - 1] ?? "";
  if (/[\w]/.test(prev)) return null;
  return abbr;
}

/**
 * 按当前行缩进对齐展开结果：
 * - 首行保持原样（插入点前已有行缩进）
 * - 后续行 = 行缩进 + 每层 tab（→ 缩进单位）换算
 * emmet 输出层级用 \t，缩进单位取当前行缩进（多数项目行缩进即一级），无缩进时 2 空格。
 */
export function indentExpanded(expanded: string, baseIndent: string): string {
  const lines = expanded.split("\n");
  if (lines.length <= 1) return expanded;
  const indentUnit = baseIndent || "  ";
  return lines
    .map((ln, i) => (i === 0 ? ln : baseIndent + ln.replace(/\t/g, indentUnit)))
    .join("\n");
}

/** 按文件与光标上下文选 emmet 语法 */
export function emmetSyntax(filePath: string, beforeCursor: string): "html" | "css" {
  const name = basename(filePath).toLowerCase();
  if (/\.(css|scss|less|sass)$/.test(name)) return "css";
  if (name.endsWith(".vue")) {
    // style 段 → css（粗糙判断：光标前最近 `<style` 未闭合）
    const styleOpen = beforeCursor.lastIndexOf("<style");
    const styleClose = beforeCursor.lastIndexOf("</style>");
    if (styleOpen > styleClose) return "css";
  }
  return "html";
}
