// ==================== HTML / CSS 语言服务适配 ====================
// 继续使用 VS Code 同源的 vscode-html-languageservice / vscode-css-languageservice，
// 把 LSP 结果转成 Monaco 的 provider 返回。服务动态 import，独立 chunk。
import type {
  CompletionItem as LspCompletionItem,
  Hover as LspHover,
  MarkedString,
  MarkupContent,
  Range as LspRange,
} from "vscode-languageserver-types";
import type { IMarkdownString } from "monaco-editor/editor";
import type { HTMLDocument, LanguageService as HtmlLanguageService } from "vscode-html-languageservice";
import type { LanguageService as CssLanguageService, Stylesheet } from "vscode-css-languageservice";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { monaco } from "./setup";
import { ParseCache } from "@/features/editor/completion/docCache";
import { buildVueHtmlData } from "@/features/editor/completion/vueData";
import {
  extractTemplateBindings,
  isVueExpressionAt,
} from "@/features/editor/completion/vueBindings";

type TextDocumentFactory = (
  uri: string,
  languageId: string,
  version: number,
  text: string,
) => TextDocument;

interface ServiceBundle {
  html: HtmlLanguageService;
  vue: HtmlLanguageService;
  css: CssLanguageService;
  scss: CssLanguageService;
  less: CssLanguageService;
  createTextDocument: TextDocumentFactory;
}

let bundlePromise: Promise<ServiceBundle> | null = null;

function ensureBundle(): Promise<ServiceBundle> {
  bundlePromise ??= (async () => {
    const [htmlMod, cssMod, tdMod] = await Promise.all([
      import("vscode-html-languageservice"),
      import("vscode-css-languageservice"),
      import("vscode-languageserver-textdocument"),
    ]);
    const html = htmlMod.getLanguageService();
    const vue = htmlMod.getLanguageService();
    vue.setDataProviders(true, [htmlMod.newHTMLDataProvider("prism-vue", buildVueHtmlData())]);
    return {
      html,
      vue,
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
  return bundlePromise;
}

const markupCache = new ParseCache<{ document: TextDocument; htmlDoc: HTMLDocument }>();
const styleCache = new ParseCache<{ document: TextDocument; stylesheet: Stylesheet }>();

const MARKUP_LANGUAGES = ["html", "vue"];
const STYLE_LANGUAGES = ["css", "scss", "less"];

/** markup 词法：标签/属性名/值/指令都以这些字符组成 */
const MARKUP_WORD_RE = /[\w:.#@\-]*$/;
/** CSS 属性与选择器词法 */
const STYLE_WORD_RE = /[\w@#.\-%]*$/;

function toLspPosition(position: monaco.Position): { line: number; character: number } {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

function toMonacoRange(range: LspRange): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

/** LSP 的 MarkupContent / MarkedString → Monaco 的 IMarkdownString */
function toMarkdownString(value: MarkupContent | MarkedString): IMarkdownString {
  if (typeof value === "string") return { value };
  if ("kind" in value) return { value: value.value };
  return { value: `\u0060\u0060\u0060${value.language}\n${value.value}\n\u0060\u0060\u0060` };
}

function toMonacoDocumentation(
  value: string | MarkupContent | undefined,
): string | IMarkdownString | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  return toMarkdownString(value);
}

/** textEdit 有两种形态：普通 TextEdit 与 InsertReplaceEdit */
function editRange(edit: { range: LspRange } | { insert: LspRange; replace: LspRange }): LspRange {
  return "range" in edit ? edit.range : edit.replace;
}

/** 用 textEdit 的精确范围，缺失时按词法回退到光标前词边界 */
function fallbackRange(model: monaco.editor.ITextModel, position: monaco.Position, pattern: RegExp): monaco.IRange {
  const lineContent = model.getLineContent(position.lineNumber);
  const before = lineContent.slice(0, position.column - 1);
  const match = before.match(pattern);
  const startColumn = position.column - (match?.[0].length ?? 0);
  return {
    startLineNumber: position.lineNumber,
    startColumn,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  };
}

function toMonacoCompletion(
  item: LspCompletionItem,
  fallback: monaco.IRange,
): monaco.languages.CompletionItem {
  const edit = item.textEdit;
  const insertText = edit ? edit.newText : (item.insertText ?? item.label);
  return {
    label: item.label,
    kind: (item.kind ?? 1) as monaco.languages.CompletionItemKind,
    detail: item.detail,
    documentation: toMonacoDocumentation(item.documentation),
    insertText,
    insertTextRules: /[$][\d{]/.test(insertText)
      ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
      : undefined,
    range: edit ? toMonacoRange(editRange(edit)) : fallback,
    sortText: item.sortText,
    filterText: item.filterText,
    preselect: item.preselect,
  };
}

function toMonacoHover(hover: LspHover | null): monaco.languages.Hover | null {
  if (!hover) return null;
  return {
    range: hover.range ? toMonacoRange(hover.range) : undefined,
    contents: hover.contents
      ? (Array.isArray(hover.contents) ? hover.contents : [hover.contents]).map(toMarkdownString)
      : [],
  };
}

const disposables: monaco.IDisposable[] = [];
let registered = false;

/** 注册 HTML/Vue 与 CSS/SCSS/Less 的补全与 hover（幂等） */
export function registerHtmlCssProviders(): void {
  if (registered) return;
  registered = true;

  disposables.push(
    monaco.languages.registerCompletionItemProvider(MARKUP_LANGUAGES, {
      triggerCharacters: ["<", " ", "=", '"', "'", "/", ":", "@", "."],
      async provideCompletionItems(model, position) {
        const text = model.getValue();
        if (!text) return null;
        let bundle: ServiceBundle;
        try {
          bundle = await ensureBundle();
        } catch {
          return null;
        }
        const isVue = model.getLanguageId() === "vue";
        const separator = model.uri.path;
        const cached = markupCache.get(separator, text);
        let document = cached?.document;
        let htmlDoc = cached?.htmlDoc;
        if (!document || !htmlDoc) {
          const service = isVue ? bundle.vue : bundle.html;
          document = bundle.createTextDocument(model.uri.toString(), isVue ? "vue" : "html", 1, text);
          htmlDoc = service.parseHTMLDocument(document);
          markupCache.set(separator, text, { document, htmlDoc });
        }
        const service = isVue ? bundle.vue : bundle.html;
        const list = service.doComplete(document, toLspPosition(position), htmlDoc);
        const fallback = fallbackRange(model, position, MARKUP_WORD_RE);
        const suggestions: monaco.languages.CompletionItem[] = list.items.map((item) =>
          toMonacoCompletion(item, fallback),
        );

        // Vue：template 表达式里补 <script setup> 的顶层绑定
        if (isVue && isVueExpressionAt(text, model.getOffsetAt(position))) {
          for (const binding of extractTemplateBindings(text)) {
            suggestions.push({
              label: binding.name,
              kind:
                binding.kind === "function"
                  ? monaco.languages.CompletionItemKind.Function
                  : monaco.languages.CompletionItemKind.Variable,
              detail: binding.detail,
              insertText: binding.name,
              range: fallback,
              sortText: `0_${binding.name}`,
            });
          }
        }

        if (!suggestions.length) return null;
        return { suggestions };
      },
    }),
  );

  disposables.push(
    monaco.languages.registerHoverProvider(MARKUP_LANGUAGES, {
      async provideHover(model, position) {
        const text = model.getValue();
        if (!text) return null;
        let bundle: ServiceBundle;
        try {
          bundle = await ensureBundle();
        } catch {
          return null;
        }
        const isVue = model.getLanguageId() === "vue";
        const service = isVue ? bundle.vue : bundle.html;
        const document = bundle.createTextDocument(model.uri.toString(), isVue ? "vue" : "html", 1, text);
        const htmlDoc = service.parseHTMLDocument(document);
        return toMonacoHover(service.doHover(document, toLspPosition(position), htmlDoc));
      },
    }),
  );

  disposables.push(
    monaco.languages.registerCompletionItemProvider(STYLE_LANGUAGES, {
      triggerCharacters: [" ", ":", "-", ".", "#", "@", "!", "/"],
      async provideCompletionItems(model, position) {
        const text = model.getValue();
        if (!text) return null;
        let bundle: ServiceBundle;
        try {
          bundle = await ensureBundle();
        } catch {
          return null;
        }
        const languageId = model.getLanguageId();
        const service =
          languageId === "less" ? bundle.less : languageId === "scss" ? bundle.scss : bundle.css;
        const cached = styleCache.get(languageId, text);
        let document = cached?.document;
        let stylesheet = cached?.stylesheet;
        if (!document || !stylesheet) {
          document = bundle.createTextDocument("file:///prism-style.document", languageId, 1, text);
          stylesheet = service.parseStylesheet(document);
          styleCache.set(languageId, text, { document, stylesheet });
        }
        const list = service.doComplete(document, toLspPosition(position), stylesheet);
        if (!list.items.length) return null;
        const fallback = fallbackRange(model, position, STYLE_WORD_RE);
        return { suggestions: list.items.map((item) => toMonacoCompletion(item, fallback)) };
      },
    }),
  );

  disposables.push(
    monaco.languages.registerHoverProvider(STYLE_LANGUAGES, {
      async provideHover(model, position) {
        const text = model.getValue();
        if (!text) return null;
        let bundle: ServiceBundle;
        try {
          bundle = await ensureBundle();
        } catch {
          return null;
        }
        const languageId = model.getLanguageId();
        const service =
          languageId === "less" ? bundle.less : languageId === "scss" ? bundle.scss : bundle.css;
        const document = bundle.createTextDocument("file:///prism-style.document", languageId, 1, text);
        const stylesheet = service.parseStylesheet(document);
        return toMonacoHover(service.doHover(document, toLspPosition(position), stylesheet));
      },
    }),
  );
}
