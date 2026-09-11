// ==================== CSS 语言服务补全源（vscode-css-languageservice） ====================
// VS Code 同源核心库：属性 / 属性值 / 伪类 / 变量补全，按扩展名选 css / scss / less service。
// 动态 import 拆独立 chunk；加载/运行失败返回 null → 静态表兜底。

import type { CompletionContext, CompletionSource, Completion } from "@codemirror/autocomplete";
import type { LanguageService as CssLanguageService, Stylesheet } from "vscode-css-languageservice";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { toCmCompletion, docToText } from "./adapters";
import { ParseCache } from "./docCache";

export type CssLang = "css" | "scss" | "sass" | "less";

interface CssBundle {
  css: CssLanguageService;
  scss: CssLanguageService;
  less: CssLanguageService;
  createTextDocument: (
    uri: string,
    languageId: string,
    version: number,
    text: string,
  ) => TextDocument;
}

let bundlePromise: Promise<CssBundle> | null = null;

function ensureBundle(): Promise<CssBundle> {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      const [cssMod, tdMod] = await Promise.all([
        import("vscode-css-languageservice"),
        import("vscode-languageserver-textdocument"),
      ]);
      return {
        css: cssMod.getCSSLanguageService(),
        scss: cssMod.getSCSSLanguageService(),
        less: cssMod.getLESSLanguageService(),
        createTextDocument: (uri, languageId, version, text) =>
          tdMod.TextDocument.create(uri, languageId, version, text),
      };
    })();
    bundlePromise.catch(() => {
      bundlePromise = null;
    });
  }
  return bundlePromise;
}

/** 属性名/值多以词符组成（值含空格场景由 service 的 textEdit 覆盖） */
const CSS_WORD_RE = /[\w-]*/;

/**
 * 文档解析缓存：补全不修改文档，内容未变时复用 TextDocument + Stylesheet，
 * 避免每次按键对全文重新 parse（大文件热点）。
 */
const parseCache = new ParseCache<{ document: TextDocument; stylesheet: Stylesheet }>();

/** CSS 颜色值（kind=16）的色块预览：info 区域渲染 swatch（VS Code 同款） */
function colorSwatchInfo(color: string, doc?: string): () => HTMLElement {
  return () => {
    const el = document.createElement("div");
    el.className = "prism-completion-color";
    const swatch = document.createElement("span");
    swatch.className = "prism-completion-color-swatch";
    swatch.style.background = color;
    const label = document.createElement("span");
    label.textContent = color;
    el.append(swatch, label);
    if (doc) {
      const desc = document.createElement("div");
      desc.className = "prism-completion-color-desc";
      desc.textContent = doc;
      el.append(desc);
    }
    return el;
  };
}

/**
 * 创建 CSS 补全源
 *
 * @param lang 语言（sass 缩进式 v1 复用 scss service）
 */
export function createCssCompletionSource(lang: CssLang): CompletionSource {
  return async (context: CompletionContext) => {
    const docText = context.state.doc.toString();
    if (!docText) return null;
    const line = context.state.doc.lineAt(context.pos);
    const position = { line: line.number - 1, character: context.pos - line.from };

    let bundle: CssBundle;
    try {
      bundle = await ensureBundle();
    } catch {
      return null;
    }

    try {
      const service =
        lang === "less" ? bundle.less : lang === "css" ? bundle.css : bundle.scss;
      const cached = parseCache.get(lang, docText);
      let document = cached?.document;
      let stylesheet = cached?.stylesheet;
      if (!document || !stylesheet) {
        document = bundle.createTextDocument(
          // uri 仅用于 service 内部相对路径解析；未提供 documentContext 时路径补全不出现
          "file:///prism-css.document",
          lang === "sass" ? "scss" : lang,
          1,
          docText,
        );
        stylesheet = service.parseStylesheet(document);
        parseCache.set(lang, docText, { document, stylesheet });
      }
      const list = service.doComplete(document, position, stylesheet);
      const word = context.matchBefore(CSS_WORD_RE);
      const wordFrom = word?.from ?? context.pos;
      // kind=16（Color）补全项附加色块预览
      const options: Completion[] = list.items.map((item) => {
        const cm = toCmCompletion(item);
        if (item.kind === 16 && typeof cm.apply === "string") {
          cm.info = colorSwatchInfo(cm.apply, docToText(item.documentation));
        }
        return cm;
      });
      if (!options.length) return null;
      return { from: wordFrom, options };
    } catch {
      return null;
    }
  };
}
