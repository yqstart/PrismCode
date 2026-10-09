// ==================== Spring 索引的 Monaco 消费 ====================
// 配置键补全（properties / yaml）与 @Value 未知键诊断回写；端点清单由 java store
// 经 openVirtualTab 打开。索引本体来自 Tauri 命令 spring_index，本模块只做装配。
import { watch } from "vue";
import { monaco } from "./setup";
import { toMonacoMarker, uriToPath } from "@/features/editor/lsp/convert";
import { relativeToRoot } from "@/shared/fs";
import { completionItems, springMarkerInputs, type SpringIndex } from "@/shared/springIndex";
import { useWorkspaceStore } from "@/stores/workspace";

const MARKER_OWNER = "spring";
const CONFIG_LANGUAGES = ["properties", "yaml"];
const JAVA_LANGUAGE_ID = "java";

export interface SpringProviderDeps {
  /** 当前索引；以函数形式传入，watch 才能追踪 store 的刷新 */
  index(): SpringIndex;
  /** 首次使用时的惰性加载（store 侧已做幂等与并发保护） */
  ensureIndex(): void | Promise<void>;
}

/** 补全要替换的键前缀范围：光标前的连续键名字符（不含缩进与分隔符） */
function keyRangeAt(model: monaco.editor.ITextModel, position: monaco.Position): monaco.IRange {
  const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
  const match = /[A-Za-z0-9_.\-[\]]*$/.exec(before);
  return {
    startLineNumber: position.lineNumber,
    startColumn: Math.max(1, position.column - (match?.[0].length ?? 0)),
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  };
}

let registered = false;

/**
 * 安装 Spring 补全与诊断（幂等，安装后进程级常驻）。
 * 返回卸载函数：provider 注册与全局订阅会被释放，model 级订阅在模型销毁时自动清理。
 */
export function installSpringProviders(deps: SpringProviderDeps): () => void {
  if (registered) return () => {};
  registered = true;
  const disposables: monaco.IDisposable[] = [];

  for (const language of CONFIG_LANGUAGES) {
    disposables.push(
      monaco.languages.registerCompletionItemProvider(language, {
        triggerCharacters: [".", "-"],
        async provideCompletionItems(model, position) {
          await deps.ensureIndex();
          const line = model.getLineContent(position.lineNumber);
          // yml 的键是缩进路径，喂给补全时去掉缩进（properties 保持原行）
          const items = completionItems(
            deps.index(),
            language === "yaml" ? line.trim() : line,
            uriToPath(model.uri.toString()),
          );
          if (!items.length) return null;
          const range = keyRangeAt(model, position);
          return {
            suggestions: items.map((item) => ({
              label: item.name,
              kind: monaco.languages.CompletionItemKind.Property,
              detail: item.detail,
              insertText: item.name,
              range,
            })),
          };
        },
      }),
    );
  }

  // ==================== @Value 未知键诊断回写 ====================
  // index.diagnostics 的 path 是工作区相对路径；把 model 的 file URI 转成相对路径后比对。
  const javaModels = new Map<string, monaco.editor.ITextModel>();

  const relativePathOf = (model: monaco.editor.ITextModel): string | null => {
    if (model.uri.scheme !== "file") return null;
    const root = useWorkspaceStore().rootPath;
    if (!root) return null;
    return relativeToRoot(root, uriToPath(model.uri.toString())).replaceAll("\\", "/");
  };

  const refreshMarkers = (model: monaco.editor.ITextModel): void => {
    if (model.isDisposed() || model.getLanguageId() !== JAVA_LANGUAGE_ID) return;
    const relativePath = relativePathOf(model);
    const markers: monaco.editor.IMarkerData[] = [];
    if (relativePath) {
      const lineCount = model.getLineCount();
      for (const input of springMarkerInputs(deps.index())) {
        if (input.path.replaceAll("\\", "/") !== relativePath) continue;
        const lineNumber = Math.min(Math.max(1, input.line), lineCount);
        const endColumn = Math.max(1, model.getLineLength(lineNumber));
        markers.push(
          toMonacoMarker(
            {
              range: {
                start: { line: lineNumber - 1, character: 0 },
                end: { line: lineNumber - 1, character: endColumn },
              },
              severity: 2,
              message: input.message,
            },
            "Spring",
          ),
        );
      }
    }
    monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
  };

  const trackJavaModel = (model: monaco.editor.ITextModel): void => {
    if (model.uri.scheme !== "file" || model.getLanguageId() !== JAVA_LANGUAGE_ID) return;
    javaModels.set(model.uri.toString(), model);
    refreshMarkers(model);
    void deps.ensureIndex();
  };

  for (const model of monaco.editor.getModels()) trackJavaModel(model);
  disposables.push(monaco.editor.onDidCreateModel(trackJavaModel));
  disposables.push(
    monaco.editor.onDidChangeModelLanguage((event) => {
      trackJavaModel(event.model);
      refreshMarkers(event.model);
    }),
  );
  disposables.push(
    monaco.editor.onWillDisposeModel((model) => {
      javaModels.delete(model.uri.toString());
    }),
  );
  // 索引刷新（打开端点清单、手动重扫）后，已打开 Java 文件的 marker 一并更新
  const stopIndexWatch = watch(
    () => deps.index(),
    () => {
      for (const model of javaModels.values()) refreshMarkers(model);
    },
  );
  disposables.push({ dispose: stopIndexWatch });

  return () => {
    registered = false;
    for (const disposable of disposables.splice(0)) disposable.dispose();
    javaModels.clear();
  };
}
