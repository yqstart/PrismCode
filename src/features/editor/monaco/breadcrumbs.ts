// ==================== 面包屑符号链 ====================
// Monaco 没有内置 breadcrumbs（官方 issue #3936 判为 out of scope），
// 这里用 TS worker 的 getNavigationTree 取光标所在的符号链，交给 DOM 条渲染。
import type { editor as MonacoEditorApi } from "monaco-editor/editor";
import type { TypeScriptWorker } from "monaco-editor/languages/features/typescript/register";
import { monaco, typescript } from "./setup";

export interface SymbolCrumb {
 /** 展示名（如 `class Foo` 只取 `Foo`） */
 name: string;
 /** 该符号在文档中的起始 offset */
 offset: number;
}

interface NavigationTree {
 text: string;
 kind: string;
 spans: number[];
 childItems?: NavigationTree[];
}

/** TS 的 NavigationTree.text 带前缀（"class Foo" / "const bar"），只保留名字部分 */
function displayName(text: string): string {
 const trimmed = text.trim();
 const spaceIndex = trimmed.indexOf(" ");
 if (spaceIndex <= 0) return trimmed;
 const head = trimmed.slice(0, spaceIndex);
 // `class Foo` / `function bar` / `const baz` 这类前缀才剥离
 if (!/^(class|interface|function|const|let|var|enum|namespace|module|type|method|property|get|set)$/.test(head)) {
  return trimmed;
 }
 return trimmed.slice(spaceIndex + 1).trim() || trimmed;
}

const LANGUAGES_WITH_SYMBOLS = new Set(["typescript", "javascript", "vue"]);

type WorkerFactory = (...uris: monaco.Uri[]) => Promise<TypeScriptWorker>;

let factoryPromise: Promise<WorkerFactory> | null = null;

async function getWorker(uri: monaco.Uri): Promise<TypeScriptWorker | null> {
 try {
  factoryPromise ??= typescript.getTypeScriptWorker();
  const factory = await factoryPromise;
  return await factory(uri);
 } catch {
  factoryPromise = null;
  return null;
 }
}

/** 递归找包含 offset 的最深符号链 */
function chainAt(node: NavigationTree, offset: number, acc: SymbolCrumb[]): SymbolCrumb[] | null {
 const [start, end] = node.spans;
 if (offset < start || offset > end) return null;
 const next = [...acc, { name: displayName(node.text), offset: start }];
 for (const child of node.childItems ?? []) {
  const found = chainAt(child, offset, next);
  if (found) return found;
 }
 return next;
}

/** 取当前位置的符号链（无符号 / 不支持的语言返回空数组） */
export async function symbolChainAt(
 model: monaco.editor.ITextModel,
 position: { lineNumber: number; column: number },
): Promise<SymbolCrumb[]> {
 if (!LANGUAGES_WITH_SYMBOLS.has(model.getLanguageId())) return [];
 // .vue 走等长虚拟文件（<file>.vue.ts），否则直接用文件自身
 const targetUri =
  model.getLanguageId() === "vue" ? monaco.Uri.file(`${model.uri.fsPath}.ts`) : model.uri;
 const worker = await getWorker(targetUri);
 if (!worker) return [];
 let tree: NavigationTree | undefined;
 try {
  tree = (await worker.getNavigationTree(
   targetUri.toString(),
  )) as unknown as NavigationTree | undefined;
 } catch {
  return [];
 }
 if (!tree) return [];
 const offset = model.getOffsetAt(position);
 return chainAt(tree, offset, []) ?? [];
}

export interface BreadcrumbController {
 dispose(): void;
 /** 手动触发一次刷新（打开文件 / 语言变化时） */
 refresh(): void;
}

/**
 * 跟踪光标位置并回调符号链。
 * 光标的行列变化用 rAF 合并，避免每个按键都去打 worker。
 */
export function trackSymbolChain(
 editor: MonacoEditorApi.IStandaloneCodeEditor,
 onUpdate: (chain: SymbolCrumb[]) => void,
): BreadcrumbController {
 let generation = 0;
 let scheduled: number | null = null;
 let disposed = false;

 const run = async () => {
  if (disposed) return;
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!model || !position) {
   onUpdate([]);
   return;
  }
  const current = ++generation;
  const chain = await symbolChainAt(model, position);
  if (disposed || current !== generation) return;
  onUpdate(chain);
 };

 const schedule = () => {
  if (scheduled !== null) return;
  scheduled = requestAnimationFrame(() => {
   scheduled = null;
   void run();
  });
 };

 const subscriptions = [
  editor.onDidChangeCursorPosition(() => schedule()),
  editor.onDidChangeModel(() => schedule()),
  editor.onDidChangeModelContent(() => schedule()),
 ];

 schedule();

 return {
  refresh: () => schedule(),
  dispose() {
   disposed = true;
   if (scheduled !== null) {
    cancelAnimationFrame(scheduled);
    scheduled = null;
   }
   for (const subscription of subscriptions) subscription.dispose();
  },
 };
}
