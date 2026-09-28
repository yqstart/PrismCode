// ==================== Vue SFC 语言注册与高亮 ====================
// Monaco 0.57 没有 vue 语言定义，token provider 接口也拿不到行号
// （无法按 region 委托给 html/ts/css 的 tokenizer），因此按计划兜底：
// 用 Monarch 写 template / script / style 三态语法。补全与诊断不受影响
// （markup 走 htmlCssProvider，script 段走 TS worker 的虚拟文件）。
import { monaco } from "./setup";

const JS_KEYWORDS = [
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const",
  "continue", "debugger", "declare", "default", "delete", "do", "else", "enum",
  "export", "extends", "false", "finally", "for", "from", "function", "get",
  "if", "implements", "import", "in", "instanceof", "interface", "let", "new",
  "null", "of", "package", "private", "protected", "public", "readonly", "return",
  "set", "static", "super", "switch", "this", "throw", "true", "try", "type",
  "typeof", "undefined", "var", "void", "while", "with", "yield",
];

const CSS_AT_RULES = [
  "media", "import", "charset", "keyframes", "font-face", "supports", "layer",
  "container", "property", "scope", "page", "namespace",
];

const vueLanguage: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".vue",
  ignoreCase: false,
  keywords: JS_KEYWORDS,
  atRules: CSS_AT_RULES,
  brackets: [
    { open: "{", close: "}", token: "delimiter.curly" },
    { open: "[", close: "]", token: "delimiter.square" },
    { open: "(", close: ")", token: "delimiter.parenthesis" },
  ],

  tokenizer: {
    root: [
      [/<!--/, "comment", "@htmlComment"],
      [/<template(?=\s|>)/, { token: "tag", next: "@template" }],
      [/<script(?=\s|>)/, { token: "tag", next: "@script" }],
      [/<style(?=\s|>)/, { token: "tag", next: "@style" }],
      [/<\/?[A-Za-z][\w.-]*/, "tag"],
      [/[A-Za-z_$][\w$-]*/, "identifier"],
      [/"([^"\\]|\\.)*$/, "string.invalid"],
      [/"/, "string", "@doubleQuote"],
      [/'([^'\\]|\\.)*$/, "string.invalid"],
      [/'/, "string", "@singleQuote"],
      [/\s+/, "white"],
    ],

    htmlComment: [
      [/-->/, "comment", "@pop"],
      [/./, "comment"],
    ],

    template: [
      [/<\/template\s*>/, { token: "tag", next: "@pop" }],
      [/<!--/, "comment", "@htmlComment"],
      // 属性名（含指令与简写）
      [/([:@#]|v-)[\w:.[\]-]*/, "attribute.name"],
      [/[\w-]+(?=\s*=)/, "attribute.name"],
      [/"([^"\\]|\\.)*"/, "attribute.value"],
      [/'([^'\\]|\\.)*'/, "attribute.value"],
      [/\{\{/, { token: "delimiter", next: "@interpolation" }],
      [/<\/?[A-Za-z][\w.-]*/, "tag"],
      [/\/?>/, "tag"],
      [/[A-Za-z_$][\w$-]*/, "identifier"],
      [/\s+/, "white"],
    ],

    interpolation: [
      [/\}\}/, { token: "delimiter", next: "@pop" }],
      [/[A-Za-z_$][\w$]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
      [/[0-9]+(\.[0-9]+)?/, "number"],
      [/["'][^"']*["']/, "string"],
      [/[.:]/, "delimiter"],
      [/\s+/, "white"],
    ],

    script: [
      [/<\/script\s*>/, { token: "tag", next: "@pop" }],
      [/\/\/.*$/, "comment"],
      [/\/\*/, "comment", "@jsBlockComment"],
      [/`/, "string", "@jsTemplateString"],
      [/"([^"\\]|\\.)*$/, "string.invalid"],
      [/"/, "string", "@doubleQuote"],
      [/'([^'\\]|\\.)*$/, "string.invalid"],
      [/'/, "string", "@singleQuote"],
      [/[A-Za-z_$][\w$]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
      [/[A-Z][\w$]*/, "type.identifier"],
      [/\d+(\.\d+)?([eE][+-]?\d+)?/, "number"],
      [/[{}()[\]]/, "@brackets"],
      [/[=><!~?:&|+\-*/^%]+/, "operator"],
      [/[;,.]/, "delimiter"],
      [/\s+/, "white"],
    ],

    jsBlockComment: [
      [/[^/*]+/, "comment"],
      [/\*\//, "comment", "@pop"],
      [/[/*]/, "comment"],
    ],

    jsTemplateString: [
      [/[^\\`$]+/, "string"],
      [/\\./, "string.escape"],
      [/`/, "string", "@pop"],
    ],

    doubleQuote: [
      [/[^\\"]+/, "string"],
      [/\\./, "string.escape"],
      [/"/, "string", "@pop"],
    ],

    singleQuote: [
      [/[^\\']+/, "string"],
      [/\\./, "string.escape"],
      [/'/, "string", "@pop"],
    ],

    style: [
      [/<\/style\s*>/, { token: "tag", next: "@pop" }],
      [/\/\*/, "comment", "@cssBlockComment"],
      [/@[\w-]+/, { cases: { "@atRules": "keyword", "@default": "tag" } }],
      [/[.#][\w-]+/, "type"],
      [/&/, "operator"],
      [/[A-Za-z-]+(?=\s*:)/, "attribute.name"],
      [/#[0-9a-fA-F]{3,8}\b/, "number.hex"],
      [/\d+(\.\d+)?(px|em|rem|%|vh|vw|s|ms|deg|fr|ch|ex|pt|cm|mm|in|pc)?/, "number"],
      [/"([^"\\]|\\.)*"/, "attribute.value"],
      [/'([^'\\]|\\.)*'/, "attribute.value"],
      [/\b(var|calc|url|rgba?|hsla?|linear-gradient|radial-gradient|var)\b/, "function"],
      [/[{}()[\];:,>+~*]/, "delimiter"],
      [/[A-Za-z-]+/, "identifier"],
      [/\s+/, "white"],
    ],

    cssBlockComment: [
      [/[^/*]+/, "comment"],
      [/\*\//, "comment", "@pop"],
      [/[/*]/, "comment"],
    ],
  },
};

let registered = false;

/** 注册 vue 语言与 Monarch 高亮（幂等） */
export function registerVueLanguage(): void {
  if (registered) return;
  registered = true;
  monaco.languages.register({
    id: "vue",
    extensions: [".vue"],
    aliases: ["Vue", "vue"],
    mimetypes: ["text/x-vue"],
  });
  monaco.languages.setMonarchTokensProvider("vue", vueLanguage);
  // 括号配对与注释沿用 HTML 语义（template 段占多数）
  monaco.languages.setLanguageConfiguration("vue", {
    comments: { blockComment: ["<!--", "-->"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
      ["<", ">"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });
}
