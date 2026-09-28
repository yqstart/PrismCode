// ==================== 冲突块解析（纯函数） ====================
// 与编辑器内核无关，便于直测；Monaco 侧的 CodeLens 包装见
// features/editor/monaco/conflictResolver.ts。

export interface ConflictBlock {
 /** `<<<<<<<` 所在行（1-based） */
 startLine: number;
 /** 分隔符 `=======` 所在行；无 base 段时即 ours 段结束 */
 separatorLine: number;
 /** `>>>>>>>` 所在行 */
 endLine: number;
 /** `|||||||` base 段起始行（无则 null） */
 baseStartLine: number | null;
 ours: string;
 theirs: string;
 base: string | null;
}

const START_RE = /^<{7}(?:\s|$)/;
const BASE_RE = /^\|{7}(?:\s|$)/;
const SEPARATOR_RE = /^={7}(?:\s|$)/;
const END_RE = /^>{7}(?:\s|$)/;

/**
 * 解析全部冲突块。
 * 未闭合的块（缺少 `=======` 或 `>>>>>>>`）会被跳过——用户文件可能正处于
 * 手改到一半的状态，此时给出错误的替换区间比不给更糟。
 */
export function parseConflictBlocks(text: string): ConflictBlock[] {
 const lines = text.split("\n");
 const blocks: ConflictBlock[] = [];
 let index = 0;

 while (index < lines.length) {
  if (!START_RE.test(lines[index] ?? "")) {
   index += 1;
   continue;
  }
  const startLine = index;
  let separatorLine = -1;
  let baseStartLine: number | null = null;
  let endLine = -1;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
   const line = lines[cursor] ?? "";
   if (END_RE.test(line)) {
    endLine = cursor;
    break;
   }
   if (BASE_RE.test(line)) {
    baseStartLine = cursor;
    continue;
   }
   if (SEPARATOR_RE.test(line) && separatorLine === -1) {
    separatorLine = cursor;
   }
  }
  if (separatorLine === -1 || endLine === -1) {
   index += 1;
   continue;
  }

  const oursEnd = baseStartLine !== null && baseStartLine < separatorLine ? baseStartLine : separatorLine;
  blocks.push({
   startLine: startLine + 1,
   separatorLine: separatorLine + 1,
   endLine: endLine + 1,
   baseStartLine: baseStartLine === null ? null : baseStartLine + 1,
   ours: lines.slice(startLine + 1, oursEnd).join("\n"),
   theirs: lines.slice(separatorLine + 1, endLine).join("\n"),
   base:
    baseStartLine === null
     ? null
     : lines.slice(baseStartLine + 1, separatorLine).join("\n"),
  });
  index = endLine + 1;
 }

 return blocks;
}

export type ConflictChoice = "ours" | "theirs" | "both";

/** 采用某一侧后，该块应替换成的文本（纯函数，便于直测） */
export function conflictResolutionText(block: ConflictBlock, choice: ConflictChoice): string {
 if (choice === "ours") return block.ours;
 if (choice === "theirs") return block.theirs;
 if (!block.ours) return block.theirs;
 if (!block.theirs) return block.ours;
 return `${block.ours}\n${block.theirs}`;
}
