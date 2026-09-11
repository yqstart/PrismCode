// ==================== 跳转目标高亮 ====================
// 跳转完成后同时突出目标行、目标文本和行号，让异步打开文件后的落点可追踪。

import {
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutterLineClass,
  type DecorationSet,
} from "@codemirror/view";
import { wordAt } from "@/features/editor/documentSymbols";

export interface JumpHighlightTarget {
  /** 目标文本的起始 offset */
  from: number;
  /** 目标文本的结束 offset（可与 from 相等，表示空行） */
  to: number;
  /** 目标行的起始 offset */
  lineFrom: number;
}

/** 将跳转位置扩展到目标标识符；标识符外至少突出一个字符。 */
export function createJumpHighlightTarget(
  doc: Text,
  pos: number,
): JumpHighlightTarget {
  const numericPos = Number.isFinite(pos) ? Math.trunc(pos) : 0;
  const safePos = Math.max(0, Math.min(doc.length, numericPos));
  const line = doc.lineAt(safePos);
  const hit = wordAt(doc.toString(), safePos);

  if (hit && safePos >= hit.from && safePos < hit.to) {
    return { from: hit.from, to: hit.to, lineFrom: line.from };
  }

  return {
    from: safePos,
    to: Math.min(safePos + 1, line.to),
    lineFrom: line.from,
  };
}

export const setJumpHighlightEffect = StateEffect.define<JumpHighlightTarget | null>();

const jumpLineDecoration = Decoration.line({ class: "cm-prism-jump-line" });
const jumpTargetDecoration = Decoration.mark({ class: "cm-prism-jump-target" });

class JumpGutterMarker extends GutterMarker {
  elementClass = "cm-prism-jump-gutter";

  eq(other: GutterMarker): boolean {
    return other === this;
  }
}

const jumpGutterMarker = new JumpGutterMarker();

const jumpHighlightField = StateField.define<JumpHighlightTarget | null>({
  create: () => null,
  update(value, transaction) {
    // 用户编辑后旧目标可能已移动或消失，避免留下误导性的历史标记。
    let next = transaction.docChanged ? null : value;
    for (const effect of transaction.effects) {
      if (effect.is(setJumpHighlightEffect)) next = effect.value;
    }
    return next;
  },
});

const jumpDecorations = EditorView.decorations.compute(
  [jumpHighlightField],
  (state): DecorationSet => {
    const target = state.field(jumpHighlightField);
    if (!target) return Decoration.none;

    const ranges = [jumpLineDecoration.range(target.lineFrom)];
    if (target.to > target.from) {
      ranges.push(jumpTargetDecoration.range(target.from, target.to));
    }
    return Decoration.set(ranges, true);
  },
);

const jumpGutterClass = gutterLineClass.compute(
  [jumpHighlightField],
  (state) => {
    const target = state.field(jumpHighlightField);
    return target
      ? RangeSet.of(jumpGutterMarker.range(target.lineFrom))
      : RangeSet.empty;
  },
);

export const jumpHighlightExtension: Extension = [
  jumpHighlightField,
  jumpDecorations,
  jumpGutterClass,
];
