import {
  formatWithBuiltin,
  type BuiltinPrettierConfig,
} from "./prettierRuntime.ts";
import type { TextChangeRange } from "./textChange";

function extensionOf(filepath: string): string {
  const match = filepath.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

/** Vue 选区位于嵌入块时，片段兜底需要使用 script/style/template 对应 parser。 */
function vueRangeParserPath(
  filepath: string,
  content: string,
  range: TextChangeRange,
): string | null {
  const blockRe = /<(script|style|template)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(content))) {
    const bodyStart = match.index + match[0].indexOf(">") + 1;
    const bodyEnd = bodyStart + match[3].length;
    if (range.from < bodyStart || range.to > bodyEnd) continue;

    const kind = match[1].toLowerCase();
    if (kind === "template") return `${filepath}.prismcode-range.html`;
    if (kind === "style") {
      const lang = /\blang\s*=\s*["']([^"']+)["']/i.exec(match[2])?.[1];
      const ext = lang && /^(?:scss|less|sass|css)$/i.test(lang) ? lang : "css";
      return `${filepath}.prismcode-range.${ext}`;
    }

    const lang = /\blang\s*=\s*["']([^"']+)["']/i.exec(match[2])?.[1];
    const ext = lang && /^(?:ts|tsx|jsx|js)$/i.test(lang) ? lang : "js";
    return `${filepath}.prismcode-range.${ext}`;
  }
  return null;
}

/**
 * 部分 parser（尤其 CSS/HTML）对 Prettier range 参数不会返回变化。
 * 这时仅格式化选中的完整片段并拼回原文，确保选区外文本保持不变。
 */
export async function formatBuiltinRangeFallback(
  filepath: string,
  content: string,
  range: TextChangeRange,
  config: BuiltinPrettierConfig = {},
): Promise<string> {
  const selected = content.slice(range.from, range.to);
  if (!selected.trim()) return content;

  const ext = extensionOf(filepath);
  const parserPath =
    ext === "vue"
      ? vueRangeParserPath(filepath, content, range)
      : /^(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|json|jsonc|json5|css|scss|less|html|htm|md|markdown|yaml|yml|gql|graphql)$/.test(ext)
        ? filepath
        : null;
  if (!parserPath) return content;

  try {
    let replacement = await formatWithBuiltin(parserPath, selected, config);
    // 独立片段格式化默认补一个文件换行；选区没有选中换行时不要把它带入原文。
    if (!/(?:\r\n|\n|\r)$/.test(selected)) {
      replacement = replacement.replace(/(?:\r\n|\n|\r)$/, "");
    }
    if (replacement === selected) return content;
    return `${content.slice(0, range.from)}${replacement}${content.slice(range.to)}`;
  } catch {
    return content;
  }
}
