// ==================== .vue script 段的 TS 语义支持 ====================
// Monaco 的 ts worker 只服务 typescript/javascript 的 model，所以为每个
// .vue 文件维护一份等长虚拟 TS 文件（template/style 填空白），
// 再把虚拟文件上的诊断按同一 offset 映射回 .vue model。
import type {
 Diagnostic,
 TypeScriptWorker,
} from "monaco-editor/languages/features/typescript/register";
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

/**
 * 虚拟文件诊断的 marker owner：与 Monaco 的 TS 适配器同名。
 * 适配器在 onlyVisible 下不校验未贴到编辑器上的虚拟 model，所以虚拟文件的
 * 诊断由这里主动拉取写入，onDidChangeMarkers 再把它们映射回 .vue model。
 */
const VIRTUAL_MARKER_OWNER = "typescript";
/** 内容变化到重新校验之间的等待 */
const DIAGNOSTIC_DEBOUNCE_MS = 500;

/** .vue model URI → 诊断防抖计时器 */
const diagnosticTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** TS 诊断的 messageText 可能是链式结构：按 next 递归拼成多行文本 */
function flattenMessageText(messageText: unknown, newLine: string): string {
 if (typeof messageText === "string") return messageText;
 if (!messageText || typeof messageText !== "object") return "";
 const chain = messageText as { messageText?: unknown; next?: unknown };
 const head = flattenMessageText(chain.messageText, newLine);
 const next = Array.isArray(chain.next)
  ? (chain.next as unknown[]).map((item) => flattenMessageText(item, newLine)).join(newLine)
  : "";
 return next ? `${head}${newLine}${next}` : head;
}

/** DiagnosticCategory：0 = Warning，1 = Error，其余按 Info */
function markerSeverity(category: number): monaco.MarkerSeverity {
 if (category === 1) return monaco.MarkerSeverity.Error;
 if (category === 0) return monaco.MarkerSeverity.Warning;
 return monaco.MarkerSeverity.Info;
}

/** TS 诊断 → Monaco marker（offset 在等长虚拟文件上，行列可直接用） */
function markersFromDiagnostics(
 model: monaco.editor.ITextModel,
 diagnostics: readonly Diagnostic[],
): monaco.editor.IMarkerData[] {
 return diagnostics.map((diagnostic) => {
  const start = diagnostic.start ?? 0;
  const length = diagnostic.length ?? 1;
  const from = model.getPositionAt(start);
  const to = model.getPositionAt(start + length);
  return {
   severity: markerSeverity(diagnostic.category),
   message: flattenMessageText(diagnostic.messageText, "\n"),
   code: String(diagnostic.code),
   startLineNumber: from.lineNumber,
   startColumn: from.column,
   endLineNumber: to.lineNumber,
   endColumn: to.column,
  };
 });
}

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
 scheduleDiagnostics(entryKey);
}

function scheduleDiagnostics(entryKey: string): void {
 clearTimeout(diagnosticTimers.get(entryKey));
 diagnosticTimers.set(
  entryKey,
  setTimeout(() => {
   diagnosticTimers.delete(entryKey);
   void publishVueDiagnostics(entryKey);
  }, DIAGNOSTIC_DEBOUNCE_MS),
 );
}

/** 拉取虚拟文件的诊断并写成 marker（挂起期间 worker 返回空结果，不产出噪音） */
async function publishVueDiagnostics(entryKey: string): Promise<void> {
 const entry = entries.get(entryKey);
 if (!entry || entry.virtualModel.isDisposed()) return;
 const fileName = entry.virtualModel.uri.toString();
 let diagnostics: Diagnostic[] = [];
 try {
  const client = await workerClient(entry.virtualModel.uri);
  diagnostics = [
   ...(await client.getSyntacticDiagnostics(fileName)),
   ...(await client.getSemanticDiagnostics(fileName)),
   ...(await client.getSuggestionDiagnostics(fileName)),
  ];
 } catch {
  // worker 未就绪或已挂起：本次不产出诊断，等内容变化或重新聚焦再试
 }
 if (entry.virtualModel.isDisposed()) return;
 monaco.editor.setModelMarkers(
  entry.virtualModel,
  VIRTUAL_MARKER_OWNER,
  markersFromDiagnostics(entry.virtualModel, diagnostics),
 );
}

/** 立即重跑某个 .vue 的脚本诊断（窗口重新聚焦时调用；非 .vue 为 no-op） */
export function refreshVueDiagnostics(vueModel: monaco.editor.ITextModel): void {
 if (vueModel.getLanguageId() !== "vue") return;
 const key = vueModel.uri.toString();
 if (!entries.has(key)) return;
 clearTimeout(diagnosticTimers.get(key));
 diagnosticTimers.delete(key);
 void publishVueDiagnostics(key);
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
 clearTimeout(diagnosticTimers.get(key));
 diagnosticTimers.delete(key);
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
