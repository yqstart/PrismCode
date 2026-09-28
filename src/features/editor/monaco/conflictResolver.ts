// ==================== 冲突块解析与内联解决 ====================
// 冲突文件里每块 `<<<<<<< ours / ======= / >>>>>>> theirs` 提供一个 CodeLens，
// 一键采用「当前 / 传入 / 两者」。解析是纯函数，便于直测。
import { monaco } from "./setup";
import {
  conflictResolutionText,
  parseConflictBlocks,
  type ConflictChoice,
} from "@/features/git/conflictBlocks";

export type { ConflictBlock, ConflictChoice } from "@/features/git/conflictBlocks";
export { conflictResolutionText, parseConflictBlocks };

const CONFIDENCE_COMMAND_PREFIX = "prism.conflict";

const choiceLabels: Record<ConflictChoice, string> = {
 ours: "采用当前更改",
 theirs: "采用传入更改",
 both: "保留两者",
};

let registered = false;

/**
 * 注册冲突 CodeLens 与命令（幂等）。
 * 只在包含冲突标记的 model 上出 lens，普通文件零开销。
 */
export function installConflictResolver(): void {
 if (registered) return;
 registered = true;

 const applyChoice = (model: monaco.editor.ITextModel, blockIndex: number, choice: ConflictChoice) => {
  const blocks = parseConflictBlocks(model.getValue());
  const block = blocks[blockIndex];
  if (!block) return;
  const replacement = conflictResolutionText(block, choice);
  model.pushEditOperations(
   [],
   [
    {
     range: new monaco.Range(block.startLine, 1, block.endLine, model.getLineMaxColumn(block.endLine)),
     text: replacement,
    },
   ],
   () => null,
  );
 };

 for (const choice of ["ours", "theirs", "both"] as ConflictChoice[]) {
  monaco.editor.registerCommand(
   `${CONFIDENCE_COMMAND_PREFIX}.${choice}`,
   (_accessor, uri: monaco.Uri, blockIndex: number) => {
    const model = monaco.editor.getModel(uri);
    if (!model) return;
    applyChoice(model, blockIndex, choice);
   },
  );
 }

 monaco.languages.registerCodeLensProvider("*", {
  provideCodeLenses(model) {
   const blocks = parseConflictBlocks(model.getValue());
   if (!blocks.length) return { lenses: [], dispose: () => undefined };
   const lenses: monaco.languages.CodeLens[] = [];
   blocks.forEach((block, blockIndex) => {
    // 分隔符行是冲突标记里视觉上最中性的一行，把操作放在这里
    const anchor = {
     startLineNumber: block.separatorLine,
     startColumn: 1,
     endLineNumber: block.separatorLine,
     endColumn: 1,
    };
    for (const choice of ["ours", "theirs", "both"] as ConflictChoice[]) {
     lenses.push({
      range: anchor,
      command: {
       id: `${CONFIDENCE_COMMAND_PREFIX}.${choice}`,
       title: choiceLabels[choice],
       arguments: [model.uri, blockIndex],
      },
     });
    }
   });
   return { lenses, dispose: () => undefined };
  },
 });
}
