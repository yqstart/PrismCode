/**
 * 编辑器行内 git 改动条（对齐 VS Code / Cursor）：
 * - 左侧 gutter 显示改动条：added（绿）/ modified（蓝）/ deleted（红三角）
 * - 改动行淡背景高亮
 * - 点击改动条打开该文件的 Diff
 * - 纯前端 diff：buffer 与 HEAD 逐行对比（myersDiff），随输入实时更新
 */
import {
  Decoration,
  DecorationSet,
  EditorView,
  GutterMarker,
  ViewUpdate,
  gutter,
  ViewPlugin,
  type PluginValue,
} from "@codemirror/view";
import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import { gitHeadText } from "@/shared/gitApi";
import { computeLineChanges, type GitChangeKind, type LineChange } from "./lineDiff";

const setChangesEffect = StateEffect.define<LineChange[]>();

/** 行号（1-based）→ 改动类型 */
const changeField = StateField.define<Map<number, GitChangeKind>>({
  create: () => new Map(),
  update: (value, tr) => {
    for (const e of tr.effects) {
      if (e.is(setChangesEffect)) {
        const map = new Map<number, GitChangeKind>();
        for (const c of e.value) map.set(c.line, c.kind);
        return map;
      }
    }
    return value;
  },
});

/** 改动行淡背景 */
const changeDecorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (deco, tr) => {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setChangesEffect)) {
        const doc = tr.state.doc;
        const builder = new RangeSetBuilder<Decoration>();
        for (const c of e.value) {
          const lineNo = Math.min(c.line, doc.lines);
          const line = doc.line(lineNo);
          builder.add(
            line.from,
            line.from,
            Decoration.line({ class: `cm-prism-git-bg cm-prism-git-bg-${c.kind}` }),
          );
        }
        return builder.finish();
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: GitChangeKind) {
    super();
  }
  eq(other: GutterMarker): boolean {
    return other instanceof ChangeMarker && other.kind === this.kind;
  }
  toDOM(): Node {
    const el = document.createElement("div");
    el.className = `cm-prism-git-change cm-prism-git-change-${this.kind}`;
    return el;
  }
}

const changeTheme = EditorView.theme({
  // 干净文件时整列收起（0 宽）；有改动 marker 时 :has 命中再撑到 6px。
  // 注意：此处不能配 initialSpacer——spacer 自带 marker 会让 :has 永远命中。
  // 也不用 display:none——CM 基础样式是 display:flex !important，普通声明盖不住。
  ".cm-prism-git-changes": {
    width: "0",
    overflow: "hidden",
    flexShrink: "0",
  },
  ".cm-prism-git-changes:has(.cm-prism-git-change)": {
    width: "6px",
  },
  ".cm-prism-git-changes .cm-gutterElement": {
    padding: "0",
  },
  ".cm-prism-git-change": {
    width: "100%",
    height: "100%",
    boxSizing: "border-box",
  },
  ".cm-prism-git-change-added": { backgroundColor: "var(--success)" },
  ".cm-prism-git-change-modified": { backgroundColor: "var(--accent)" },
  ".cm-prism-git-change-deleted": {
    position: "relative",
    background: "transparent",
  },
  ".cm-prism-git-change-deleted::after": {
    content: "''",
    position: "absolute",
    top: "2px",
    left: "0",
    width: "0",
    height: "0",
    borderLeft: "3px solid transparent",
    borderRight: "3px solid transparent",
    borderTop: "5px solid var(--danger)",
  },
  ".cm-prism-git-bg-added": {
    backgroundColor: "color-mix(in srgb, var(--success) 12%, transparent)",
  },
  ".cm-prism-git-bg-modified": {
    backgroundColor: "color-mix(in srgb, var(--accent) 10%, transparent)",
  },
  ".cm-prism-git-bg-deleted": {
    backgroundColor: "color-mix(in srgb, var(--danger) 9%, transparent)",
  },
});

export interface GitChangesOptions {
  root: string;
  /** 仓库相对路径 */
  relPath: string;
  /** 点击改动条回调（打开该文件 Diff） */
  openDiff: () => void;
}

class GitChangesPlugin implements PluginValue {
  private headText: string | null = null;
  private gen = 0;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private view: EditorView, private opts: GitChangesOptions) {
    this.load();
  }

  async load(): Promise<void> {
    const gen = ++this.gen;
    let text: string;
    try {
      text = await gitHeadText(this.opts.root, this.opts.relPath);
    } catch {
      // 非 git 仓库 / 读取失败：静默，不渲染改动条
      return;
    }
    if (this.disposed || gen !== this.gen) return;
    this.headText = text;
    this.recompute();
  }

  private recompute(): void {
    if (this.headText === null) return;
    const changes = computeLineChanges(
      this.headText,
      this.view.state.doc.toString(),
    );
    this.view.dispatch({ effects: setChangesEffect.of(changes) });
  }

  update(u: ViewUpdate): void {
    if (u.docChanged && !this.disposed) {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {
        this.debounce = null;
        if (!this.disposed) this.recompute();
      }, 250);
    }
  }

  destroy(): void {
    this.disposed = true;
    if (this.debounce) clearTimeout(this.debounce);
  }
}

export function gitChangesExtension(opts: GitChangesOptions): Extension {
  const plugin = ViewPlugin.define(
    (view) => new GitChangesPlugin(view, opts),
  );

  function changeGutter(openDiff: () => void) {
    return gutter({
      class: "cm-prism-git-changes",
      lineMarker(view, line) {
        const map = view.state.field(changeField);
        const lineNo = view.state.doc.lineAt(line.from).number;
        const kind = map.get(lineNo);
        return kind ? new ChangeMarker(kind) : null;
      },
      domEventHandlers: {
        mousedown(view, line, event) {
          if ((event as MouseEvent).button !== 0) return false;
          const map = view.state.field(changeField);
          const lineNo = view.state.doc.lineAt(line.from).number;
          if (!map.has(lineNo)) return false;
          openDiff();
          return true;
        },
      },
    });
  }

  return [
    changeField,
    changeDecorField,
    changeGutter(opts.openDiff),
    changeTheme,
    plugin,
  ];
}
