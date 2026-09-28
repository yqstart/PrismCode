// ==================== Prism 主题 → Monaco 主题 ====================
// 4 套主题与 styles/themes/*.css 同源取值；Monaco 主题名即 ThemeId，
// 切换时直接 monaco.editor.setTheme(themeId)。
import type { ThemeId } from "@/shared/types";
import type { editor as MonacoEditorApi } from "monaco-editor/editor";
import { monaco } from "./monaco/setup";

interface SyntaxColors {
 keyword: string;
 controlKeyword: string;
 string: string;
 comment: string;
 function: string;
 number: string;
 boolean: string;
 property: string;
 type: string;
 operator: string;
 punctuation: string;
 tag: string;
 attribute: string;
 regexp: string;
 variable: string;
 unit: string;
 modifier: string;
 meta: string;
 invalid: string;
 link: string;
}

interface EditorColors {
 base: "vs" | "vs-dark";
 bg: string;
 fg: string;
 gutter: string;
 gutterFg: string;
 activeLine: string;
 selection: string;
 selectionMatch: string;
 caret: string;
 syntax: SyntaxColors;
}

/** CM HighlightStyle 的 tag 分组 → Monaco token 名（含 TS 语义 token）。
 *  同色槽共享颜色，避免 4 套主题各写一份 token 列表。 */
const TOKEN_GROUPS: Record<keyof SyntaxColors, string[]> = {
 keyword: ["keyword", "keyword.flow", "keyword.json", "keyword.operator", "tag.keyword"],
 controlKeyword: ["keyword.control", "keyword.control.flow", "keyword.control.import"],
 string: ["string", "string.value", "string.key.json", "string.escape", "string.quote"],
 comment: ["comment", "comment.line", "comment.block", "comment.doc"],
 function: ["function", "function.call", "function.declaration", "support.function"],
 number: ["number", "number.hex", "number.float", "number.binary", "number.octal"],
 boolean: ["keyword.constant", "constant", "constant.language", "constant.numeric.bool"],
 property: [
  "property",
  "property.readonly",
  "variable.property",
  "variable.object.property",
  "support.variable.property",
  "string.key.json",
  "key",
 ],
 type: [
  "type",
  "type.identifier",
  "typeParameter",
  "class",
  "class.name",
  "interface",
  "enum",
  "enumMember",
  "namespace",
  "struct",
  "entity.name.type",
 ],
 operator: ["operator", "operator.key", "operator.assignment"],
 punctuation: ["delimiter", "delimiter.bracket", "delimiter.array", "delimiter.colon", "delimiter.comma", "punctuation"],
 tag: ["tag", "tag.name", "metatag"],
 attribute: ["attribute.name", "attribute.value", "attribute.name.html", "attribute.value.html"],
 regexp: ["regexp", "regexp.constant"],
 variable: [
  "variable",
  "variable.name",
  "variable.parameter",
  "parameter",
  "identifier",
  "variable.language",
  "variable.predefined",
 ],
 unit: ["keyword.other.unit"],
 modifier: ["modifier", "storage", "storage.type", "storage.modifier", "keyword.modifier"],
 meta: ["annotation", "meta", "meta.tag", "processingInstruction", "predefined"],
 invalid: ["invalid", "invalid.illegal"],
 link: ["markdown.link", "markdown.link.title", "link"],
};

const THEMES: Record<ThemeId, EditorColors> = {
 "prism-dark": {
  base: "vs-dark",
  bg: "#141519",
  fg: "#f4f4f5",
  gutter: "#1b1d22",
  gutterFg: "#a2a7b4",
  activeLine: "#a78bfa1c",
  selection: "#a78bfa8c",
  selectionMatch: "#a78bfa2e",
  caret: "#a78bfa",
  syntax: {
   keyword: "#d8b4fe",
   controlKeyword: "#d8b4fe",
   string: "#d9f99d",
   comment: "#8b93a1",
   function: "#a5b4fc",
   number: "#fdba74",
   boolean: "#fdba74",
   property: "#fcd34d",
   type: "#fcd34d",
   operator: "#a5f3fc",
   punctuation: "#a5f3fc",
   tag: "#fca5a5",
   attribute: "#fcd34d",
   regexp: "#a5f3fc",
   variable: "#ffffff",
   unit: "#fdba74",
   modifier: "#d8b4fe",
   meta: "#a5f3fc",
   invalid: "#ff8a99",
   link: "#a5b4fc",
  },
 },
 dawn: {
  base: "vs",
  bg: "#ffffff",
  fg: "#1c2029",
  gutter: "#f1f3f6",
  gutterFg: "#5b6472",
  activeLine: "#4f6fe817",
  selection: "#4f6fe847",
  selectionMatch: "#4f6fe81c",
  caret: "#4f6fe8",
  syntax: {
   keyword: "#1e3a8a",
   controlKeyword: "#1e3a8a",
   string: "#047857",
   comment: "#5b6472",
   function: "#6d28d9",
   number: "#b91c1c",
   boolean: "#b45309",
   property: "#0e7490",
   type: "#1e3a8a",
   operator: "#334155",
   punctuation: "#475569",
   tag: "#1d4ed8",
   attribute: "#0f766e",
   regexp: "#a21caf",
   variable: "#1c2029",
   unit: "#b91c1c",
   modifier: "#1d4ed8",
   meta: "#475569",
   invalid: "#dc2626",
   link: "#1d4ed8",
  },
 },
 midnight: {
  base: "vs-dark",
  bg: "#0b1322",
  fg: "#eef4fc",
  gutter: "#111b30",
  gutterFg: "#96a3ba",
  activeLine: "#5ea1ff1c",
  selection: "#5ea1ff61",
  selectionMatch: "#5ea1ff24",
  caret: "#5ea1ff",
  syntax: {
   keyword: "#7dd3fc",
   controlKeyword: "#38bdf8",
   string: "#6ee7b7",
   comment: "#7f8da3",
   function: "#bfdbfe",
   number: "#fcd34d",
   boolean: "#fde68a",
   property: "#bae6fd",
   type: "#c7d2fe",
   operator: "#e2e8f0",
   punctuation: "#a9b8d0",
   tag: "#7dd3fc",
   attribute: "#67e8f9",
   regexp: "#f9a8d4",
   variable: "#f8fafc",
   unit: "#fcd34d",
   modifier: "#c7d2fe",
   meta: "#a9b8d0",
   invalid: "#fca5a5",
   link: "#bfdbfe",
  },
 },
 cyberpunk: {
  base: "vs-dark",
  bg: "#0e0c16",
  fg: "#f6f3fc",
  gutter: "#171425",
  gutterFg: "#a09cb4",
  activeLine: "#5eead41f",
  selection: "#5eead461",
  selectionMatch: "#5eead424",
  caret: "#5eead4",
  syntax: {
   keyword: "#f9a8d4",
   controlKeyword: "#fda4af",
   string: "#6ee7b7",
   comment: "#8f8aa3",
   function: "#67e8f9",
   number: "#fcd34d",
   boolean: "#fde68a",
   property: "#f0abfc",
   type: "#a5f3fc",
   operator: "#f5f3ff",
   punctuation: "#ddd6fe",
   tag: "#f9a8d4",
   attribute: "#c4b5fd",
   regexp: "#fda4af",
   variable: "#ffffff",
   unit: "#fcd34d",
   modifier: "#a5f3fc",
   meta: "#ddd6fe",
   invalid: "#fda4af",
   link: "#67e8f9",
  },
 },
};

function buildTheme(colors: EditorColors): MonacoEditorApi.IStandaloneThemeData {
 const rules: MonacoEditorApi.ITokenThemeRule[] = [];
 for (const [slot, tokens] of Object.entries(TOKEN_GROUPS) as [
  keyof SyntaxColors,
  string[],
 ][]) {
  const foreground = colors.syntax[slot].replace("#", "");
  const fontStyle = slot === "comment" ? "italic" : undefined;
  for (const token of tokens) {
   rules.push(fontStyle ? { token, foreground, fontStyle } : { token, foreground });
  }
 }
 // 注释在语义 token 下也可能走 comment 前缀，单独补全斜体
 rules.push({ token: "comment", foreground: colors.syntax.comment.replace("#", ""), fontStyle: "italic" });

 return {
  base: colors.base,
  inherit: true,
  rules,
  colors: {
   "editor.background": colors.bg,
   "editor.foreground": colors.fg,
   "editorCursor.foreground": colors.caret,
   "editor.lineHighlightBackground": colors.activeLine,
   "editor.lineHighlightBorder": "#00000000",
   "editor.selectionBackground": colors.selection,
   "editor.inactiveSelectionBackground": colors.selectionMatch,
   "editor.selectionHighlightBackground": colors.selectionMatch,
   "editor.selectionHighlightBorder": "#00000000",
   "editor.wordHighlightBackground": colors.selectionMatch,
   "editor.wordHighlightStrongBackground": colors.selectionMatch,
   "editor.findMatchBackground": colors.selection,
   "editor.findMatchHighlightBackground": colors.selectionMatch,
   "editorGutter.background": colors.gutter,
   "editorLineNumber.foreground": colors.gutterFg,
   "editorLineNumber.activeForeground": colors.fg,
   "editorGutter.addedBackground": "#34d399",
   "editorGutter.modifiedBackground": "#60a5fa",
   "editorGutter.deletedBackground": "#f87171",
   "editorError.foreground": "#f87171",
   "editorWarning.foreground": "#fbbf24",
   "editorInfo.foreground": "#60a5fa",
   "editorHint.foreground": "#a78bfa",
   "editorIndentGuide.background1": colors.base === "vs" ? "#00000012" : "#ffffff14",
   "editorIndentGuide.activeBackground1": colors.base === "vs" ? "#00000030" : "#ffffff33",
   "editorBracketHighlight.foreground1": colors.syntax.punctuation,
   "editorBracketHighlight.foreground2": colors.syntax.keyword,
   "editorBracketHighlight.foreground3": colors.syntax.function,
   "editorBracketHighlight.foreground4": colors.syntax.property,
   "editorBracketHighlight.foreground5": colors.syntax.tag,
   "editorBracketHighlight.foreground6": colors.syntax.regexp,
   "editorBracketMatch.background": colors.selectionMatch,
   "editorBracketMatch.border": colors.syntax.operator,
   "editorWidget.background": colors.gutter,
   "editorWidget.foreground": colors.fg,
   "editorWidget.border": colors.base === "vs" ? "#00000018" : "#ffffff1f",
   "editorSuggestWidget.background": colors.gutter,
   "editorSuggestWidget.foreground": colors.fg,
   "editorSuggestWidget.selectedBackground": colors.selectionMatch,
   "editorSuggestWidget.highlightForeground": colors.syntax.function,
   "editorHoverWidget.background": colors.gutter,
   "editorHoverWidget.foreground": colors.fg,
   "input.background": colors.bg,
   "input.foreground": colors.fg,
   "input.border": colors.base === "vs" ? "#00000018" : "#ffffff1f",
   "editorOverviewRuler.border": "#00000000",
   "editorOverviewRuler.errorForeground": "#f87171",
   "editorOverviewRuler.warningForeground": "#fbbf24",
   "editorStickyScroll.background": colors.gutter,
   "editorStickyScrollHover.background": colors.activeLine,
   "scrollbarSlider.background": colors.base === "vs" ? "#00000022" : "#ffffff22",
   "scrollbarSlider.hoverBackground": colors.base === "vs" ? "#00000033" : "#ffffff33",
   "scrollbarSlider.activeBackground": colors.base === "vs" ? "#00000044" : "#ffffff44",
   "editorLink.activeForeground": colors.syntax.link,
   "editorLightBulb.foreground": colors.syntax.property,
   "editorLightBulbAutoFix.foreground": colors.syntax.function,
   "minimap.background": colors.bg,
   // 差异视图：与 toolbar 的 --diff-* 语义一致（绿增 / 红删）
   "diffEditor.insertedTextBackground": "#34d3992e",
   "diffEditor.removedTextBackground": "#f871712e",
   "diffEditor.insertedLineBackground": "#34d39914",
   "diffEditor.removedLineBackground": "#f8717114",
   "diffEditorGutter.insertedLineBackground": "#34d39926",
   "diffEditorGutter.removedLineBackground": "#f8717126",
   "diffEditorOverview.insertedForeground": "#34d399",
   "diffEditorOverview.removedForeground": "#f87171",
   "diffEditor.diagonalFill": colors.base === "vs" ? "#00000014" : "#ffffff14",
   "diffEditor.border": colors.base === "vs" ? "#00000018" : "#ffffff1f",
  },
 };
}

let registered = false;

/** 幂等注册 4 套 Monaco 主题（base 变更需先注册再 setTheme） */
export function registerMonacoThemes(): void {
 if (registered) return;
 registered = true;
 for (const [id, colors] of Object.entries(THEMES) as [ThemeId, EditorColors][]) {
  monaco.editor.defineTheme(id, buildTheme(colors));
 }
}
