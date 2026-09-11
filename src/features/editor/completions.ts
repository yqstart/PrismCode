import {
  autocompletion,
  completeAnyWord,
  pickedCompletion,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { basename, languageFromPath } from "@/shared/fs";
import {
  extractClassMemberNames,
  extractObjectMemberNames,
  scanLocalSymbols,
  type LocalSymbol,
} from "@/features/editor/completion/semanticScanner";
import { extractTemplateBindings, isVueExpressionAt, isVueTemplateAt } from "@/features/editor/completion/vueBindings";
import { completionMemory, memoryKey } from "@/features/editor/completion/completionMemory";
import { relativeImportSpec, nodeModulesPath } from "@/features/editor/completion/pathUtils";
import { createSnippetApply } from "@/features/editor/completion/adapters";
import type { UserSnippet } from "@/features/editor/completion/userSnippets";
import { createSignatureExtension } from "@/features/editor/typeService/tsSignatures";
import { createVueScriptContext, isInVueScript } from "@/features/editor/vueScript";

const JS_KEYWORDS = [
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "break",
  "continue",
  "import",
  "export",
  "from",
  "default",
  "async",
  "await",
  "class",
  "extends",
  "implements",
  "new",
  "try",
  "catch",
  "finally",
  "throw",
  "typeof",
  "instanceof",
  "interface",
  "type",
  "enum",
  "namespace",
  "public",
  "private",
  "protected",
  "readonly",
  "static",
  "abstract",
  "as",
  "satisfies",
  "undefined",
  "null",
  "true",
  "false",
  "this",
  "super",
  "yield",
  "of",
  "in",
  "void",
  "never",
  "unknown",
  "any",
  "string",
  "number",
  "boolean",
  "object",
];

const JS_SNIPPETS: Completion[] = [
  snippetCompletion("console.log(${})", {
    label: "log",
    type: "function",
    detail: "console.log",
    boost: 2,
  }),
  snippetCompletion("console.error(${})", {
    label: "error",
    type: "function",
    detail: "console.error",
    boost: 2,
  }),
  snippetCompletion("function ${name}(${args}) {\n  ${}\n}", {
    label: "fn",
    type: "keyword",
    detail: "function",
    boost: 2,
  }),
  snippetCompletion("async function ${name}(${args}) {\n  ${}\n}", {
    label: "afn",
    type: "keyword",
    detail: "async function",
    boost: 2,
  }),
  snippetCompletion("(${args}) => {\n  ${}\n}", {
    label: "af",
    type: "keyword",
    detail: "arrow function",
    boost: 2,
  }),
  snippetCompletion("import { ${names} } from '${module}';", {
    label: "imp",
    type: "keyword",
    detail: "import named",
    boost: 2,
  }),
  snippetCompletion("import ${name} from '${module}';", {
    label: "imd",
    type: "keyword",
    detail: "import default",
    boost: 2,
  }),
  snippetCompletion("export default ${}", {
    label: "ed",
    type: "keyword",
    detail: "export default",
    boost: 2,
  }),
  snippetCompletion("if (${condition}) {\n  ${}\n}", {
    label: "if",
    type: "keyword",
    detail: "if block",
    boost: 2,
  }),
  snippetCompletion("try {\n  ${}\n} catch (${err}) {\n  \n}", {
    label: "try",
    type: "keyword",
    detail: "try/catch",
    boost: 2,
  }),
];

const HTML_TAGS = [
  "div",
  "span",
  "p",
  "a",
  "ul",
  "ol",
  "li",
  "button",
  "form",
  "label",
  "select",
  "option",
  "textarea",
  "section",
  "header",
  "footer",
  "nav",
  "main",
  "article",
  "aside",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
  "template",
  "slot",
  "component",
  "router-link",
  "router-view",
];

const VOID_HTML_TAGS = ["img", "br", "hr", "meta", "link", "input"];

const HTML_TAG_SNIPPETS: Completion[] = [
  ...HTML_TAGS.map((tag) =>
    snippetCompletion(`<${tag}>\${}</${tag}>`, {
      label: tag,
      type: "type",
      detail: "HTML",
      boost: 3,
    }),
  ),
  ...VOID_HTML_TAGS.map((tag) =>
    snippetCompletion(`<${tag} />`, {
      label: tag,
      type: "type",
      detail: "HTML",
      boost: 3,
    }),
  ),
];

const CSS_PROPERTIES = [
  "display",
  "position",
  "width",
  "height",
  "margin",
  "padding",
  "border",
  "border-radius",
  "background",
  "background-color",
  "color",
  "font-size",
  "font-weight",
  "line-height",
  "flex",
  "flex-direction",
  "align-items",
  "justify-content",
  "gap",
  "overflow",
  "opacity",
  "z-index",
  "box-shadow",
  "transform",
  "transition",
  "cursor",
  "text-align",
];

const TAILWIND_CLASSES = [
  "flex",
  "grid",
  "block",
  "inline-flex",
  "hidden",
  "relative",
  "absolute",
  "fixed",
  "items-center",
  "justify-center",
  "justify-between",
  "gap-2",
  "gap-4",
  "p-2",
  "p-4",
  "px-4",
  "py-2",
  "m-0",
  "w-full",
  "h-full",
  "min-h-0",
  "text-sm",
  "text-base",
  "font-medium",
  "font-semibold",
  "rounded",
  "rounded-md",
  "rounded-lg",
  "border",
  "truncate",
  "overflow-hidden",
  "overflow-auto",
  "cursor-pointer",
];

function isInCommentOrString(context: CompletionContext): boolean {
  const tree = syntaxTree(context.state);
  let node = tree.resolveInner(context.pos, -1);
  for (let i = 0; i < 4 && node; i += 1) {
    const name = node.name;
    if (
      name.includes("Comment") ||
      name.includes("comment") ||
      name === "String" ||
      name === "String2" ||
      name === "TemplateString"
    ) {
      return true;
    }
    const parent = node.parent;
    if (!parent) break;
    node = parent;
  }
  return false;
}

function isVueTemplateContext(doc: string, pos: number): boolean {
  return isVueTemplateAt(doc, pos);
}

function isMarkupContext(context: CompletionContext, filePath: string): boolean {
  const name = basename(filePath).toLowerCase();
  if (name.endsWith(".html") || name.endsWith(".htm")) return true;
  if (name.endsWith(".vue")) {
    return isVueTemplateContext(context.state.doc.toString(), context.pos);
  }
  return false;
}

function isScriptContext(context: CompletionContext, filePath: string): boolean {
  const name = basename(filePath).toLowerCase();
  if (
    name.endsWith(".ts") ||
    name.endsWith(".tsx") ||
    name.endsWith(".js") ||
    name.endsWith(".jsx") ||
    name.endsWith(".mjs") ||
    name.endsWith(".cjs")
  ) {
    return true;
  }
  if (name.endsWith(".vue")) {
    const before = context.state.doc.sliceString(0, context.pos);
    const openScript = before.lastIndexOf("<script");
    const closeScript = before.lastIndexOf("</script>");
    return openScript >= 0 && openScript > closeScript;
  }
  return false;
}

function isCssContext(context: CompletionContext, filePath: string): boolean {
  const name = basename(filePath).toLowerCase();
  if (
    name.endsWith(".css") ||
    name.endsWith(".scss") ||
    name.endsWith(".sass") ||
    name.endsWith(".less")
  ) {
    return true;
  }
  if (name.endsWith(".vue")) {
    const before = context.state.doc.sliceString(0, context.pos);
    const openStyle = before.lastIndexOf("<style");
    const closeStyle = before.lastIndexOf("</style>");
    return openStyle >= 0 && openStyle > closeStyle;
  }
  return false;
}

function keywordSource(context: CompletionContext): CompletionResult | null {
  if (isInCommentOrString(context)) return null;
  const word = context.matchBefore(/\w*/);
  if (!word || word.text.length < 1) return null;
  if (word.from === word.to && !context.explicit) return null;

  const typed = word.text.toLowerCase();
  const keywords = JS_KEYWORDS.filter((k) => k.startsWith(typed)).map((label) => ({
    label,
    type: "keyword" as const,
    boost: 1,
  }));
  const snippets = JS_SNIPPETS.filter((s) =>
    s.label.toLowerCase().startsWith(typed),
  );

  const options = [...snippets, ...keywords].slice(0, 24);
  if (!options.length) return null;

  return {
    from: word.from,
    options,
    validFor: /^\w*$/,
  };
}

function htmlTagSource(context: CompletionContext): ReturnType<CompletionSource> {
  const word = context.matchBefore(/[\w-]*/);
  if (!word || word.text.length < 1) return null;
  if (word.from === word.to && !context.explicit) return null;

  const typed = word.text.toLowerCase();
  const options = HTML_TAG_SNIPPETS.filter((s) =>
    s.label.toLowerCase().startsWith(typed),
  ).slice(0, 20);
  if (!options.length) return null;

  return {
    from: word.from,
    options,
    validFor: /^[\w-]*$/,
  };
}

function cssSource(context: CompletionContext): ReturnType<CompletionSource> {
  if (isInCommentOrString(context)) return null;
  const word = context.matchBefore(/[\w-]*/);
  if (!word || word.text.length < 2) return null;
  if (word.from === word.to && !context.explicit) return null;

  const typed = word.text.toLowerCase();
  const options = CSS_PROPERTIES.filter((p) => p.startsWith(typed))
    .slice(0, 16)
    .map((label) => ({
      label,
      type: "property" as const,
      detail: "CSS",
    }));
  if (!options.length) return null;

  return {
    from: word.from,
    options,
    validFor: /^[\w-]*$/,
  };
}

function tailwindSource(
  context: CompletionContext,
  filePath: string,
): ReturnType<CompletionSource> {
  const word = context.matchBefore(/[\w:-]*/);
  if (!word || word.text.length < 2) return null;
  if (word.from === word.to && !context.explicit) return null;

  const before = context.state.doc.sliceString(Math.max(0, word.from - 80), word.from);
  // 兼容 HTML class= / Vue :class= / React className= / Astro class:list=
  // 负向字符类排除 `]` 是为了：Tailwind 任意值类（如 `bg-[#fff]`）内含 `[` `]` 时，
  // 避免 `]` 被错认为属性闭合边界，导致任意值类无法触发补全
  const inClassAttr = /(?:class|className|:class|class:list)\s*=\s*["'{][^"'{}[\]]*$/.test(before);
  if (!inClassAttr && !isCssContext(context, filePath)) {
    return null;
  }

  const typed = word.text.toLowerCase();
  const options = TAILWIND_CLASSES.filter((c) => c.startsWith(typed))
    .slice(0, 16)
    .map((label) => ({
      label,
      type: "constant" as const,
      detail: "Tailwind",
    }));
  if (!options.length) return null;

  return {
    from: word.from,
    options,
    validFor: /^[\w:-]*$/,
  };
}

/** 仅 Ctrl+Space 时补全文档词，避免噪声 */
function documentWordSource(context: CompletionContext): ReturnType<CompletionSource> {
  if (!context.explicit) return null;
  return completeAnyWord(context);
}

// ==================== 语义补全源（JS/TS） ====================

/** 本地符号 → CM Completion（detail 带声明摘要与行号） */
function localSymbolToCompletion(sym: LocalSymbol, lang: string): Completion {
  const typeMap: Record<LocalSymbol["kind"], Completion["type"]> = {
    variable: "variable",
    function: "function",
    class: "class",
    interface: "interface",
    type: "type",
    enum: "enum",
  };
  return {
    label: sym.name,
    type: typeMap[sym.kind],
    detail: `${sym.detail} · 第${sym.line}行`,
    boost: 3 + completionMemory.boost(memoryKey(lang, sym.name)),
  };
}

// ==================== import 路径补全 + 自动导入 ====================

/**
 * import 路径补全：`from './` / `import '` / `require('` 后列文件/目录（VS Code 同款）。
 * 支持相对路径（./ ../）、@/ 别名（→ root/src）、node_modules 裸包（包名 + 包内子路径）。
 */
async function importPathSource(
  context: CompletionContext,
  filePath: string,
): Promise<CompletionResult | null> {
  const doc = context.state.doc.toString();
  const before = doc.slice(0, context.pos);
  const m = before.match(/(?:from\s+|import\s+|require\(\s*)(['"])([^'"\n]*)$/);
  if (!m) return null;
  const spec = m[2];
  const specStart = context.pos - spec.length;

  const { useWorkspaceStore } = await import("@/stores/workspace");
  const root = useWorkspaceStore().rootPath;
  if (!root) return null;

  let dirPath: string;
  let prefix: string;
  let isNodeModules = false;
  const lastSlash = spec.lastIndexOf("/");
  if (spec.startsWith("@/")) {
    const rest = spec.slice(2);
    dirPath = `${root}/src${rest.slice(0, lastSlash + 1)}`;
    prefix = rest.slice(lastSlash + 1);
  } else if (spec.startsWith(".")) {
    const fileDir = filePath.slice(0, filePath.lastIndexOf("/"));
    dirPath = lastSlash >= 0 ? `${fileDir}/${spec.slice(0, lastSlash)}` : fileDir;
    prefix = lastSlash >= 0 ? spec.slice(lastSlash + 1) : spec;
  } else {
    // 裸包（node_modules）
    const parsed = nodeModulesPath(root, spec);
    if (!parsed) return null;
    dirPath = parsed.dirPath;
    prefix = parsed.prefix;
    isNodeModules = true;
  }
  // 规范化目录路径（`a/./b` → `a/b`，`./` 兜底）
  dirPath = dirPath.replace(/\/\.(?=\/|$)/g, "");
  if (!dirPath) dirPath = root;

  const { listDir } = await import("@/shared/fs");
  let entries: Array<{ name: string; isDir: boolean; path: string }>;
  try {
    entries = await listDir(root, dirPath);
  } catch {
    return null;
  }

  const options = entries
    .filter((e) => {
      if (e.name.startsWith(".")) return false;
      if (isNodeModules) {
        // node_modules 顶层：排除 pnpm 内部目录与元文件；symlink 目录 is_dir=false 也算包
        if (e.name === ".pnpm" || e.name === ".bin" || e.name === ".cache") return false;
        if (/\.(json|lock|map)$/.test(e.name) && !e.isDir) return false;
        if (!e.name.toLowerCase().startsWith(prefix.toLowerCase())) return false;
        // 顶层包目录无子路径时全列；有子路径时按前缀过滤
        return true;
      }
      return e.name.toLowerCase().startsWith(prefix.toLowerCase());
    })
    .slice(0, 30)
    .map((e) => ({
      label: e.isDir ? `${e.name}/` : e.name,
      type: e.isDir ? "namespace" : "text",
      detail: isNodeModules ? "node_modules" : "路径",
      boost: 3,
    }));
  if (!options.length) return null;
  return { from: specStart, options, validFor: /^[\w@/.-]*$/ };
}

/** 转义正则特殊字符（自动导入去重判断用） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 跨文件符号 → CM Completion；未导入的符号附带「自动导入」行为：
 * 接受时同时插入 import 语句（VS Code Auto Import 轻量版，仅相对路径）。
 */
function crossFileSymbolToCompletion(
  hit: { name: string; kind: string; path: string; line: number },
  root: string,
  lang: string,
  currentFile: string,
  docText: string,
): Completion {
  const rel = hit.path.startsWith(root)
    ? hit.path.slice(root.length + 1)
    : basename(hit.path);
  const base: Completion = {
    label: hit.name,
    type: "namespace",
    detail: `${rel} · 第${hit.line}行`,
    boost: 2 + completionMemory.boost(memoryKey(lang, hit.name)),
  };

  // 非 script 文件（vue）不自动导入（import 段定位复杂，v1 不做）；已导入的符号也不重复导入
  const isVue = /\.vue$/i.test(currentFile);
  const alreadyImported = new RegExp(
    `import[^;]*\\b${escapeRegExp(hit.name)}\\b`,
  ).test(docText);
  if (isVue || alreadyImported) return base;

  const spec = relativeImportSpec(currentFile, hit.path);
  return {
    ...base,
    detail: `${base.detail} · 自动导入`,
    boost: (base.boost ?? 0) + 1,
    apply: (view, _completion, from, to) => {
      // 顶部 import 插入点：第一个 import 语句行尾，否则文件开头
      const importLine = docText.match(/^import[^\n]*\n/m);
      const importPos = importLine
        ? (importLine.index ?? 0) + importLine[0].length
        : 0;
      view.dispatch({
        changes: [
          { from, to, insert: hit.name },
          {
            from: importPos,
            to: importPos,
            insert: `import { ${hit.name} } from '${spec}';\n`,
          },
        ],
        userEvent: "input.complete",
      });
    },
  };
}

/**
 * `obj.` 成员联想：找当前文件里同名对象字面量 / class 声明，提取成员名。
 * 纯本地（零类型推断），命中即返回，未命中返回 null 走常规补全。
 */
function memberCompletion(
  context: CompletionContext,
  doc: string,
): CompletionResult | null {
  const before = doc.slice(Math.max(0, context.pos - 120), context.pos);
  const m = before.match(/([A-Za-z_$][\w$]*)\s*\.\s*([\w$]*)$/);
  if (!m) return null;
  const objName = m[1];
  const typed = m[2];
  const wordStart = context.pos - typed.length;

  const members: string[] = [];
  // 对象字面量：const obj = { a, b }
  members.push(...extractObjectMemberNames(doc, objName));
  // class / interface：class Foo { bar() {} }
  members.push(...extractClassMemberNames(doc, objName));

  const unique = [...new Set(members)].filter((n) =>
    n.toLowerCase().startsWith(typed.toLowerCase()),
  );
  if (!unique.length) return null;
  return {
    from: wordStart,
    options: unique.map((name) => ({
      label: name,
      type: "property",
      detail: `${objName}.`,
      boost: 4,
    })),
    validFor: /^[\w$]*$/,
  };
}

/** script 上下文语义源：成员联想 → 本地符号 + 跨文件符号 + 关键词/snippet（异常降级关键词） */
async function scriptSemanticSource(
  context: CompletionContext,
  filePath: string,
): Promise<CompletionResult | null> {
  try {
    const doc = context.state.doc.toString();
    const lang = languageFromPath(filePath);

    // 1. 成员联想优先（obj. 场景；注释/字符串内找不到声明会自然返回 null，无害）
    const member = memberCompletion(context, doc);
    if (member) return member;

    if (isInCommentOrString(context)) return null;
    const word = context.matchBefore(/\w*/);
    if (!word || word.text.length < 1) return null;
    if (word.from === word.to && !context.explicit) return null;

    const typed = word.text;

    // 2. 本地符号（光标前已声明）
    const local = scanLocalSymbols(doc, context.pos)
      .filter((s) => s.name.toLowerCase().startsWith(typed.toLowerCase()))
      .slice(0, 24)
      .map((s) => localSymbolToCompletion(s, lang));

    // 3. 跨文件符号（工作区符号索引；失败不影响本地；未导入符号自动导入）
    let cross: Completion[] = [];
    let root = "";
    try {
      const { useWorkspaceStore } = await import("@/stores/workspace");
      root = useWorkspaceStore().rootPath ?? "";
      if (root) {
        const { workspaceSymbols } = await import(
          "@/features/editor/workspaceSymbols"
        );
        const hits = await workspaceSymbols.searchSymbols(root, typed, 12);
        cross = hits.map((h) =>
          crossFileSymbolToCompletion(h, root, lang, filePath, doc),
        );
      }
    } catch {
      // 跨文件索引不可用：静默跳过
    }

    // 4. 关键词 + snippet（低 boost 兜底，语义项优先展示；最近使用记忆加成）
    const kw = keywordSource(context);
    const kwOptions = (kw?.options ?? []).map((c) => ({
      ...c,
      boost: (c.boost ?? 1) + completionMemory.boost(memoryKey(lang, c.label)),
    }));

    const options = [...local, ...cross, ...kwOptions];
    if (!options.length) return null;
    return { from: word.from, options, validFor: /^\w*$/ };
  } catch {
    return keywordSource(context);
  }
}

// ==================== HTML / CSS 服务源（VS Code 同源库，失败降级静态表） ====================

/** markup 上下文：HTML service（Vue 模式含指令 data）；加载/运行失败降级静态 HTML 表 */
async function markupServiceSource(
  context: CompletionContext,
  filePath: string,
): Promise<CompletionResult | null> {
  try {
    const { createMarkupCompletionSource } = await import(
      "@/features/editor/completion/htmlCompletion"
    );
    const result = await createMarkupCompletionSource(filePath)(context);
    if (result) return result;
  } catch {
    // 降级静态表
  }
  return htmlTagSource(context);
}

/** css 上下文：CSS service（按扩展名分派）；失败降级静态 CSS 表 */
async function cssServiceSource(
  context: CompletionContext,
  filePath: string,
): Promise<CompletionResult | null> {
  try {
    const { createCssCompletionSource } = await import(
      "@/features/editor/completion/cssCompletion"
    );
    const name = basename(filePath).toLowerCase();
    // 推断类型与 cssCompletion.CssLang 字面量联合一致
    const lang = name.endsWith(".less")
      ? "less"
      : name.endsWith(".sass")
        ? "sass"
        : name.endsWith(".scss")
          ? "scss"
          : "css";
    const result = await createCssCompletionSource(lang)(context);
    if (result) return result;
  } catch {
    // 降级静态表
  }
  return cssSource(context);
}

// ==================== Vue template 表达式源（script setup 绑定） ====================

/** 是否在 Vue template 表达式上下文（{{ 内 或 :/@/v- 属性值内；纯函数在 vueBindings） */
function isVueExpressionContext(context: CompletionContext): boolean {
  return isVueExpressionAt(context.state.doc.toString(), context.pos);
}

/** Vue template 表达式补全：注入 <script setup> 顶层绑定（ref/const/function/import） */
function vueExpressionSource(context: CompletionContext): CompletionResult | null {
  if (!isVueExpressionContext(context)) return null;
  const doc = context.state.doc.toString();
  const word = context.matchBefore(/[\w$]*/);
  if (!word) return null;
  const typed = word.text.toLowerCase();

  const bindings = extractTemplateBindings(doc).filter((b) =>
    b.name.toLowerCase().startsWith(typed),
  );
  if (!bindings.length) return null;

  return {
    from: word.from,
    options: bindings.map((b) => ({
      label: b.name,
      type: b.kind === "function" ? "function" : b.kind === "import" ? "namespace" : "variable",
      detail: b.detail,
      boost: 3,
    })),
    validFor: /^[\w$]*$/,
  };
}

// ==================== 用户自定义 snippets 源（VS Code snippets.json 体系） ====================

/** 用户 snippets（全局 ~/.prismcode/snippets + 项目 .vscode/*.code-snippets；scope 语言过滤） */
async function userSnippetSource(
  context: CompletionContext,
  filePath: string,
): Promise<CompletionResult | null> {
  const word = context.matchBefore(/[\w-]*/);
  if (!word || word.text.length < 1) return null;
  if (word.from === word.to && !context.explicit) return null;
  const typed = word.text.toLowerCase();

  let root = "";
  try {
    const { useWorkspaceStore } = await import("@/stores/workspace");
    root = useWorkspaceStore().rootPath ?? "";
  } catch {
    // 无工作区：全局 snippets 仍可用
  }

  let snippets: UserSnippet[];
  try {
    const { loadUserSnippets, snippetMatchesScope, languageIdFor } = await import(
      "@/features/editor/completion/userSnippets"
    );
    const langId = languageIdFor(filePath);
    if (!langId) return null;
    snippets = await loadUserSnippets(root);
    const options = snippets
      .filter(
        (s) =>
          snippetMatchesScope(s, langId) &&
          s.prefix.some((p) => p.toLowerCase().startsWith(typed)),
      )
      .slice(0, 20)
      .map((s) => {
        const prefix =
          s.prefix.find((p) => p.toLowerCase().startsWith(typed)) ?? s.prefix[0];
        return {
          label: prefix,
          type: "keyword" as const,
          detail: s.name,
          info: s.description,
          boost: 2,
          apply: createSnippetApply(s.body),
        };
      });
    if (!options.length) return null;
    return { from: word.from, options, validFor: /^[\w-]*$/ };
  } catch {
    return null;
  }
}

/** 按文件类型分发的本地补全源（语义/service/关键词/snippet/HTML/CSS/Tailwind/文档词）；供编辑器独立使用 */
export function sourcesForPath(filePath: string): CompletionSource[] {
  const sources: CompletionSource[] = [];

  sources.push((context) => {
    if (isScriptContext(context, filePath)) {
      // 1) import 路径上下文优先（`from './` 等）
      // 2) 非 .vue 文件走类型服务（真类型感知成员 + 自动导入；未就绪/失败降级轻量）
      // 3) 轻量语义兜底（.vue script 段直接用轻量层）
      if (/\.vue$/i.test(filePath)) {
        return importPathSource(context, filePath).then(
          async (r) => {
            if (r) return r;
            const doc = context.state.doc.toString();
            if (!isInVueScript(doc, context.pos)) return scriptSemanticSource(context, filePath);
            const virtual = createVueScriptContext(filePath, doc);
            const { createTsCompletionSource } = await import(
              "@/features/editor/typeService/tsCompletions"
            );
            const typed = await createTsCompletionSource(filePath, {
              serviceFilePath: virtual.fileName,
              serviceText: (source) => createVueScriptContext(filePath, source).text,
            })(context);
            return typed ?? scriptSemanticSource(context, filePath);
          },
        );
      }
      return importPathSource(context, filePath).then(async (r) => {
        if (r) return r;
        const { createTsCompletionSource } = await import(
          "@/features/editor/typeService/tsCompletions"
        );
        const r2 = await createTsCompletionSource(filePath)(context);
        return r2 ?? scriptSemanticSource(context, filePath);
      });
    }
    return null;
  });

  sources.push((context) => {
    if (isMarkupContext(context, filePath)) {
      return markupServiceSource(context, filePath);
    }
    return null;
  });

  // Vue template 表达式：与 HTML service 并行，CM 合并展示
  sources.push((context) => {
    if (!isVueTemplateContext(context.state.doc.toString(), context.pos)) return null;
    return vueExpressionSource(context);
  });

  sources.push((context) => {
    if (isCssContext(context, filePath)) {
      return cssServiceSource(context, filePath);
    }
    return null;
  });

  sources.push((context) => {
    if (isMarkupContext(context, filePath) || isCssContext(context, filePath)) {
      return tailwindSource(context, filePath);
    }
    return null;
  });

  // 用户自定义 snippets（所有文件类型；scope 过滤内部判断）
  sources.push((context) => userSnippetSource(context, filePath));

  sources.push(documentWordSource);
  return sources;
}

/** 本地语法 / 片段补全（无 AI、无网络） */
export function createCompletionExtension(filePath: string): Extension {
  const sources = sourcesForPath(filePath);
  const lang = languageFromPath(filePath);
  const isScriptFile = /\.(ts|tsx|js|jsx|mjs|cjs|vue)$/i.test(filePath);
  return [
    autocompletion({
      activateOnTyping: true,
      maxRenderedOptions: 18,
      icons: true,
      closeOnBlur: true,
      defaultKeymap: true,
    }),
    // 记录补全接受 → 最近使用记忆（VS Code 排序行为）
    EditorView.updateListener.of((update) => {
      for (const tr of update.transactions) {
        const picked = tr.annotation(pickedCompletion);
        if (picked?.label) {
          completionMemory.record(memoryKey(lang, picked.label));
        }
      }
    }),
    // 签名帮助（仅 script 文件；类型服务未就绪静默）
    ...(isScriptFile
      ? [createSignatureExtension(filePath)]
      : []),
    EditorState.languageData.of(() =>
      sources.map((autocomplete) => ({ autocomplete })),
    ),
  ];
}
