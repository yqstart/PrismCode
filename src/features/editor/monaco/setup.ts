// Monaco 唯一装配入口。main.ts 必须最先 import 本模块，保证
// MonacoEnvironment.getWorker 在任何 editor.create / 语言注册之前就位。
import * as monaco from "monaco-editor/editor";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import tsWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";
import * as typescriptLanguage from "monaco-editor/languages/features/typescript/register";

import "monaco-editor/features/tokenization/register";
import "monaco-editor/features/bracketMatching/register";
import "monaco-editor/features/caretOperations/register";
import "monaco-editor/features/clipboard/register";
import "monaco-editor/features/codeAction/register";
import "monaco-editor/features/codelens/register";
import "monaco-editor/features/colorPicker/register";
import "monaco-editor/features/comment/register";
// contextmenu 暂不注册：Phase 1 保持 EditorArea.vue 的应用右键菜单行为，
// 命令注册表落地（Phase 3）后再交回 Monaco 自动收录 action。
import "monaco-editor/features/cursorUndo/register";
import "monaco-editor/features/dnd/register";
import "monaco-editor/features/documentSymbols/register";
import "monaco-editor/features/dropOrPasteInto/register";
import "monaco-editor/features/find/register";
import "monaco-editor/features/folding/register";
import "monaco-editor/features/fontZoom/register";
import "monaco-editor/features/format/register";
import "monaco-editor/features/gotoError/register";
import "monaco-editor/features/gotoLine/register";
import "monaco-editor/features/gotoSymbol/register";
import "monaco-editor/features/hover/register";
import "monaco-editor/features/indentation/register";
import "monaco-editor/features/inlayHints/register";
import "monaco-editor/features/inPlaceReplace/register";
import "monaco-editor/features/lineSelection/register";
import "monaco-editor/features/linesOperations/register";
import "monaco-editor/features/linkedEditing/register";
import "monaco-editor/features/links/register";
import "monaco-editor/features/multicursor/register";
import "monaco-editor/features/parameterHints/register";
import "monaco-editor/features/quickOutline/register";
import "monaco-editor/features/referenceSearch/register";
import "monaco-editor/features/rename/register";
import "monaco-editor/features/semanticTokens/register";
import "monaco-editor/features/smartSelect/register";
import "monaco-editor/features/snippet/register";
import "monaco-editor/features/stickyScroll/register";
import "monaco-editor/features/suggest/register";
import "monaco-editor/features/unicodeHighlighter/register";
import "monaco-editor/features/unusualLineTerminators/register";
import "monaco-editor/features/wordHighlighter/register";
import "monaco-editor/features/wordOperations/register";
import "monaco-editor/features/wordPartOperations/register";

// features/<name>/register 只注册该 feature 的增量部分（如 ⌘Click 跳转、
// inline completions），命令本体在 editor/contrib 下，必须显式引入，
// 否则 editor.action.revealDefinition / quickFix / triggerSuggest 都不存在。
import "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js";
import "monaco-editor/editor/contrib/codeAction/browser/codeActionCommands.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";

import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/css/register";
import "monaco-editor/languages/definitions/scss/register";
import "monaco-editor/languages/definitions/less/register";
import "monaco-editor/languages/definitions/html/register";
import { createTokenizationSupport } from "monaco-editor/languages/features/json/tokenization";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/definitions/yaml/register";
import "monaco-editor/languages/definitions/xml/register";

// 子路径 register 不会挂到 monaco.languages 上；按官方 index.js 的形态
// 单独导出 typescript 命名空间（worker 工厂、默认值、枚举都在这里）。
// 注意 monaco.languages.typescript 是只读的 deprecated 桩，不能写。

// 0.57 没有 languages/definitions/json（JSON 只在 features/json，且会拉 json worker）。
// 这里只注册语言 + 官方 tokenizer，诊断仍走 Phase 2 的 JSON.parse。
monaco.languages.register({
  id: "json",
  extensions: [".json", ".bowerrc", ".jshintrc", ".jscsrc", ".eslintrc", ".babelrc", ".har"],
  aliases: ["JSON", "json"],
  mimetypes: ["application/json"],
});
monaco.languages.setTokensProvider("json", createTokenizationSupport(true));

globalThis.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

export { monaco, typescriptLanguage as typescript };
