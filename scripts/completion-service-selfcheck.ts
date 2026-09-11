// ==================== 语言服务集成自测（node --experimental-strip-types scripts/completion-service-selfcheck.ts） ====================
// 直接调用 vscode-html-languageservice / vscode-css-languageservice 真实 API，
// 验证 doComplete 返回结构与 textEdit 范围，再用适配层转换，模拟 WebView 内行为。

import { getLanguageService, newHTMLDataProvider } from "vscode-html-languageservice";
import { getCSSLanguageService } from "vscode-css-languageservice";
import { TextDocument } from "vscode-languageserver-textdocument";
import { toCmCompletions, lspKindToCmType } from "../src/features/editor/completion/adapters.ts";
import { buildVueHtmlData } from "../src/features/editor/completion/vueData.ts";

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`, detail ?? "");
  }
}

/** 构造 LSP Position */
function pos(doc: string, offset: number): { line: number; character: number } {
  const before = doc.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}

/** 补全辅助：返回 label 列表 */
function completeHtml(
  service: ReturnType<typeof getLanguageService>,
  text: string,
  offset: number,
): { labels: string[]; items: unknown[] } {
  const document = TextDocument.create("file:///t.html", "html", 1, text);
  const htmlDoc = service.parseHTMLDocument(document);
  const list = service.doComplete(document, pos(text, offset), htmlDoc);
  return { labels: list.items.map((i) => i.label), items: list.items };
}

// ==================== HTML ====================
console.log("== HTML service ==");
const htmlService = getLanguageService();

// 标签补全
{
  const text = "<di";
  const { labels } = completeHtml(htmlService, text, text.length);
  assert("标签补全含 div", labels.includes("div"), labels.slice(0, 10));
  assert("标签补全含 dialog", labels.some((l) => l.startsWith("dialog")), labels.slice(0, 10));
}

// 属性补全
{
  const text = '<div cla';
  const { labels, items } = completeHtml(htmlService, text, text.length);
  assert("属性补全含 class", labels.includes("class"), labels.slice(0, 10));
  // textEdit 范围应覆盖 word
  const cls = items.find((i) => (i as { label: string }).label === "class") as
    | { textEdit?: { range: { start: { line: number; character: number }; end: { line: number; character: number } } } }
    | undefined;
  assert("属性 textEdit 覆盖 word", cls?.textEdit?.range.start.character === 5 && cls.textEdit.range.end.character === 8, cls?.textEdit);
}

// 属性值补全（input type）
{
  const text = '<input type="te';
  const { labels } = completeHtml(htmlService, text, text.length);
  assert("属性值补全含 text", labels.includes("text"), labels.slice(0, 15));
}

// 结束标签（</ 场景）
{
  const text = "<div></di";
  const { labels } = completeHtml(htmlService, text, text.length);
  assert("结束标签补全含 div", labels.some((l) => l.includes("div")), labels.slice(0, 10));
}

// 实体补全
{
  const text = "<p>&am";
  const { labels } = completeHtml(htmlService, text, text.length);
  assert("实体补全含 amp", labels.some((l) => l.includes("amp")), labels.slice(0, 10));
}

// ==================== HTML + Vue data ====================
console.log("== HTML service + Vue data ==");
const vueService = getLanguageService();
vueService.setDataProviders(true, [newHTMLDataProvider("prism-vue", buildVueHtmlData())]);

{
  const text = '<div v-';
  const { labels } = completeHtml(vueService, text, text.length);
  assert("Vue 指令补全含 v-if", labels.includes("v-if"), labels.slice(0, 20));
  assert("Vue 指令补全含 v-for", labels.includes("v-for"), labels.slice(0, 20));
  assert("Vue 指令补全含 v-model", labels.includes("v-model"), labels.slice(0, 20));
}

{
  const text = "<template><transi";
  const { labels } = completeHtml(vueService, text, text.length);
  assert("Vue 元素补全含 transition", labels.some((l) => l.startsWith("transition")), labels.slice(0, 10));
}

// 普通 html 不注入 Vue data
{
  const text = "<div v-";
  const { labels } = completeHtml(htmlService, text, text.length);
  assert("普通 html 无 v-if", !labels.includes("v-if"), labels.slice(0, 10));
}

// ==================== CSS ====================
console.log("== CSS service ==");
const cssService = getCSSLanguageService();

function completeCss(text: string, offset: number): { labels: string[]; items: unknown[] } {
  const document = TextDocument.create("file:///t.css", "css", 1, text);
  const stylesheet = cssService.parseStylesheet(document);
  const list = cssService.doComplete(document, pos(text, offset), stylesheet);
  return { labels: list.items.map((i) => i.label), items: list.items };
}

// 属性补全
{
  const text = ".a {\n  disp";
  const { labels } = completeCss(text, text.length);
  assert("CSS 属性补全含 display", labels.includes("display"), labels.slice(0, 15));
}

// 属性值补全
{
  const text = ".a {\n  display: fle";
  const { labels } = completeCss(text, text.length);
  assert("CSS 值补全含 flex", labels.includes("flex"), labels.slice(0, 20));
}

// 伪类补全
{
  const text = ".a:hov";
  const { labels } = completeCss(text, text.length);
  assert("CSS 伪类补全含 :hover", labels.includes(":hover"), labels.slice(0, 20));
}

// snippet 占位符剥离
{
  const stripped = (await import("../src/features/editor/completion/adapters.ts")).stripSnippetPlaceholders(
    'class="$1"',
  );
  assert("snippet $1 剥离", stripped === 'class=""', stripped);
  const stripped2 = (await import("../src/features/editor/completion/adapters.ts")).stripSnippetPlaceholders(
    "<div>${1:content}</div>",
  );
  assert("snippet ${1:default} 取默认值", stripped2 === "<div>content</div>", stripped2);
}

// ==================== 适配层（真实 service 输出） ====================
console.log("== 适配层 ==");

{
  const text = '<div cla';
  const document = TextDocument.create("file:///t.html", "html", 1, text);
  const htmlDoc = htmlService.parseHTMLDocument(document);
  const list = htmlService.doComplete(document, pos(text, text.length), htmlDoc);
  const cm = toCmCompletions(list.items);
  const cls = cm.find((c) => c.label === "class");
  assert("适配后 class 项存在", Boolean(cls));
  assert("适配后 apply 为函数（占位定位）", typeof cls?.apply === "function");
  assert("适配后类型映射有效（kind 12 → constant）", cls?.type === lspKindToCmType(12));
  assert("适配后无 undefined label", cm.every((c) => typeof c.label === "string" && c.label.length > 0));
}

// ==================== 汇总 ====================
console.log(`\n通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exit(1);
