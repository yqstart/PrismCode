// ==================== JDTLS 协议纯逻辑 ====================
import type { LspTextEdit, LspWorkspaceEdit } from "../editor/lsp/convert";

export const JAVA_LANGUAGE_ID = "java";
export const SERVICE_READY_IDLE_TIMEOUT_MS = 45_000;
export const SERVICE_READY_ABSOLUTE_TIMEOUT_MS = 600_000;
export const INITIALIZE_TIMEOUT_MS = 20_000;
export const SHUTDOWN_TIMEOUT_MS = 2_000;

const JAVA_CONFIG = {
  java: {
    eclipse: { downloadSources: false },
    maven: { downloadSources: false },
    configuration: { updateBuildConfiguration: "automatic" },
    inlayHints: { parameterNames: { enabled: "none" } },
    implementationsCodeLens: { enabled: false },
    referencesCodeLens: { enabled: false },
    autobuild: { enabled: true },
    format: { enabled: true },
  },
} as const;

export function clientCapabilities(): unknown {
  return {
    workspace: {
      configuration: true,
      workspaceFolders: true,
      applyEdit: true,
      workspaceEdit: { documentChanges: true },
    },
    textDocument: {
      synchronization: { dynamicRegistration: false, willSave: false, didSave: true, willSaveWaitUntil: false },
      publishDiagnostics: {
        relatedInformation: true,
        versionSupport: true,
        tagSupport: { valueSet: [1, 2] },
      },
      completion: {
        completionItem: {
          snippetSupport: true,
          documentationFormat: ["markdown", "plaintext"],
          resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
        },
        contextSupport: true,
      },
      hover: { contentFormat: ["markdown", "plaintext"] },
      signatureHelp: {
        signatureInformation: {
          documentationFormat: ["markdown", "plaintext"],
          parameterInformation: { labelOffsetSupport: true },
        },
      },
      definition: { linkSupport: true },
      typeDefinition: { linkSupport: true },
      implementation: { linkSupport: true },
      references: {},
      rename: { prepareSupport: true },
      formatting: {},
      rangeFormatting: {},
      codeAction: {
        codeActionLiteralSupport: {
          codeActionKind: {
            valueSet: [
              "",
              "quickfix",
              "refactor",
              "refactor.extract",
              "refactor.inline",
              "refactor.rewrite",
              "source",
              "source.organizeImports",
            ],
          },
        },
        resolveSupport: { properties: ["edit"] },
        dataSupport: true,
      },
      documentSymbol: { hierarchicalDocumentSymbolSupport: true },
      foldingRange: {},
    },
  };
}

export function initializationOptions(): unknown {
  return { extendedClientCapabilities: { classFileContentsSupport: true } };
}

export function javaSettings(): unknown {
  return JAVA_CONFIG;
}

export function javaConfigurationForSection(section: string | null): unknown {
  if (section == null || section === "") return JAVA_CONFIG;
  const parts = section.split(".").filter(Boolean);
  let current: unknown = JAVA_CONFIG;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current ?? null;
}

export function isServiceReady(params: unknown): boolean {
  if (!params || typeof params !== "object") return false;
  return (params as { type?: string }).type === "ServiceReady";
}

export function progressFromStatus(params: unknown): { message?: string; percentage?: number } | null {
  if (!params || typeof params !== "object") return null;
  const record = params as {
    message?: unknown;
    percentage?: unknown;
    type?: unknown;
    value?: { kind?: string; message?: unknown; percentage?: unknown };
  };
  if (record.value && (record.value.kind === "begin" || record.value.kind === "report")) {
    return {
      message: typeof record.value.message === "string" ? record.value.message : undefined,
      percentage: typeof record.value.percentage === "number" ? record.value.percentage : undefined,
    };
  }
  if (typeof record.message === "string" || typeof record.percentage === "number") {
    return {
      message: typeof record.message === "string" ? record.message : undefined,
      percentage: typeof record.percentage === "number" ? record.percentage : undefined,
    };
  }
  return null;
}

export function virtualSourceCommand(uri: string): { command: "java.decompile"; arguments: [string] } {
  return { command: "java.decompile", arguments: [uri] };
}

export function displayNameFromJdtUri(uri: string): string {
  const decoded = decodeURIComponent(uri);
  const match = decoded.match(/([^/?]+)\.class/i);
  return match ? `${match[1]}.java` : "Decompiled.java";
}

export function isJavaWatchedPath(relPath: string): boolean {
  const name = relPath.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (name.endsWith(".java")) return true;
  if (name === "pom.xml" || name === "gradle.properties") return true;
  if (name === "build.gradle" || name === "build.gradle.kts") return true;
  if (name === "settings.gradle" || name === "settings.gradle.kts") return true;
  if (name === "mvnw" || name.startsWith("mvnw.")) return true;
  return false;
}

export interface PendingDidOpen {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

/** 未就绪时的 didOpen 队列：同一 URI 保留最新正文，顺序按首次出现。 */
export class DidOpenQueue {
  private items: PendingDidOpen[] = [];

  push(item: PendingDidOpen): void {
    const index = this.items.findIndex((entry) => entry.uri === item.uri);
    if (index >= 0) this.items[index] = item;
    else this.items.push(item);
  }

  remove(uri: string): void {
    this.items = this.items.filter((entry) => entry.uri !== uri);
  }

  drain(): PendingDidOpen[] {
    const items = this.items;
    this.items = [];
    return items;
  }
}

export function toDidChangeParams(
  uri: string,
  version: number,
  changes: ReadonlyArray<{
    range: {
      startLineNumber: number;
      startColumn: number;
      endLineNumber: number;
      endColumn: number;
    };
    text: string;
  }>,
) {
  return {
    textDocument: { uri, version },
    contentChanges: changes.map((change) => ({
      range: {
        start: { line: change.range.startLineNumber - 1, character: change.range.startColumn - 1 },
        end: { line: change.range.endLineNumber - 1, character: change.range.endColumn - 1 },
      },
      text: change.text,
    })),
  };
}

function offsetAt(text: string, line: number, character: number): number {
  let offset = 0;
  let currentLine = 0;
  while (currentLine < line && offset < text.length) {
    const newline = text.indexOf("\n", offset);
    if (newline < 0) return text.length;
    offset = newline + 1;
    currentLine += 1;
  }
  const newline = text.indexOf("\n", offset);
  const lineEnd = newline < 0 ? text.length : newline;
  const lineText = text.slice(offset, lineEnd).replace(/\r$/, "");
  return offset + Math.min(character, lineText.length);
}

export function applyLspTextEdits(text: string, edits: readonly LspTextEdit[]): string {
  const ordered = edits
    .map((edit) => ({
      start: offsetAt(text, edit.range.start.line, edit.range.start.character),
      end: offsetAt(text, edit.range.end.line, edit.range.end.character),
      newText: edit.newText,
    }))
    .sort((left, right) => right.start - left.start);
  let next = text;
  for (const edit of ordered) {
    next = next.slice(0, edit.start) + edit.newText + next.slice(edit.end);
  }
  return next;
}

/** applyWorkspaceEdit 在碰到资源操作或 jdt:// 目标时拒绝。 */
export function workspaceEditBlockReason(edit: LspWorkspaceEdit | unknown): string | null {
  if (!edit || typeof edit !== "object") return null;
  const value = edit as LspWorkspaceEdit;
  for (const uri of Object.keys(value.changes ?? {})) {
    if (uri.startsWith("jdt:")) return "不能把编辑写到反编译类";
  }
  for (const change of value.documentChanges ?? []) {
    if (!change || typeof change !== "object") continue;
    const kind = (change as { kind?: string }).kind;
    if (kind === "create" || kind === "rename" || kind === "delete") {
      return "暂不应用文件创建、重命名或删除";
    }
    const uri = (change as { textDocument?: { uri?: string } }).textDocument?.uri ?? "";
    if (uri.startsWith("jdt:")) return "不能把编辑写到反编译类";
  }
  return null;
}
