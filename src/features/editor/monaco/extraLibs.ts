// ==================== 未打开文件的类型注入 ====================
// Monaco 的 ts worker 只能看到已打开的 model；import 到未打开的文件时类型会退化成 any。
// 这里解析「当前文件」的直接本地 import，把目标内容作为 extraLib 交给 worker（不创建 model）。
// 集合每次整体替换、只反映当前文件：worker 里的程序不会随打开过的文件累积。
import type { editor as MonacoEditorApi } from "monaco-editor/editor";
import { monaco } from "./setup";
import { replaceExtraLibs } from "./tsProvider";
import { MAX_EXTRA_LIBS, selectExtraLibs, type ExtraLibCandidate } from "./languageBudget";
import { IMPORT_RE, resolveImportPath } from "@/shared/importReferences";
import { createVueScriptContext } from "@/features/editor/vueScript";
import { readTextFile } from "@/shared/fs";

/** worker 认识的代码文件；.vue 会转成等长虚拟 TS 后注入 */
const CODE_FILE_RE = /\.(?:[cm]?[jt]sx?|d\.ts)$/i;
const VUE_RE = /\.vue$/i;
/** 内容变化到重新注入之间的等待：输入期间不反复重建 worker 的程序 */
const REFRESH_DEBOUNCE_MS = 300;

interface ExtraLibOptions {
 root: () => string | null;
 /** 当前贴在编辑器上的 model（只有它需要 import 类型） */
 activeModel: () => MonacoEditorApi.ITextModel | null;
}

/** 提取源文本里的本地 import 规格（相对路径 + 工作区别名由 resolveImportPath 处理） */
function localSpecs(text: string): string[] {
 const specs: string[] = [];
 IMPORT_RE.lastIndex = 0;
 let match: RegExpExecArray | null;
 while ((match = IMPORT_RE.exec(text))) {
  const spec = match[1];
  if (spec) specs.push(spec);
 }
 return specs;
}

/** 把目标文件读成候选（.vue 转等长虚拟 TS，与打开文件走同一映射） */
async function readCandidate(
 root: string,
 target: string,
): Promise<ExtraLibCandidate | null> {
 try {
  const source = await readTextFile(root, target);
  if (VUE_RE.test(target)) {
   const virtual = createVueScriptContext(target, source);
   return { path: virtual.fileName, content: virtual.text };
  }
  return { path: target, content: source };
 } catch {
  // 读不到（权限/已删除）：跳过，不阻断
  return null;
 }
}

/** 当前文件的直接本地 import 目标（不递归） */
async function collectCandidates(
 root: string,
 filePath: string,
 text: string,
): Promise<ExtraLibCandidate[]> {
 const candidates: ExtraLibCandidate[] = [];
 for (const spec of localSpecs(text)) {
  if (candidates.length >= MAX_EXTRA_LIBS) break;
  const target = await resolveImportPath(root, filePath, spec).catch(() => null);
  if (!target || target === filePath) continue;
  if (!CODE_FILE_RE.test(target) && !VUE_RE.test(target)) continue;
  const candidate = await readCandidate(root, target);
  if (candidate) candidates.push(candidate);
 }
 return candidates;
}

let rootGetter: (() => string | null) | null = null;
let activeModelGetter: (() => MonacoEditorApi.ITextModel | null) | null = null;
/** 刷新序号：慢的读盘结果不得覆盖更新的刷新 */
let refreshSequence = 0;
let installed = false;

/** 用当前 model 的直接 import 替换 worker 的额外库集合 */
export async function refreshActiveExtraLibs(
 model: MonacoEditorApi.ITextModel | null,
): Promise<void> {
 const root = rootGetter?.() ?? null;
 const sequence = ++refreshSequence;
 const languageId = model?.getLanguageId() ?? "";
 if (
  !root ||
  !model ||
  model.isDisposed() ||
  (languageId !== "typescript" && languageId !== "javascript" && languageId !== "vue")
 ) {
  replaceExtraLibs([]);
  return;
 }
 const filePath = model.uri.fsPath || model.uri.path;
 if (!filePath) {
  replaceExtraLibs([]);
  return;
 }
 const source = model.getValue();
 const text = languageId === "vue" ? createVueScriptContext(filePath, source).text : source;
 const candidates = await collectCandidates(root, filePath, text);
 if (sequence !== refreshSequence) return;
 replaceExtraLibs(selectExtraLibs(candidates));
}

let debounceTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleRefresh(): void {
 clearTimeout(debounceTimer);
 debounceTimer = setTimeout(() => {
  debounceTimer = undefined;
  void refreshActiveExtraLibs(activeModelGetter?.() ?? null);
 }, REFRESH_DEBOUNCE_MS);
}

/**
 * 安装 import 目标注入（幂等）。
 * 只有「当前贴在编辑器上的 model」的内容变化才触发刷新；其余 model 的
 * 额外库由切换标签时的显式刷新负责，避免历史标签把程序重新撑大。
 */
export function installExtraLibs(options: ExtraLibOptions): void {
 if (installed) return;
 installed = true;
 rootGetter = options.root;
 activeModelGetter = options.activeModel;

 const subscriptions = new Map<string, monaco.IDisposable>();
 const watch = (model: MonacoEditorApi.ITextModel) => {
  const key = model.uri.toString();
  if (subscriptions.has(key)) return;
  subscriptions.set(
   key,
   model.onDidChangeContent(() => {
    if (activeModelGetter?.() !== model) return;
    scheduleRefresh();
   }),
  );
 };
 for (const model of monaco.editor.getModels()) watch(model);
 monaco.editor.onDidCreateModel(watch);
 monaco.editor.onWillDisposeModel((model) => {
  const key = model.uri.toString();
  subscriptions.get(key)?.dispose();
  subscriptions.delete(key);
 });
}
