export interface VueScriptBlock {
 start: number;
 end: number;
 setup: boolean;
 lang: string;
}

export interface VueScriptContext {
 /** 与原 SFC 等长的 TS 虚拟文本，保持 offset 可直接映射回 CodeMirror。 */
 text: string;
 /** TS 语言服务使用的稳定虚拟文件名。 */
 fileName: string;
 blocks: VueScriptBlock[];
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/** 提取 Vue script/script setup，保留内容起始 offset。 */
export function getVueScriptBlocks(source: string): VueScriptBlock[] {
 const blocks: VueScriptBlock[] = [];
 SCRIPT_RE.lastIndex = 0;
 let match: RegExpExecArray | null;
 while ((match = SCRIPT_RE.exec(source))) {
  const attrs = match[1] ?? "";
  const content = match[2] ?? "";
  const start = match.index + match[0].indexOf(content);
  blocks.push({
   start,
   end: start + content.length,
   setup: /\bsetup(?:\s*=\s*(?:"setup"|'setup'))?\b/i.test(attrs),
   lang: attrs.match(/\blang\s*=\s*["']([^"']+)["']/i)?.[1] ?? "ts",
  });
 }
 return blocks;
}

/**
 * 生成等长虚拟 TS 文件：模板、标签和 script 标签本身替换为空格，
 * script 内容原样保留。换行必须保留——下游既用绝对 offset 映射（类型服务），
 * 也用行列映射（Monaco marker），吃掉换行会让行列整体错位。
 */
export function createVueScriptContext(
 filePath: string,
 source: string,
): VueScriptContext {
 const blocks = getVueScriptBlocks(source);
 const scriptSpans = blocks.map((block) => [block.start, block.end] as const);
 const chars = Array.from({ length: source.length }, (_, index) => {
  const char = source[index] ?? " ";
  for (const [start, end] of scriptSpans) {
   if (index >= start && index < end) return char;
  }
  return char === "\n" || char === "\r" ? char : " ";
 });
 return {
  text: chars.join(""),
  fileName: `${filePath}.ts`,
  blocks,
 };
}

export function isInVueScript(
 source: string,
 pos: number,
): boolean {
 return getVueScriptBlocks(source).some((block) => pos >= block.start && pos <= block.end);
}

export function vueScriptOffsetToLineColumn(
 source: string,
 offset: number,
): { line: number; column: number } {
 const safe = Math.max(0, Math.min(source.length, offset));
 let line = 1;
 let start = 0;
 for (let i = 0; i < safe; i += 1) {
  if (source[i] === "\n") {
   line += 1;
   start = i + 1;
  }
 }
 return { line, column: safe - start + 1 };
}
