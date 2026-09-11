// ==================== HTML 语言服务补全源（vscode-html-languageservice） ====================
// VS Code 同源核心库：标签 / 属性 / 属性值 / HTML 实体补全，Vue 模式下注入 Vue 指令 data。
// 动态 import 拆独立 chunk，仅在打开对应类型文件时加载。
// 任何加载/运行失败返回 null → completions.ts 降级静态表兜底。

import type { CompletionContext, CompletionSource } from "@codemirror/autocomplete";
import type { HTMLDocument, LanguageService } from "vscode-html-languageservice";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { toCmCompletions } from "./adapters";
import { buildVueHtmlData } from "./vueData";
import { ParseCache } from "./docCache";

interface ServiceBundle {
  html: LanguageService;
  vue: LanguageService;
  createTextDocument: (
    uri: string,
    languageId: string,
    version: number,
    text: string,
  ) => TextDocument;
}

let bundlePromise: Promise<ServiceBundle> | null = null;

/** 惰性加载服务（html 与 vue 各一实例，共用默认 data；vue 实例注入指令 data） */
function ensureBundle(): Promise<ServiceBundle> {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      const [htmlMod, tdMod] = await Promise.all([
        import("vscode-html-languageservice"),
        import("vscode-languageserver-textdocument"),
      ]);
      const html = htmlMod.getLanguageService();
      const vue = htmlMod.getLanguageService();
      vue.setDataProviders(true, [
        htmlMod.newHTMLDataProvider("prism-vue", buildVueHtmlData()),
      ]);
      return {
        html,
        vue,
        createTextDocument: (uri, languageId, version, text) =>
          tdMod.TextDocument.create(uri, languageId, version, text),
      };
    })();
    // 加载失败：清空缓存，下次调用重试（一次性失败不永久降级）
    bundlePromise.catch(() => {
      bundlePromise = null;
    });
  }
  return bundlePromise;
}

/** word 起点（无 textEdit 的 item 兜底用；属性名/值均以这些字符组成） */
const HTML_WORD_RE = /[\w:.#@-]*/;

/**
 * 文档解析缓存：补全不修改文档，内容未变时复用 TextDocument + HTMLDocument，
 * 避免每次按键对全文重新 parse（大文件热点）。
 */
const parseCache = new ParseCache<{ document: TextDocument; htmlDoc: HTMLDocument }>();

/**
 * 创建 markup 补全源（.html 与 Vue template 段共用）
 *
 * @param filePath 文件路径（决定 vue 模式）
 */
export function createMarkupCompletionSource(filePath: string): CompletionSource {
  const isVue = /\.vue$/i.test(filePath);
  return async (context: CompletionContext) => {
    const docText = context.state.doc.toString();
    if (!docText) return null;
    const line = context.state.doc.lineAt(context.pos);
    const position = { line: line.number - 1, character: context.pos - line.from };

    let bundle: ServiceBundle;
    try {
      bundle = await ensureBundle();
    } catch {
      return null; // 降级静态表
    }

    try {
      const service = isVue ? bundle.vue : bundle.html;
      const cached = parseCache.get(filePath, docText);
      let document = cached?.document;
      let htmlDoc = cached?.htmlDoc;
      if (!document || !htmlDoc) {
        document = bundle.createTextDocument(
          `file://${filePath}`,
          isVue ? "vue" : "html",
          1,
          docText,
        );
        htmlDoc = service.parseHTMLDocument(document);
        parseCache.set(filePath, docText, { document, htmlDoc });
      }
      const list = service.doComplete(document, position, htmlDoc);
      const word = context.matchBefore(HTML_WORD_RE);
      const wordFrom = word?.from ?? context.pos;
      const options = toCmCompletions(list.items);
      if (!options.length) return null;
      return { from: wordFrom, options };
    } catch {
      return null; // 降级静态表
    }
  };
}
