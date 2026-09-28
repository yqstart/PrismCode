// ==================== Monaco 装饰层 ====================
// 对应原 CodeMirror 的 gitChanges.ts / gitBlame.ts / jumpHighlight.ts：
// - git 改动条（gutter glyph + 行背景 + 点击开 diff）
// - blame（行 hover 卡 + 可选常驻行尾列）
// - 跳转落点三重高亮（行 / 文本 / 行号）
import type { editor as MonacoEditorApi, IMarkdownString } from "monaco-editor/editor";
import { monaco } from "./setup";
import { gitBlame, gitHeadText, type GitBlameLine } from "@/shared/gitApi";
import { computeLineChanges, type GitChangeKind } from "@/features/editor/lineDiff";

const OVERVIEW_COLORS: Record<GitChangeKind, string> = {
  added: "#34d399",
  modified: "#60a5fa",
  deleted: "#f87171",
};

export interface GitDecorationsOptions {
  root: string;
  /** 仓库相对路径 */
  relPath: string;
  /** 点击改动条回调（打开该文件 Diff） */
  openDiff: () => void;
}

/** git 改动条：HEAD 文本与当前 model 逐行比对，随输入 250ms 防抖重算 */
export function installGitChanges(
  editor: MonacoEditorApi.IStandaloneCodeEditor,
  opts: GitDecorationsOptions,
): () => void {
  const collection = editor.createDecorationsCollection([]);
  let headText: string | null = null;
  let disposed = false;
  let generation = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const recompute = () => {
    const model = editor.getModel();
    if (disposed || headText === null || !model) return;
    const changes = computeLineChanges(headText, model.getValue());
    const decorations = changes
      .filter((change) => change.line <= model.getLineCount())
      .map((change) => ({
        range: new monaco.Range(change.line, 1, change.line, 1),
        options: {
          isWholeLine: true,
          className: `prism-git-bg prism-git-bg-${change.kind}`,
          linesDecorationsClassName: `prism-git-glyph prism-git-glyph-${change.kind}`,
          overviewRuler: {
            color: OVERVIEW_COLORS[change.kind],
            position: monaco.editor.OverviewRulerLane.Left,
          },
        },
      }));
    collection.set(decorations);
  };

  const load = async () => {
    const current = ++generation;
    let text: string;
    try {
      text = await gitHeadText(opts.root, opts.relPath);
    } catch {
      // 非 git 仓库 / 读取失败：静默，不渲染改动条
      return;
    }
    if (disposed || current !== generation) return;
    headText = text;
    recompute();
  };

  void load();

  const contentSub = editor.onDidChangeModelContent(() => {
    if (disposed) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      recompute();
    }, 250);
  });

  // 点击左侧改动条 → 打开该文件 Diff（对齐 VS Code / Cursor）
  const mouseSub = editor.onMouseDown((event) => {
    if (event.event.leftButton === false) return;
    const target = event.target;
    if (
      target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS &&
      target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
    ) {
      return;
    }
    const lineNumber = target.position?.lineNumber;
    const model = editor.getModel();
    if (!lineNumber || !model || headText === null) return;
    const changed = computeLineChanges(headText, model.getValue()).some(
      (change) => change.line === lineNumber,
    );
    if (changed) opts.openDiff();
  });

  return () => {
    disposed = true;
    clearTimeout(debounce);
    contentSub.dispose();
    mouseSub.dispose();
    collection.clear();
  };
}

export interface GitBlameController {
  /** 常驻列开关（hover 卡不受影响） */
  setVisible(visible: boolean): void;
  dispose(): void;
}

/** blame：每行 hoverMessage + 可选「作者 短hash」行尾常驻 */
export function installGitBlame(
  editor: MonacoEditorApi.IStandaloneCodeEditor,
  opts: { root: string; relPath: string; visible: boolean },
): GitBlameController {
  const collection = editor.createDecorationsCollection([]);
  let lines: GitBlameLine[] = [];
  let visible = opts.visible;
  let disposed = false;

  const render = () => {
    const model = editor.getModel();
    if (disposed || !model) return;
    const lineCount = model.getLineCount();
    const byLine = new Map<number, GitBlameLine>();
    for (const entry of lines) {
      if (entry.line >= 1 && entry.line <= lineCount) byLine.set(entry.line, entry);
    }
    if (!byLine.size) {
      collection.clear();
      return;
    }
    // 同一提交连续行只在块首显示常驻文本，避免每行重复
    const decorations: MonacoEditorApi.IModelDeltaDecoration[] = [];
    let previousCommit = "";
    for (let line = 1; line <= lineCount; line += 1) {
      const info = byLine.get(line);
      if (!info) {
        previousCommit = "";
        continue;
      }
      const isBlockStart = info.commitId !== previousCommit;
      previousCommit = info.commitId;
      const hover: IMarkdownString = {
        value: [
          `**${info.summary || "(无提交说明)"}**`,
          "",
          `${info.author} · \`${info.commitId.slice(0, 7)}\` · ${info.time}`,
        ].join("\n"),
      };
      decorations.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          hoverMessage: hover,
          ...(visible && isBlockStart
            ? {
              after: {
                content: `\u00a0\u00a0${info.author} ${info.commitId.slice(0, 7)}`,
                inlineClassName: "prism-blame-inline",
              },
            }
            : {}),
        },
      });
    }
    collection.set(decorations);
  };

  const load = async () => {
    let result: GitBlameLine[];
    try {
      result = await gitBlame(opts.root, opts.relPath);
    } catch {
      return;
    }
    if (disposed) return;
    lines = result;
    render();
  };

  void load();
  const modelSub = editor.onDidChangeModel(() => render());
  const contentSub = editor.onDidChangeModelContent(() => {
    if (lines.length) render();
  });

  return {
    setVisible(next: boolean) {
      if (visible === next) return;
      visible = next;
      render();
    },
    dispose() {
      disposed = true;
      modelSub.dispose();
      contentSub.dispose();
      collection.clear();
    },
  };
}

export interface JumpHighlightTarget {
  /** 目标文本起始 offset */
  from: number;
  /** 目标文本结束 offset（可与 from 相等） */
  to: number;
}

const JUMP_DURATION = 1800;

/** 跳转落点高亮：行背景 + 文本 + 行号，1.8s 后自动清除 */
export function flashJumpTarget(
  editor: MonacoEditorApi.IStandaloneCodeEditor,
  target: JumpHighlightTarget,
): void {
  const model = editor.getModel();
  if (!model) return;
  const start = model.getPositionAt(Math.max(0, Math.min(target.from, model.getValueLength())));
  const end = model.getPositionAt(Math.max(0, Math.min(target.to, model.getValueLength())));
  const collection = editor.createDecorationsCollection([
    {
      range: new monaco.Range(start.lineNumber, 1, start.lineNumber, 1),
      options: {
        isWholeLine: true,
        className: "prism-jump-line",
        lineNumberClassName: "prism-jump-gutter",
      },
    },
    {
      range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
      options: { inlineClassName: "prism-jump-target" },
    },
  ]);
  setTimeout(() => collection.clear(), JUMP_DURATION);
}
