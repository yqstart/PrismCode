// ==================== LSP ↔ Monaco 结构转换 ====================
// 只做纯数据转换。这里只能 import type，避免 node 直测把 Monaco 内核拉进来。
import type * as Monaco from "monaco-editor";

/** 取值等于 Monaco MarkerSeverity */
export const MARKER_SEVERITY = { error: 8, warning: 4, info: 2, hint: 1 } as const;

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface MarkupContent {
  kind: string;
  value: string;
}

export interface MarkedStringObject {
  language: string;
  value: string;
}

export type MarkedString = string | MarkedStringObject;

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface InsertReplaceEdit {
  insert: LspRange;
  replace: LspRange;
  newText: string;
}

export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | MarkupContent;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: LspTextEdit | InsertReplaceEdit;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  data?: unknown;
}

export interface LspHover {
  contents: MarkupContent | MarkedString | Array<MarkupContent | MarkedString>;
  range?: LspRange;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  message: string;
  code?: string | number;
  source?: string;
}

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: unknown[];
}

const COMPLETION_KIND_TO_MONACO: Record<number, number> = {
  1: 18,
  2: 0,
  3: 1,
  4: 2,
  5: 3,
  6: 4,
  7: 5,
  8: 7,
  9: 8,
  10: 9,
  11: 12,
  12: 13,
  13: 15,
  14: 17,
  15: 28,
  16: 19,
  17: 20,
  18: 21,
  19: 23,
  20: 16,
  21: 14,
  22: 6,
  23: 10,
  24: 11,
  25: 24,
};

export function uriToPath(uri: string): string {
  const raw = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  let path = decodeURIComponent(raw);
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  return path;
}

export function pathToUri(filePath: string): string {
  let normalized = filePath.replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(normalized) || !normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  const encoded = normalized
    .split("/")
    .map((segment, index) =>
      index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment),
    )
    .join("/");
  return `file://${encoded}`;
}

export function toLspPosition(position: { lineNumber: number; column: number }): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

export function toMonacoRange(range: LspRange): Monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

export function toMonacoSelection(range: LspRange): Monaco.Selection {
  const monacoRange = toMonacoRange(range);
  return {
    selectionStartLineNumber: monacoRange.startLineNumber,
    selectionStartColumn: monacoRange.startColumn,
    positionLineNumber: monacoRange.endLineNumber,
    positionColumn: monacoRange.endColumn,
  } as Monaco.Selection;
}

export function toMarkdownString(value: MarkupContent | MarkedString): Monaco.IMarkdownString {
  if (typeof value === "string") return { value };
  if ("kind" in value) return { value: value.value };
  return { value: `\`\`\`${value.language}\n${value.value}\n\`\`\`` };
}

export function toMonacoDocumentation(
  value: string | MarkupContent | undefined,
): string | Monaco.IMarkdownString | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  return toMarkdownString(value);
}

export function editRange(edit: { range: LspRange } | { insert: LspRange; replace: LspRange }): LspRange {
  return "range" in edit ? edit.range : edit.replace;
}

export function completionKindToMonaco(kind: number | undefined): Monaco.languages.CompletionItemKind {
  if (kind == null) return 18 as Monaco.languages.CompletionItemKind;
  return (COMPLETION_KIND_TO_MONACO[kind] ?? 18) as Monaco.languages.CompletionItemKind;
}

export function symbolKindToMonaco(kind: number): Monaco.languages.SymbolKind {
  const mapped = Math.min(25, Math.max(0, kind - 1));
  return mapped as Monaco.languages.SymbolKind;
}

export function toMonacoCompletion(
  item: LspCompletionItem,
  fallback: Monaco.IRange,
): Monaco.languages.CompletionItem {
  const edit = item.textEdit;
  const insertText = edit ? edit.newText : (item.insertText ?? item.label);
  const snippet = item.insertTextFormat === 2 || /[$][\d{]/.test(insertText);
  return {
    label: item.label,
    kind: completionKindToMonaco(item.kind),
    detail: item.detail,
    documentation: toMonacoDocumentation(item.documentation),
    insertText,
    insertTextRules: snippet ? (4 as Monaco.languages.CompletionItemInsertTextRule) : undefined,
    range: edit ? toMonacoRange(editRange(edit)) : fallback,
    sortText: item.sortText,
    filterText: item.filterText,
    preselect: item.preselect,
  };
}

export function toMonacoHover(hover: LspHover | null): Monaco.languages.Hover | null {
  if (!hover) return null;
  const contents = hover.contents
    ? (Array.isArray(hover.contents) ? hover.contents : [hover.contents]).map(toMarkdownString)
    : [];
  return {
    range: hover.range ? toMonacoRange(hover.range) : undefined,
    contents,
  };
}

export function toMonacoMarker(diagnostic: LspDiagnostic): Monaco.editor.IMarkerData {
  const range = toMonacoRange(diagnostic.range);
  const severity =
    diagnostic.severity === 1
      ? MARKER_SEVERITY.error
      : diagnostic.severity === 2
        ? MARKER_SEVERITY.warning
        : diagnostic.severity === 3
          ? MARKER_SEVERITY.info
          : diagnostic.severity === 4
            ? MARKER_SEVERITY.hint
            : MARKER_SEVERITY.warning;
  return {
    ...range,
    severity,
    message: diagnostic.message,
    source: "Java",
    code: diagnostic.code !== undefined ? String(diagnostic.code) : undefined,
  };
}

export function toMonacoTextEdits(edits: readonly LspTextEdit[]): Monaco.languages.TextEdit[] {
  return edits.map((edit) => ({
    range: toMonacoRange(edit.range),
    text: edit.newText,
  }));
}

export interface PathWorkspaceEdit {
  edits: Array<{ resource: string; textEdit: { range: Monaco.IRange; text: string } }>;
}

export function toMonacoWorkspaceEdit(edit: LspWorkspaceEdit, _root: string): PathWorkspaceEdit {
  const edits: PathWorkspaceEdit["edits"] = [];
  for (const [uri, changes] of Object.entries(edit.changes ?? {})) {
    if (uri.startsWith("jdt:")) continue;
    for (const change of changes) {
      edits.push({
        resource: uri,
        textEdit: { range: toMonacoRange(change.range), text: change.newText },
      });
    }
  }
  for (const change of edit.documentChanges ?? []) {
    if (!change || typeof change !== "object" || !("textDocument" in change)) continue;
    const documentChange = change as { textDocument?: { uri?: string }; edits?: LspTextEdit[] };
    const uri = documentChange.textDocument?.uri;
    if (!uri || uri.startsWith("jdt:")) continue;
    for (const textEdit of documentChange.edits ?? []) {
      edits.push({
        resource: uri,
        textEdit: { range: toMonacoRange(textEdit.range), text: textEdit.newText },
      });
    }
  }
  return { edits };
}

export function locationsFromResult(result: unknown): Array<{ uri: string; range: LspRange }> {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  const locations: Array<{ uri: string; range: LspRange }> = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const location = item as {
      uri?: string;
      range?: LspRange;
      targetUri?: string;
      targetRange?: LspRange;
    };
    const uri = location.uri ?? location.targetUri;
    const range = location.range ?? location.targetRange;
    if (uri && range) locations.push({ uri, range });
  }
  return locations;
}
