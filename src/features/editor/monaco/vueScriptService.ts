// ==================== .vue script 段的 TS 语义支持 ====================
// Monaco 的 ts worker 只服务 typescript/javascript 的 model，所以为每个
// .vue 文件维护一份等长虚拟 TS 文件（template/style 填空白），
// 再把虚拟文件上的诊断按同一 offset 映射回 .vue model。
import type { TypeScriptWorker } from "monaco-editor/languages/features/typescript/register";
import { monaco, typescript } from "./setup";
import { createVueScriptContext, type VueScriptBlock } from "@/features/editor/vueScript";

const DIAGNOSTIC_OWNER = "prism-vue-ts";

interface VueScriptEntry {
  vueModel: monaco.editor.ITextModel;
  virtualModel: monaco.editor.ITextModel;
  contentSub: monaco.IDisposable;
  blocks: VueScriptBlock[];
}

const entries = new Map<string, VueScriptEntry>();
/** 虚拟 model URI → .vue model URI */
const virtualIndex = new Map<string, string>();

function offsetInBlocks(model: monaco.editor.ITextModel, blocks: VueScriptBlock[], line: number, column: number): boolean {
  if (line < 1 || line > model.getLineCount()) return false;
  const safeColumn = Math.max(1, Math.min(column, model.getLineMaxColumn(line)));
  const offset = model.getOffsetAt({ lineNumber: line, column: safeColumn });
  return blocks.some((block) => offset >= block.start && offset <= block.end);
}

function clearMarkers(model: monaco.editor.ITextModel): void {
  monaco.editor.setModelMarkers(model, DIAGNOSTIC_OWNER, []);
}

function syncVirtual(entryKey: string): void {
  const entry = entries.get(entryKey);
  if (!entry || entry.vueModel.isDisposed()) return;
  const source = entry.vueModel.getValue();
  const context = createVueScriptContext(entry.vueModel.uri.fsPath || entryKey, source);
  entry.blocks = context.blocks;
  if (entry.virtualModel.getValue() !== context.text) {
    entry.virtualModel.setValue(context.text);
  }
}

function attach(vueModel: monaco.editor.ITextModel): void {
  const key = vueModel.uri.toString();
  if (entries.has(key)) return;
  const context = createVueScriptContext(vueModel.uri.fsPath || key, vueModel.getValue());
  const virtualUri = monaco.Uri.file(context.fileName);
  const virtualModel =
    monaco.editor.getModel(virtualUri) ??
    monaco.editor.createModel(context.text, "typescript", virtualUri);
  if (virtualModel.getValue() !== context.text) virtualModel.setValue(context.text);

  const contentSub = vueModel.onDidChangeContent(() => {
    syncVirtual(key);
  });
  entries.set(key, { vueModel, virtualModel, contentSub, blocks: context.blocks });
  virtualIndex.set(virtualUri.toString(), key);
  syncVirtual(key);
}

function detach(vueModel: monaco.editor.ITextModel): void {
  const key = vueModel.uri.toString();
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  virtualIndex.delete(entry.virtualModel.uri.toString());
  entry.contentSub.dispose();
  entry.virtualModel.dispose();
}

let installed = false;

/** 安装 .vue → 虚拟 TS 的桥接（幂等） */
export function installVueScriptDiagnostics(): void {
  if (installed) return;
  installed = true;

  const isVueModel = (model: monaco.editor.ITextModel) => model.getLanguageId() === "vue";

  for (const model of monaco.editor.getModels()) {
    if (isVueModel(model)) attach(model);
  }
  monaco.editor.onDidCreateModel((model) => {
    if (isVueModel(model)) attach(model);
  });
  monaco.editor.onDidChangeModelLanguage((event) => {
    if (isVueModel(event.model)) {
      attach(event.model);
    } else {
      detach(event.model);
    }
  });
  monaco.editor.onWillDisposeModel((model) => {
    if (isVueModel(model)) detach(model);
  });

  // 虚拟文件上的 marker → .vue model（等长映射，行列可直传）
  monaco.editor.onDidChangeMarkers((resources) => {
    for (const uri of resources) {
      const entryKey = virtualIndex.get(uri.toString());
      if (!entryKey) continue;
      const entry = entries.get(entryKey);
      if (!entry || entry.vueModel.isDisposed()) continue;
      const markers = monaco.editor.getModelMarkers({ resource: uri });
      if (!markers.length) {
        clearMarkers(entry.vueModel);
        continue;
      }
      const mapped = markers
        .filter((marker) =>
          offsetInBlocks(
            entry.virtualModel,
            entry.blocks,
            marker.startLineNumber,
            marker.startColumn,
          ),
        )
        .map((marker) => ({ ...marker }));
      monaco.editor.setModelMarkers(entry.vueModel, DIAGNOSTIC_OWNER, mapped);
    }
  });
}

/** worker 侧补全结果（只取桥接需要的字段） */
interface TsCompletionEntry {
  name: string;
  kind: string;
  sortText?: string;
  insertText?: string;
  source?: string;
  hasAction?: boolean;
}

interface TsCompletionInfo {
  entries: TsCompletionEntry[];
}

/** TS 的 ScriptElementKind → Monaco CompletionItemKind */
const TS_KIND_TO_MONACO: Record<string, monaco.languages.CompletionItemKind> = {
  function: monaco.languages.CompletionItemKind.Function,
  "local function": monaco.languages.CompletionItemKind.Function,
  method: monaco.languages.CompletionItemKind.Method,
  property: monaco.languages.CompletionItemKind.Property,
  getter: monaco.languages.CompletionItemKind.Property,
  setter: monaco.languages.CompletionItemKind.Property,
  const: monaco.languages.CompletionItemKind.Constant,
  let: monaco.languages.CompletionItemKind.Variable,
  var: monaco.languages.CompletionItemKind.Variable,
  variable: monaco.languages.CompletionItemKind.Variable,
  class: monaco.languages.CompletionItemKind.Class,
  interface: monaco.languages.CompletionItemKind.Interface,
  enum: monaco.languages.CompletionItemKind.Enum,
  enumMember: monaco.languages.CompletionItemKind.EnumMember,
  module: monaco.languages.CompletionItemKind.Module,
  type: monaco.languages.CompletionItemKind.TypeParameter,
  "type parameter": monaco.languages.CompletionItemKind.TypeParameter,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  text: monaco.languages.CompletionItemKind.Text,
  alias: monaco.languages.CompletionItemKind.Reference,
  script: monaco.languages.CompletionItemKind.File,
  "external module name": monaco.languages.CompletionItemKind.Module,
};

/** 取虚拟文件的 worker 客户端（worker 未就绪时抛错，由调用方降级） */
async function workerClient(fileUri: monaco.Uri): Promise<TypeScriptWorker> {
  const factory = await typescript.getTypeScriptWorker();
  return factory(fileUri);
}

let completionsRegistered = false;

/** 把 TS worker 的补全桥接到 .vue（仅限 script 区段） */
export function registerVueScriptCompletions(): void {
  if (completionsRegistered) return;
  completionsRegistered = true;

  monaco.languages.registerCompletionItemProvider("vue", {
    triggerCharacters: [".", "'", '"', "/", "@", "(", "<"],
    async provideCompletionItems(model, position) {
      const entry = entries.get(model.uri.toString());
      if (!entry) return null;
      if (!offsetInBlocks(model, entry.blocks, position.lineNumber, position.column)) return null;
      const offset = model.getOffsetAt(position);

      let client: TypeScriptWorker;
      try {
        client = await workerClient(entry.virtualModel.uri);
      } catch {
        return null;
      }
      let info: TsCompletionInfo | undefined;
      try {
        info = await client.getCompletionsAtPosition(entry.virtualModel.uri.toString(), offset);
      } catch {
        return null;
      }
      if (!info?.entries?.length) return null;

      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: word.endColumn,
      };
      return {
        suggestions: info.entries.map((item) => ({
          label: item.name,
          kind: TS_KIND_TO_MONACO[item.kind] ?? monaco.languages.CompletionItemKind.Property,
          detail: item.source ? `来自 ${item.source}` : undefined,
          insertText: item.insertText ?? item.name,
          sortText: item.sortText,
          range,
        })),
      };
    },
  });
}
