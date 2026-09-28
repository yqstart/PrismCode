// ==================== 未打开文件的类型注入 ====================
// Monaco 的 ts worker 只能看到已打开的 model；import 到未打开的文件时类型会退化成 any。
// 这里解析打开文件的相对 import，把目标文件内容作为 extraLib 注入 worker
// （不创建 model，规避大量 model 带来的监听与内存开销）。
import { monaco } from "./setup";
import { addExtraLib } from "./tsProvider";
import { IMPORT_RE, resolveImportPath } from "@/shared/importReferences";
import { createVueScriptContext } from "@/features/editor/vueScript";
import { readTextFile } from "@/shared/fs";

/** 注入上限：超大项目里避免一次性拉入成百上千文件 */
const MAX_EXTRA_LIBS = 200;

/** worker 认识的代码文件；.vue 会转成等长虚拟 TS 后注入 */
const CODE_FILE_RE = /\.(?:[cm]?[jt]sx?|d\.ts)$/i;

interface ExtraLibOptions {
  root: () => string | null;
}

const injected = new Set<string>();
const pending = new Set<string>();

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

async function injectOne(root: string, absolutePath: string): Promise<void> {
  if (injected.has(absolutePath) || pending.has(absolutePath)) return;
  if (injected.size >= MAX_EXTRA_LIBS) return;
  if (monaco.editor.getModel(monaco.Uri.file(absolutePath))) return;
  if (!CODE_FILE_RE.test(absolutePath) && !/\.vue$/i.test(absolutePath)) return;

  pending.add(absolutePath);
  try {
    const source = await readTextFile(root, absolutePath);
    if (/\.vue$/i.test(absolutePath)) {
      // .vue 目标以等长虚拟 TS 注入，沿用与打开文件一致的映射
      const virtual = createVueScriptContext(absolutePath, source);
      addExtraLib(virtual.text, virtual.fileName);
      injected.add(virtual.fileName);
    } else {
      addExtraLib(source, absolutePath);
    }
    injected.add(absolutePath);
  } catch {
    // 读不到（权限/已删除）：跳过，不阻断
  } finally {
    pending.delete(absolutePath);
  }
}

let installed = false;

/** 安装 import 目标注入（幂等）；打开文件与内容变化时增量补注入 */
export function installExtraLibs(options: ExtraLibOptions): void {
  if (installed) return;
  installed = true;

  const refresh = async (model: monaco.editor.ITextModel) => {
    const root = options.root();
    if (!root) return;
    const languageId = model.getLanguageId();
    let text: string;
    if (languageId === "vue") {
      text = createVueScriptContext(model.uri.fsPath || model.uri.toString(), model.getValue()).text;
    } else if (languageId === "typescript" || languageId === "javascript") {
      text = model.getValue();
    } else {
      return;
    }
    const currentFile = model.uri.fsPath;
    if (!currentFile) return;
    for (const spec of localSpecs(text)) {
      const target = await resolveImportPath(root, currentFile, spec);
      if (target) await injectOne(root, target);
    }
  };

  const subscriptions = new Map<string, monaco.IDisposable>();

  // 没有全局 model 内容事件：创建时按 model 订阅
  const watch = (model: monaco.editor.ITextModel) => {
    const key = model.uri.toString();
    if (subscriptions.has(key)) return;
    subscriptions.set(
      key,
      model.onDidChangeContent(() => {
        void refresh(model);
      }),
    );
    void refresh(model);
  };

  for (const model of monaco.editor.getModels()) watch(model);
  monaco.editor.onDidCreateModel(watch);
  monaco.editor.onWillDisposeModel((model) => {
    const key = model.uri.toString();
    subscriptions.get(key)?.dispose();
    subscriptions.delete(key);
  });
}
