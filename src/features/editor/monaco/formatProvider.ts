// ==================== 格式化 provider ====================
// 包装既有三级策略（项目 prettier → 内置引擎 → 中文错误），
// 供 Monaco 的「格式化文档 / 格式化选区」与保存时格式化调用。
import { monaco } from "./setup";
import { formatDocumentContent } from "@/features/editor/formatting";

/** 与内置 Prettier 引擎支持的扩展名保持一致 */
const FORMATTABLE_LANGUAGES = [
  "typescript",
  "javascript",
  "json",
  "css",
  "scss",
  "less",
  "html",
  "markdown",
  "yaml",
  "vue",
  "graphql",
] as const;

let registered = false;

export interface FormatProviderOptions {
  /** 工作区根；为空时格式化不可用 */
  root: () => string | null;
  /** 是否启用格式化（设置项 prettierEnabled） */
  enabled: () => boolean;
  /** 失败提示（工作区 notice） */
  onError: (message: string) => void;
}

/** 仅处理真实文件 model（对比视图的 inmemory 模型不参与格式化） */
function filePathOf(model: { uri: { scheme: string; fsPath: string } }): string | null {
  if (model.uri.scheme !== "file") return null;
  return model.uri.fsPath || null;
}

export function registerFormatProviders(options: FormatProviderOptions): void {
  if (registered) return;
  registered = true;

  const languages = FORMATTABLE_LANGUAGES;

  monaco.languages.registerDocumentFormattingEditProvider(languages, {
    async provideDocumentFormattingEdits(model) {
      const root = options.root();
      if (!root || !options.enabled()) return null;
      const path = filePathOf(model);
      if (!path) return null;
      try {
        const text = model.getValue();
        const formatted = await formatDocumentContent(root, path, text);
        if (formatted === text) return null;
        return [{ range: model.getFullModelRange(), text: formatted }];
      } catch (error) {
        options.onError(error instanceof Error ? error.message : String(error));
        return null;
      }
    },
  });

  monaco.languages.registerDocumentRangeFormattingEditProvider(languages, {
    async provideDocumentRangeFormattingEdits(model, range) {
      const root = options.root();
      if (!root || !options.enabled()) return null;
      const path = filePathOf(model);
      if (!path) return null;
      try {
        const text = model.getValue();
        const formatted = await formatDocumentContent(root, path, text, {
          rangeStart: model.getOffsetAt(range.getStartPosition()),
          rangeEnd: model.getOffsetAt(range.getEndPosition()),
        });
        if (formatted === text) return null;
        return [{ range: model.getFullModelRange(), text: formatted }];
      } catch (error) {
        options.onError(error instanceof Error ? error.message : String(error));
        return null;
      }
    },
  });
}
