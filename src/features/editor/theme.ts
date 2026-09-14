import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import type { ThemeId } from "@/shared/types";

interface ThemePalette {
  bg: string;
  fg: string;
  gutter: string;
  gutterFg: string;
  activeLine: string;
  /** 当前选区：应明显亮于 selectionMatch */
  selection: string;
  /** 与选区相同文本的其它出现：弱提示，不可压过选区 */
  selectionMatch: string;
  caret: string;
  isDark: boolean;
  highlight: HighlightStyle;
}

/** Prism Dark：提高饱和度与明度，避免语法色偏灰发暗 */
const darkHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "#d8b4fe" },
  { tag: t.controlKeyword, color: "#d8b4fe" },
  { tag: t.moduleKeyword, color: "#d8b4fe" },
  { tag: t.operatorKeyword, color: "#a5f3fc" },
  { tag: t.string, color: "#d9f99d" },
  { tag: t.special(t.string), color: "#fca5a5" },
  { tag: t.comment, color: "#8b93a1", fontStyle: "italic" },
  { tag: t.lineComment, color: "#8b93a1", fontStyle: "italic" },
  { tag: t.blockComment, color: "#8b93a1", fontStyle: "italic" },
  { tag: t.function(t.variableName), color: "#a5b4fc" },
  { tag: t.definition(t.function(t.variableName)), color: "#a5b4fc" },
  { tag: t.number, color: "#fdba74" },
  { tag: t.bool, color: "#fdba74" },
  { tag: t.null, color: "#fdba74" },
  { tag: t.propertyName, color: "#fcd34d" },
  { tag: t.definition(t.propertyName), color: "#fcd34d" },
  { tag: t.attributeName, color: "#fcd34d" },
  { tag: t.typeName, color: "#fcd34d" },
  { tag: t.className, color: "#fcd34d" },
  { tag: t.namespace, color: "#fcd34d" },
  { tag: t.operator, color: "#a5f3fc" },
  { tag: t.punctuation, color: "#a5f3fc" },
  { tag: t.bracket, color: "#a5f3fc" },
  { tag: t.tagName, color: "#fca5a5" },
  { tag: t.angleBracket, color: "#a5f3fc" },
  { tag: t.regexp, color: "#a5f3fc" },
  { tag: t.variableName, color: "#ffffff" },
  { tag: t.definition(t.variableName), color: "#ffffff" },
  { tag: t.special(t.variableName), color: "#fca5a5" },
  { tag: t.literal, color: "#fdba74" },
  { tag: t.unit, color: "#fdba74" },
  { tag: t.color, color: "#fdba74" },
  { tag: t.modifier, color: "#d8b4fe" },
  { tag: t.labelName, color: "#d8b4fe" },
  { tag: t.heading, color: "#d8b4fe", fontWeight: "bold" },
  { tag: t.link, color: "#a5b4fc", textDecoration: "underline" },
  { tag: t.url, color: "#a5f3fc" },
  { tag: t.meta, color: "#a5f3fc" },
  { tag: t.processingInstruction, color: "#a5f3fc" },
  { tag: t.invalid, color: "#ff8a99" },
]);

const lightHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "#1e3a8a" },
  { tag: t.controlKeyword, color: "#1e3a8a" },
  { tag: t.string, color: "#047857" },
  { tag: t.comment, color: "#5b6472", fontStyle: "italic" },
  { tag: t.lineComment, color: "#5b6472", fontStyle: "italic" },
  { tag: t.blockComment, color: "#5b6472", fontStyle: "italic" },
  { tag: t.function(t.variableName), color: "#6d28d9" },
  { tag: t.definition(t.function(t.variableName)), color: "#5b21b6" },
  { tag: t.number, color: "#b91c1c" },
  { tag: t.bool, color: "#b45309" },
  { tag: t.null, color: "#b45309" },
  { tag: t.propertyName, color: "#0e7490" },
  { tag: t.definition(t.propertyName), color: "#155e75" },
  { tag: t.typeName, color: "#1e3a8a" },
  { tag: t.className, color: "#1e3a8a" },
  { tag: t.operator, color: "#334155" },
  { tag: t.punctuation, color: "#475569" },
  { tag: t.bracket, color: "#334155" },
  { tag: t.tagName, color: "#1d4ed8" },
  { tag: t.attributeName, color: "#0f766e" },
  { tag: t.regexp, color: "#a21caf" },
  { tag: t.variableName, color: "#1c2029" },
  { tag: t.definition(t.variableName), color: "#1c2029" },
  { tag: t.special(t.variableName), color: "#7c3aed" },
  { tag: t.unit, color: "#b91c1c" },
  { tag: t.color, color: "#b91c1c" },
  { tag: t.modifier, color: "#1d4ed8" },
  { tag: t.heading, color: "#1d4ed8", fontWeight: "bold" },
  { tag: t.link, color: "#1d4ed8", textDecoration: "underline" },
  { tag: t.url, color: "#0369a1" },
  { tag: t.meta, color: "#475569" },
  { tag: t.invalid, color: "#dc2626" },
]);

const midnightHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "#7dd3fc" },
  { tag: t.controlKeyword, color: "#38bdf8" },
  { tag: t.string, color: "#6ee7b7" },
  { tag: t.comment, color: "#7f8da3", fontStyle: "italic" },
  { tag: t.function(t.variableName), color: "#bfdbfe" },
  { tag: t.definition(t.function(t.variableName)), color: "#dbeafe" },
  { tag: t.number, color: "#fcd34d" },
  { tag: t.bool, color: "#fde68a" },
  { tag: t.null, color: "#fde68a" },
  { tag: t.propertyName, color: "#bae6fd" },
  { tag: t.typeName, color: "#c7d2fe" },
  { tag: t.className, color: "#c7d2fe" },
  { tag: t.operator, color: "#e2e8f0" },
  { tag: t.punctuation, color: "#a9b8d0" },
  { tag: t.tagName, color: "#7dd3fc" },
  { tag: t.attributeName, color: "#67e8f9" },
  { tag: t.regexp, color: "#f9a8d4" },
  { tag: t.variableName, color: "#f8fafc" },
  { tag: t.unit, color: "#fcd34d" },
  { tag: t.color, color: "#fcd34d" },
  { tag: t.invalid, color: "#fca5a5" },
]);

const cyberHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "#f9a8d4" },
  { tag: t.controlKeyword, color: "#fda4af" },
  { tag: t.string, color: "#6ee7b7" },
  { tag: t.comment, color: "#8f8aa3", fontStyle: "italic" },
  { tag: t.function(t.variableName), color: "#67e8f9" },
  { tag: t.definition(t.function(t.variableName)), color: "#a5f3fc" },
  { tag: t.number, color: "#fcd34d" },
  { tag: t.bool, color: "#fde68a" },
  { tag: t.null, color: "#fde68a" },
  { tag: t.propertyName, color: "#f0abfc" },
  { tag: t.typeName, color: "#a5f3fc" },
  { tag: t.className, color: "#a5f3fc" },
  { tag: t.operator, color: "#f5f3ff" },
  { tag: t.punctuation, color: "#ddd6fe" },
  { tag: t.tagName, color: "#f9a8d4" },
  { tag: t.attributeName, color: "#c4b5fd" },
  { tag: t.regexp, color: "#fda4af" },
  { tag: t.variableName, color: "#ffffff" },
  { tag: t.unit, color: "#fcd34d" },
  { tag: t.color, color: "#fcd34d" },
  { tag: t.invalid, color: "#fda4af" },
]);

const PALETTES: Record<ThemeId, ThemePalette> = {
  "prism-dark": {
    bg: "#141519",
    fg: "#f4f4f5",
    gutter: "#1b1d22",
    gutterFg: "#a2a7b4",
    activeLine: "rgba(167,139,250,0.11)",
    selection: "rgba(167,139,250,0.55)",
    selectionMatch: "rgba(167,139,250,0.18)",
    caret: "#a78bfa",
    isDark: true,
    highlight: darkHighlight,
  },
  dawn: {
    bg: "#ffffff",
    fg: "#1c2029",
    gutter: "#f1f3f6",
    gutterFg: "#5b6472",
    activeLine: "rgba(79,111,232,0.09)",
    selection: "rgba(79,111,232,0.28)",
    selectionMatch: "rgba(79,111,232,0.11)",
    caret: "#4f6fe8",
    isDark: false,
    highlight: lightHighlight,
  },
  midnight: {
    bg: "#0b1322",
    fg: "#eef4fc",
    gutter: "#111b30",
    gutterFg: "#96a3ba",
    activeLine: "rgba(94,161,255,0.11)",
    selection: "rgba(94,161,255,0.38)",
    selectionMatch: "rgba(94,161,255,0.14)",
    caret: "#5ea1ff",
    isDark: true,
    highlight: midnightHighlight,
  },
  cyberpunk: {
    bg: "#0e0c16",
    fg: "#f6f3fc",
    gutter: "#171425",
    gutterFg: "#a09cb4",
    activeLine: "rgba(94,234,212,0.12)",
    selection: "rgba(94,234,212,0.38)",
    selectionMatch: "rgba(94,234,212,0.14)",
    caret: "#5eead4",
    isDark: true,
    highlight: cyberHighlight,
  },
};

function uiTheme(palette: ThemePalette): Extension {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        backgroundColor: palette.bg,
        color: palette.fg,
        fontSize: "inherit",
        fontFamily: "var(--prism-editor-font-family, var(--font-mono))",
      },
      ".cm-scroller": {
        fontFamily: "var(--prism-editor-font-family, var(--font-mono))",
        lineHeight: "1.65",
      },
      ".cm-content": {
        caretColor: palette.caret,
        paddingBottom: "40vh",
        userSelect: "text",
        WebkitUserSelect: "text",
      },
      ".cm-gutters": {
        backgroundColor: palette.gutter,
        color: palette.gutterFg,
        border: "none",
        borderRight: "1px solid var(--border-subtle)",
        padding: "0",
      },
      /* 主编辑器侧栏（gutter）按内容收缩，避免行号与折叠区之间留下大块空白。 */
      ".cm-gutter": {
        flex: "0 0 auto",
      },
      // 诊断 gutter：无诊断 marker 时收起（宽度 0 + 无内边距），有诊断时按
      // lint 默认 1.4em 展示；CSS :has 按行内实际 marker 开关，无需 JS 监听。
      ".cm-gutter-lint": {
        width: "0",
        overflow: "hidden",
      },
      ".cm-gutter-lint:has(.cm-lint-marker)": {
        width: "1.4em",
      },
      ".cm-gutter-lint .cm-gutterElement": {
        padding: "0",
      },
      ".cm-gutter-lint:has(.cm-lint-marker) .cm-gutterElement": {
        padding: ".2em",
      },
      ".cm-foldGutter": {
        flex: "0 0 18px",
        width: "18px",
        minWidth: "18px",
      },
      ".cm-foldGutter .cm-gutterElement": {
        width: "100%",
        padding: "0 2px 0 4px",
      },
      ".cm-lineNumbers": {
        flex: "0 0 auto",
        width: "auto",
        minWidth: "0",
        maxWidth: "max-content",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        width: "auto",
        minWidth: "0",
        padding: "0 5px 0 3px",
        fontVariantNumeric: "tabular-nums",
      },
      ".cm-activeLine": {
        backgroundColor: palette.activeLine,
      },
      ".cm-activeLineGutter": {
        backgroundColor: palette.activeLine,
        color: palette.fg,
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
      {
        backgroundColor: palette.selection,
      },
      /* 相同文本其它出现：弱于当前选区，避免「选中反而更暗」 */
      ".cm-selectionMatch": {
        backgroundColor: palette.selectionMatch,
      },
      ".cm-selectionMatch.cm-selectionBackground, &.cm-focused .cm-selectionMatch.cm-selectionBackground":
      {
        backgroundColor: palette.selection,
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeft: `2px solid ${palette.caret}`,
        marginLeft: "-1px",
        boxShadow: `0 0 8px color-mix(in srgb, ${palette.caret} 72%, transparent)`,
        zIndex: "2",
      },
      // 失焦时保留最后光标位置，切回编辑器时无需重新寻找落点。
      "&:not(.cm-focused) > .cm-scroller > .cm-cursorLayer .cm-cursor": {
        display: "block",
        opacity: "0.72",
      },
      ".cm-lintRange-error": {
        backgroundImage: "url('data:image/svg+xml,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"6\" height=\"3\"><path d=\"m0 3 l2 -2 l1 0 l2 2\" fill=\"%23f87171\"/></svg>')",
      },
      ".cm-lintRange-warning": {
        backgroundImage: "url('data:image/svg+xml,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"6\" height=\"3\"><path d=\"m0 3 l2 -2 l1 0 l2 2\" fill=\"%23fbbf24\"/></svg>')",
      },
    },
    { dark: palette.isDark },
  );
}

export function editorThemeExtensions(theme: ThemeId): Extension[] {
  const palette = PALETTES[theme];
  return [
    uiTheme(palette),
    syntaxHighlighting(palette.highlight, { fallback: true }),
  ];
}

export const THEME_LABELS: Record<ThemeId, string> = {
  "prism-dark": "Prism Dark",
  dawn: "Prism Light",
  midnight: "Prism Midnight",
  cyberpunk: "Prism Cyberpunk",
};

/** 状态栏快捷切换顺序 */
export const THEME_ORDER: ThemeId[] = [
  "prism-dark",
  "dawn",
  "midnight",
  "cyberpunk",
];
