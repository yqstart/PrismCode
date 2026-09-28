// ==================== 大文件分级策略 ====================
// 打开超大文件时按体积降级编辑器特性，避免 TS worker 与渲染装饰把主线程拖住。
// 阈值按字符数近似字节（源码基本是单字节字符，中文注释会偏保守）。
import type { editor as MonacoEditorApi } from "monaco-editor/editor";
import { languageIdForPath } from "./langSetup";

/** 超过此体积：关闭括号着色、粘性滚动等语法装饰 */
export const LARGE_FILE_CHARS = 2 * 1024 * 1024;
/** 超过此体积：再关闭折叠/自动换行，并降级为纯文本语言 */
export const HUGE_FILE_CHARS = 5 * 1024 * 1024;

/** 超大文件用纯文本语言：Monaco 的 TS 服务对 5MB+ 文件会长时间占用 worker */
export function languageForContent(path: string, content: string): string {
  if (content.length > HUGE_FILE_CHARS) return "plaintext";
  return languageIdForPath(path);
}

/** 按体积给出要覆盖的编辑器选项（小文件返回空对象，不产生任何副作用） */
export function largeFileOptions(content: string): MonacoEditorApi.IEditorOptions {
  if (content.length <= LARGE_FILE_CHARS) return {};
  const huge = content.length > HUGE_FILE_CHARS;
  return {
    bracketPairColorization: { enabled: false },
    guides: { indentation: !huge, bracketPairs: false },
    stickyScroll: { enabled: false },
    minimap: { enabled: false },
    renderWhitespace: "none",
    occurrencesHighlight: "off",
    ...(huge ? { folding: false, wordWrap: "off" } : {}),
  };
}
