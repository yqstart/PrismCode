// ==================== Java Monaco providers ====================
import { monaco } from "@/features/editor/monaco/setup";
import type { LspClient } from "@/features/editor/lsp/client";
import {
  locationsFromResult,
  symbolKindToMonaco,
  toLspPosition,
  toMonacoCompletion,
  toMonacoHover,
  toMonacoRange,
  toMonacoTextEdits,
  toMonacoWorkspaceEdit,
  uriToPath,
  type LspCompletionItem,
  type LspHover,
  type LspTextEdit,
  type LspWorkspaceEdit,
} from "@/features/editor/lsp/convert";
import { JAVA_LANGUAGE_ID } from "@/features/java/jdtls";
import { openJavaVirtualClass } from "@/features/java/javaVirtualDocs";
import { useEditorStore } from "@/stores/editor";

const completionItems = new WeakMap<object, LspCompletionItem>();
const codeActions = new WeakMap<object, Record<string, unknown>>();
let registered = false;
let openerInstalled = false;

function fallbackRange(model: monaco.editor.ITextModel, position: monaco.Position): monaco.IRange {
  const line = model.getLineContent(position.lineNumber);
  const before = line.slice(0, position.column - 1);
  const match = before.match(/[\w$]*$/);
  return {
    startLineNumber: position.lineNumber,
    startColumn: position.column - (match?.[0].length ?? 0),
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  };
}

function installOpener(): void {
  if (openerInstalled) return;
  openerInstalled = true;
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selection) {
      const line =
        selection && "startLineNumber" in selection ? selection.startLineNumber : (selection?.lineNumber ?? 1);
      const column =
        selection && "startColumn" in selection ? selection.startColumn : (selection?.column ?? 1);
      if (resource.scheme === "file") {
        void useEditorStore().openFileAt(uriToPath(resource.toString()), line, column);
        return true;
      }
      if (resource.scheme === "jdt") {
        void openJavaVirtualClass(resource.toString());
        return true;
      }
      return false;
    },
  });
}

async function withClient<T>(
  deps: { ensureSession(): Promise<boolean>; client(): LspClient | null },
  run: (client: LspClient) => Promise<T | null>,
): Promise<T | null> {
  try {
    if (!(await deps.ensureSession())) return null;
    const client = deps.client();
    if (!client) return null;
    return await run(client);
  } catch {
    return null;
  }
}

function toLocations(result: unknown): monaco.languages.Location[] {
  return locationsFromResult(result).map((location) => ({
    uri: monaco.Uri.parse(location.uri),
    range: toMonacoRange(location.range),
  }));
}

function toSymbols(result: unknown): monaco.languages.DocumentSymbol[] {
  if (!Array.isArray(result)) return [];
  return result.map((item) => toSymbol(item as Record<string, unknown>));
}

function toSymbol(item: Record<string, unknown>): monaco.languages.DocumentSymbol {
  const location = item.location as { range?: Parameters<typeof toMonacoRange>[0] } | undefined;
  const range = (item.range ?? location?.range) as Parameters<typeof toMonacoRange>[0];
  const selection = (item.selectionRange ?? item.range ?? location?.range) as Parameters<typeof toMonacoRange>[0];
  const children = Array.isArray(item.children) ? item.children.map((child) => toSymbol(child as Record<string, unknown>)) : [];
  return {
    name: String(item.name ?? ""),
    detail: String(item.detail ?? ""),
    kind: symbolKindToMonaco(Number(item.kind ?? 1)),
    tags: [],
    range: toMonacoRange(range),
    selectionRange: toMonacoRange(selection),
    children,
  };
}

export function installJavaProviders(deps: {
  ensureSession(): Promise<boolean>;
  client(): LspClient | null;
}): void {
  if (registered) return;
  registered = true;
  installOpener();
  const language = JAVA_LANGUAGE_ID;

  monaco.languages.registerCompletionItemProvider(language, {
    triggerCharacters: [".", "@", "("],
    async provideCompletionItems(model, position) {
      return withClient(deps, async (client) => {
        const result = await client.request("textDocument/completion", {
          textDocument: { uri: model.uri.toString() },
          position: toLspPosition(position),
        });
        const items = Array.isArray(result)
          ? result
          : ((result as { items?: LspCompletionItem[] } | null)?.items ?? []);
        const fallback = fallbackRange(model, position);
        return {
          suggestions: items.map((item) => {
            const suggestion = toMonacoCompletion(item, fallback);
            completionItems.set(suggestion, item);
            return suggestion;
          }),
        };
      });
    },
    async resolveCompletionItem(item) {
      const raw = completionItems.get(item);
      if (!raw) return item;
      const resolved = await withClient(deps, (client) =>
        client.request("completionItem/resolve", raw) as Promise<LspCompletionItem | null>,
      );
      if (!resolved) return item;
      const range = item.range as monaco.IRange;
      return { ...item, ...toMonacoCompletion(resolved, range), range: item.range };
    },
  });

  monaco.languages.registerHoverProvider(language, {
    provideHover(model, position) {
      return withClient(deps, async (client) => {
        const result = (await client.request("textDocument/hover", {
          textDocument: { uri: model.uri.toString() },
          position: toLspPosition(position),
        })) as LspHover | null;
        return toMonacoHover(result);
      });
    },
  });

  monaco.languages.registerSignatureHelpProvider(language, {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    provideSignatureHelp(model, position) {
      return withClient(deps, async (client) => {
        const result = (await client.request("textDocument/signatureHelp", {
          textDocument: { uri: model.uri.toString() },
          position: toLspPosition(position),
        })) as {
          signatures?: Array<{
            label: string;
            documentation?: string | { value?: string };
            parameters?: Array<{ label: string | [number, number]; documentation?: string | { value?: string } }>;
          }>;
          activeSignature?: number;
          activeParameter?: number;
        } | null;
        if (!result?.signatures) return null;
        return {
          value: {
            signatures: result.signatures.map((signature) => ({
              label: signature.label,
              documentation:
                typeof signature.documentation === "string"
                  ? signature.documentation
                  : signature.documentation?.value,
              parameters: (signature.parameters ?? []).map((parameter) => ({
                label: parameter.label,
                documentation:
                  typeof parameter.documentation === "string"
                    ? parameter.documentation
                    : parameter.documentation?.value,
              })),
            })),
            activeSignature: result.activeSignature ?? 0,
            activeParameter: result.activeParameter ?? 0,
          },
          dispose() {},
        };
      });
    },
  });

  monaco.languages.registerDefinitionProvider(language, {
    provideDefinition(model, position) {
      return requestLocations(deps, model, position, "textDocument/definition");
    },
  });
  monaco.languages.registerTypeDefinitionProvider(language, {
    provideTypeDefinition(model, position) {
      return requestLocations(deps, model, position, "textDocument/typeDefinition");
    },
  });
  monaco.languages.registerImplementationProvider(language, {
    provideImplementation(model, position) {
      return requestLocations(deps, model, position, "textDocument/implementation");
    },
  });

  monaco.languages.registerReferenceProvider(language, {
    provideReferences(model, position) {
      return withClient(deps, async (client) => {
        const result = await client.request("textDocument/references", {
          textDocument: { uri: model.uri.toString() },
          position: toLspPosition(position),
          context: { includeDeclaration: true },
        });
        return toLocations(result);
      });
    },
  });

  monaco.languages.registerRenameProvider(language, {
    async provideRenameEdits(model, position, newName) {
      const result = await withClient(deps, (client) =>
        client.request("textDocument/rename", {
          textDocument: { uri: model.uri.toString() },
          position: toLspPosition(position),
          newName,
        }) as Promise<LspWorkspaceEdit | null>,
      );
      if (!result) return { edits: [], rejectReason: "Java 语言服务未就绪" };
      const workspace = toMonacoWorkspaceEdit(result, "");
      return {
        edits: workspace.edits.map((edit) => ({
          resource: monaco.Uri.parse(edit.resource),
          textEdit: edit.textEdit,
          versionId: undefined,
        })),
      };
    },
  });

  monaco.languages.registerCodeActionProvider(language, {
    async provideCodeActions(model, range, context) {
      return withClient(deps, async (client) => {
        const result = (await client.request("textDocument/codeAction", {
          textDocument: { uri: model.uri.toString() },
          range: {
            start: toLspPosition({ lineNumber: range.startLineNumber, column: range.startColumn }),
            end: toLspPosition({ lineNumber: range.endLineNumber, column: range.endColumn }),
          },
          context: {
            diagnostics: context.markers.map((marker) => ({
              range: {
                start: { line: marker.startLineNumber - 1, character: marker.startColumn - 1 },
                end: { line: marker.endLineNumber - 1, character: marker.endColumn - 1 },
              },
              message: marker.message,
              source: marker.source,
              severity: marker.severity >= 8 ? 1 : marker.severity >= 4 ? 2 : marker.severity >= 2 ? 3 : 4,
            })),
            only: context.only ? [context.only] : undefined,
          },
        })) as Array<Record<string, unknown>> | null;
        const actions = (result ?? []).map((action) => {
          const edit = action.edit as LspWorkspaceEdit | undefined;
          const mapped: monaco.languages.CodeAction = {
            title: String(action.title ?? ""),
            kind: typeof action.kind === "string" ? action.kind : undefined,
            isPreferred: action.isPreferred === true,
            edit: edit
              ? {
                  edits: toMonacoWorkspaceEdit(edit, "").edits.map((item) => ({
                    resource: monaco.Uri.parse(item.resource),
                    versionId: undefined,
                    textEdit: item.textEdit,
                  })),
                }
              : undefined,
          };
          codeActions.set(mapped, action);
          return mapped;
        });
        return { actions, dispose() {} };
      });
    },
    async resolveCodeAction(action) {
      const raw = codeActions.get(action);
      if (!raw) return action;
      const resolved = await withClient(deps, (client) =>
        client.request("codeAction/resolve", raw) as Promise<Record<string, unknown> | null>,
      );
      const edit = resolved?.edit as LspWorkspaceEdit | undefined;
      if (!edit) return action;
      return {
        ...action,
        edit: {
          edits: toMonacoWorkspaceEdit(edit, "").edits.map((item) => ({
            resource: monaco.Uri.parse(item.resource),
            versionId: undefined,
            textEdit: item.textEdit,
          })),
        },
      };
    },
  });

  monaco.languages.registerDocumentSymbolProvider(language, {
    provideDocumentSymbols(model) {
      return withClient(deps, async (client) => {
        const result = await client.request("textDocument/documentSymbol", {
          textDocument: { uri: model.uri.toString() },
        });
        return toSymbols(result);
      });
    },
  });

  monaco.languages.registerFoldingRangeProvider(language, {
    provideFoldingRanges(model) {
      return withClient(deps, async (client) => {
        const result = (await client.request("textDocument/foldingRange", {
          textDocument: { uri: model.uri.toString() },
        })) as Array<{ startLine?: number; endLine?: number; kind?: string }> | null;
        return (result ?? []).map((range) => ({
          start: (range.startLine ?? 0) + 1,
          end: (range.endLine ?? 0) + 1,
          kind: range.kind as monaco.languages.FoldingRangeKind | undefined,
        }));
      });
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider(language, {
    provideDocumentFormattingEdits(model) {
      return withClient(deps, async (client) => {
        const result = (await client.request("textDocument/formatting", {
          textDocument: { uri: model.uri.toString() },
          options: { tabSize: 4, insertSpaces: true },
        })) as LspTextEdit[] | null;
        return toMonacoTextEdits(result ?? []);
      });
    },
  });

  monaco.languages.registerDocumentRangeFormattingEditProvider(language, {
    provideDocumentRangeFormattingEdits(model, range) {
      return withClient(deps, async (client) => {
        const result = (await client.request("textDocument/rangeFormatting", {
          textDocument: { uri: model.uri.toString() },
          range: {
            start: toLspPosition({ lineNumber: range.startLineNumber, column: range.startColumn }),
            end: toLspPosition({ lineNumber: range.endLineNumber, column: range.endColumn }),
          },
          options: { tabSize: 4, insertSpaces: true },
        })) as LspTextEdit[] | null;
        return toMonacoTextEdits(result ?? []);
      });
    },
  });
}

function requestLocations(
  deps: { ensureSession(): Promise<boolean>; client(): LspClient | null },
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  method: string,
) {
  return withClient(deps, async (client) => {
    const result = await client.request(method, {
      textDocument: { uri: model.uri.toString() },
      position: toLspPosition(position),
    });
    return toLocations(result);
  });
}
