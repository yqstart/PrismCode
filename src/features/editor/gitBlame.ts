/**
 * 编辑器行内 git blame（对齐 Cursor / GitLens）：
 * - hover 任意行 → 悬浮显示该行最后提交信息（摘要 / 作者 / 短 hash / 日期）
 * - 可选常驻 blame 列：每段 blame 块首行显示「作者 + 短 hash」，其余行以细线衔接
 */
import {
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  keymap,
  showTooltip,
  type PluginValue,
  type Tooltip,
} from "@codemirror/view";
import {
  Prec,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import { gitBlame, type GitBlameLine } from "@/shared/gitApi";

const setBlameEffect = StateEffect.define<GitBlameLine[]>();

const blameField = StateField.define<GitBlameLine[]>({
  create: () => [],
  update: (value, tr) => {
    for (const e of tr.effects) {
      if (e.is(setBlameEffect)) return e.value;
    }
    return value;
  },
});

interface BlameTooltipState {
  line: number;
}

const setBlameTooltipEffect = StateEffect.define<BlameTooltipState | null>();

const blameTooltipField = StateField.define<BlameTooltipState | null>({
  create: () => null,
  update: (value, tr) => {
    for (const e of tr.effects) {
      if (e.is(setBlameTooltipEffect)) return e.value;
      // blame 数据重新加载时，旧文件/旧行的浮层不能继续显示。
      if (e.is(setBlameEffect)) return null;
    }
    // 光标移动、选区变化或输入时关闭信息卡，避免卡片跟着编辑内容残留。
    if (tr.docChanged || tr.selection) return null;
    return value;
  },
});

function shortHash(id: string): string {
  return id.slice(0, 7);
}

function truncateAuthor(name: string): string {
  const n = name.trim() || "?";
  return n.length > 12 ? `${n.slice(0, 11)}…` : n;
}

function authorInitial(name: string): string {
  const value = name.trim();
  return value ? Array.from(value)[0].toUpperCase() : "?";
}

class BlameMarker extends GutterMarker {
  constructor(
    private commitId: string,
    private start: boolean,
    private author: string,
    private hash: string,
  ) {
    super();
  }
  eq(other: GutterMarker): boolean {
    return (
      other instanceof BlameMarker &&
      other.commitId === this.commitId &&
      other.start === this.start
    );
  }
  toDOM(): Node {
    const el = document.createElement("div");
    el.className = "cm-prism-blame-line";
    if (this.start) {
      const author = document.createElement("span");
      author.className = "cm-prism-blame-author";
      author.textContent = truncateAuthor(this.author);
      const hash = document.createElement("span");
      hash.className = "cm-prism-blame-hash";
      hash.textContent = this.hash;
      el.append(author, hash);
    }
    return el;
  }
}

const blameTooltipTheme = EditorView.theme({
  ".cm-prism-blame-tooltip": {
    backgroundColor: "var(--bg-elevated)",
    color: "var(--text-primary)",
    border: "1px solid color-mix(in srgb, var(--accent) 18%, var(--border-subtle))",
    borderLeft: "2px solid var(--accent)",
    borderRadius: "7px",
    padding: "10px 12px 9px",
    minWidth: "180px",
    maxWidth: "360px",
    boxShadow: "var(--shadow-popover)",
    fontFamily: "var(--font-ui)",
    fontSize: "12px",
    lineHeight: "1.45",
    whiteSpace: "normal",
    overflow: "hidden",
    boxSizing: "border-box",
    // 信息卡只读，不参与编辑区鼠标命中，避免遮挡时截断点击/拖选。
    pointerEvents: "none",
    userSelect: "none",
  },
  ".cm-prism-blame-tooltip .summary": {
    margin: "0 0 8px",
    fontWeight: "600",
    fontSize: "13px",
    lineHeight: "1.4",
    color: "var(--text-primary)",
    wordBreak: "break-word",
  },
  ".cm-prism-blame-tooltip .meta": {
    display: "flex",
    alignItems: "center",
    gap: "5px",
    flexWrap: "wrap",
    minWidth: "0",
    fontSize: "11px",
    color: "var(--text-secondary)",
  },
  ".cm-prism-blame-tooltip .author": {
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    minWidth: "0",
    maxWidth: "18ch",
  },
  ".cm-prism-blame-tooltip .avatar": {
    width: "16px",
    height: "16px",
    flex: "0 0 16px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "50%",
    backgroundColor: "var(--accent-soft)",
    color: "var(--accent)",
    fontSize: "9px",
    fontWeight: "700",
    lineHeight: "1",
  },
  ".cm-prism-blame-tooltip .author-name": {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  ".cm-prism-blame-tooltip .separator": {
    color: "var(--text-muted)",
    opacity: "0.65",
    userSelect: "none",
  },
  ".cm-prism-blame-tooltip .meta .hash": {
    padding: "1px 5px",
    border: "1px solid var(--border-subtle)",
    borderRadius: "4px",
    backgroundColor: "var(--bg-inset)",
    color: "var(--accent)",
    fontFamily: "var(--prism-editor-font-family, var(--font-mono))",
    fontSize: "10px",
    lineHeight: "1.35",
  },
  ".cm-prism-blame-tooltip time": {
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
  },
});

const blameGutterTheme = EditorView.theme({
  ".cm-prism-blame": {
    backgroundColor: "color-mix(in srgb, var(--bg-panel) 55%, transparent)",
    textAlign: "left",
    whiteSpace: "nowrap",
  },
  ".cm-prism-blame .cm-gutterElement": {
    padding: "0 6px 0 4px",
  },
  ".cm-prism-blame-line": {
    height: "100%",
    borderLeft: "1px solid color-mix(in srgb, var(--text-muted) 22%, transparent)",
    paddingLeft: "5px",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    overflow: "hidden",
  },
  ".cm-prism-blame-author": {
    color: "var(--text-secondary)",
    fontSize: "11px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "12ch",
  },
  ".cm-prism-blame-hash": {
    color: "var(--text-muted)",
    fontSize: "10px",
    fontFamily: "var(--prism-editor-font-family, var(--font-mono))",
  },
});

export interface GitBlameOptions {
  root: string;
  relPath: string;
  /** 是否显示常驻 blame 列（hover 悬浮始终开启） */
  showGutter: boolean;
}

class GitBlamePlugin implements PluginValue {
  private gen = 0;
  private disposed = false;

  constructor(private view: EditorView, private opts: GitBlameOptions) {
    this.load();
  }

  async load(): Promise<void> {
    const gen = ++this.gen;
    let lines: GitBlameLine[];
    try {
      lines = await gitBlame(this.opts.root, this.opts.relPath);
    } catch {
      // 非 git 仓库 / blame 失败：静默，无 blame 信息
      return;
    }
    if (this.disposed || gen !== this.gen) return;
    this.view.dispatch({ effects: setBlameEffect.of(lines) });
  }

  destroy(): void {
    this.disposed = true;
  }
}

function blameTooltip(info: GitBlameLine, pos: number): Tooltip {
  return {
    pos,
    above: true,
    arrow: true,
    create(): { dom: HTMLElement } {
      const dom = document.createElement("div");
      dom.className = "cm-prism-blame-tooltip";
      dom.setAttribute("role", "tooltip");

      const summary = document.createElement("div");
      summary.className = "summary";
      summary.textContent = info.summary || "(无提交说明)";
      dom.appendChild(summary);

      const meta = document.createElement("div");
      meta.className = "meta";
      const author = document.createElement("span");
      author.className = "author";
      const avatar = document.createElement("span");
      avatar.className = "avatar";
      avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = authorInitial(info.author);
      const authorName = document.createElement("span");
      authorName.className = "author-name";
      authorName.textContent = info.author.trim() || "unknown";
      author.append(avatar, authorName);

      const firstSeparator = document.createElement("span");
      firstSeparator.className = "separator";
      firstSeparator.textContent = "·";

      const hash = document.createElement("span");
      hash.className = "hash";
      hash.textContent = shortHash(info.commitId);

      const secondSeparator = document.createElement("span");
      secondSeparator.className = "separator";
      secondSeparator.textContent = "·";

      const time = document.createElement("time");
      time.textContent = info.time;
      meta.append(author, firstSeparator, hash, secondSeparator, time);
      dom.appendChild(meta);

      return { dom };
    },
  };
}

const blameTooltipExtension = showTooltip.compute(
  [blameTooltipField, blameField],
  (state): Tooltip | null => {
    const active = state.field(blameTooltipField, false);
    if (!active) return null;
    const info = state.field(blameField)[active.line - 1];
    if (!info) return null;
    const line = state.doc.line(active.line);
    // 锚定到行尾，卡片尽量出现在代码右侧，不覆盖用户刚点击的行首。
    return blameTooltip(info, line.to);
  },
);

const BLAME_TRIGGER_SELECTOR = ".cm-lineNumbers, .cm-prism-blame";

function isBlameTriggerTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(BLAME_TRIGGER_SELECTOR) !== null;
}

function dismissBlameTooltip(view: EditorView): boolean {
  if (!view.state.field(blameTooltipField, false)) return false;
  view.dispatch({ effects: setBlameTooltipEffect.of(null) });
  return true;
}

export function gitBlameExtension(opts: GitBlameOptions): Extension {
  const plugin = ViewPlugin.define((view) => new GitBlamePlugin(view, opts));

  // 不再 hover 任意代码行：只有点击行号或常驻 blame gutter 才显示，避免编辑时
  // 鼠标经过代码就弹出大卡片。点击代码会关闭，Esc 也可关闭。
  const parts: Extension[] = [
    blameField,
    blameTooltipField,
    blameTooltipExtension,
    plugin,
    blameTooltipTheme,
    Prec.highest(
      keymap.of([
        {
          key: "Escape",
          run: dismissBlameTooltip,
        },
      ]),
    ),
    EditorView.domEventHandlers({
      click(event, view) {
        if (event.button !== 0 || event.detail !== 1) return false;
        if (!isBlameTriggerTarget(event.target)) {
          dismissBlameTooltip(view);
          return false;
        }
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        const line = view.state.doc.lineAt(pos);
        if (!view.state.field(blameField)[line.number - 1]) return false;
        const active = view.state.field(blameTooltipField, false);
        view.dispatch({
          effects: setBlameTooltipEffect.of(
            active?.line === line.number ? null : { line: line.number },
          ),
        });
        return true;
      },
    }),
  ];

  if (opts.showGutter) {
    parts.push(
      gutter({
        class: "cm-prism-blame",
        lineMarker(view, line) {
          const lines = view.state.field(blameField);
          const lineNo = view.state.doc.lineAt(line.from).number;
          const cur = lines[lineNo - 1];
          if (!cur) return null;
          const prev = lines[lineNo - 2];
          const start = !prev || prev.commitId !== cur.commitId;
          return new BlameMarker(
            cur.commitId,
            start,
            start ? cur.author : "",
            start ? shortHash(cur.commitId) : "",
          );
        },
      }),
      blameGutterTheme,
    );
  }

  return parts;
}
