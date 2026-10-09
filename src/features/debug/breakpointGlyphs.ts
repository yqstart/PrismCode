// ==================== 编辑器断点标记 ====================
// 断点的真值在 debug store，这里只负责两件事：
// 1. 把行号画到 glyph margin（Monaco 的 deltaDecorations）
// 2. 点 glyph margin 时回调切换断点
// Monaco 的 gutter 是编辑器自己的 DOM，样式用全局类名（见 styles/global.css）。
import { monaco } from "@/features/editor/monaco/setup";

export interface BreakpointController {
  /** 断点集合变化后重画 */
  sync(): void;
  dispose(): void;
}

export function installBreakpointGlyphs(
  editor: monaco.editor.IStandaloneCodeEditor,
  options: {
    linesFor: () => number[];
    toggle: (line: number) => void;
  },
): BreakpointController {
  let decorationIds: string[] = [];

  function sync(): void {
    const model = editor.getModel();
    if (!model) {
      decorationIds = editor.deltaDecorations(decorationIds, []);
      return;
    }
    const lineCount = model.getLineCount();
    const decorations = options
      .linesFor()
      .filter((line) => line >= 1 && line <= lineCount)
      .map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: "prism-breakpoint-glyph",
        },
      }));
    decorationIds = editor.deltaDecorations(decorationIds, decorations);
  }

  const mouseSub = editor.onMouseDown((event) => {
    if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const line = event.target.position?.lineNumber;
    if (!line) return;
    options.toggle(line);
  });
  // 换文件、改行数都会让已画的行号失效：重建比增量维护可靠
  const modelSub = editor.onDidChangeModel(() => sync());
  const contentSub = editor.onDidChangeModelContent(() => sync());

  sync();
  return {
    sync,
    dispose() {
      mouseSub.dispose();
      modelSub.dispose();
      contentSub.dispose();
      decorationIds = editor.deltaDecorations(decorationIds, []);
    },
  };
}
