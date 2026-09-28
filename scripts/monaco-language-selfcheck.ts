// ==================== Monaco 语言层自检 ====================
// 1) tsconfig → worker compilerOptions 的纯函数映射
// 2) 真实 TS worker 诊断：语法/语义错误落到 model marker
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";
import type * as MonacoApi from "monaco-editor/editor";

type MonacoEditor = MonacoApi.editor.IStandaloneCodeEditor;
import type { compilerOptionsFromTsconfig } from "../src/features/editor/monaco/tsProvider.ts";

declare global {
  interface Window {
    monaco: typeof MonacoApi;
    compilerOptionsFromTsconfig: typeof compilerOptionsFromTsconfig;
    configureTypeScript: (root: string | null) => Promise<void>;
    registerFormatProviders: (options: {
      root: () => string | null;
      enabled: () => boolean;
      onError: (message: string) => void;
    }) => void;
    formatError: string;
    registerHtmlCssProviders: () => void;
    registerEmmetProvider: () => void;
    registerVueLanguage: () => void;
    registerJsonEnvProviders: () => void;
    installVueScriptDiagnostics: () => void;
    registerVueScriptCompletions: () => void;
    symbolChainAt: (
      model: MonacoApi.editor.ITextModel,
      position: { lineNumber: number; column: number },
    ) => Promise<Array<{ name: string; offset: number }>>;
    eslintMarkersFromMessages: (messages: Array<{
      line: number;
      column: number;
      end_line: number;
      end_column: number;
      severity: number;
      message: string;
      rule_id: string | null;
    }>) => Array<{ severity: number; message: string; startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }>;
    languageIdForPath: (path: string) => string;
    ready: boolean;
  }
}

const root = process.cwd();
const fixture = await mkdtemp(join(root, ".monaco-lang-"));
const server = await createServer({
  server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
  logLevel: "error",
});
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;

try {
  await writeFile(
    join(fixture, "index.html"),
    `<!doctype html>
    <html><body><div id="host" style="height:300px;width:600px"></div>
    <script type="module">
      import { monaco } from '/src/features/editor/monaco/setup.ts';
      import { compilerOptionsFromTsconfig, configureTypeScript } from '/src/features/editor/monaco/tsProvider.ts';
      import { languageIdForPath } from '/src/features/editor/monaco/langSetup.ts';
      import { registerFormatProviders } from '/src/features/editor/monaco/formatProvider.ts';
      import { registerHtmlCssProviders } from '/src/features/editor/monaco/htmlCssProvider.ts';
      import { registerEmmetProvider } from '/src/features/editor/monaco/emmetProvider.ts';
      import { registerVueLanguage } from '/src/features/editor/monaco/vueProvider.ts';
      import { registerJsonEnvProviders } from '/src/features/editor/monaco/jsonEnvProvider.ts';
      import { installVueScriptDiagnostics, registerVueScriptCompletions } from '/src/features/editor/monaco/vueScriptService.ts';
      import { eslintMarkersFromMessages } from '/src/features/editor/monaco/eslint.ts';
      import { symbolChainAt } from '/src/features/editor/monaco/breadcrumbs.ts';

      window.monaco = monaco;
      window.compilerOptionsFromTsconfig = compilerOptionsFromTsconfig;
      window.configureTypeScript = configureTypeScript;
      window.languageIdForPath = languageIdForPath;
      window.registerFormatProviders = registerFormatProviders;
      window.registerHtmlCssProviders = registerHtmlCssProviders;
      window.registerEmmetProvider = registerEmmetProvider;
      window.registerVueLanguage = registerVueLanguage;
      window.registerJsonEnvProviders = registerJsonEnvProviders;
      window.installVueScriptDiagnostics = installVueScriptDiagnostics;
      window.registerVueScriptCompletions = registerVueScriptCompletions;
      window.eslintMarkersFromMessages = eslintMarkersFromMessages;
      window.symbolChainAt = symbolChainAt;
      window.ready = true;
    </script></body></html>`,
  );
  await server.listen();

  browser = await puppeteer.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${server.resolvedUrls!.local[0]}${basename(fixture)}/index.html`);
  await page.waitForFunction(() => window.ready === true, { timeout: 30000 });

  // 1. 语言 id 映射
  const languageIds = await page.evaluate(() =>
    [
      "/a/b/app.ts",
      "/a/b/app.tsx",
      "/a/b/app.vue",
      "/a/b/index.html",
      "/a/b/style.scss",
      "/a/b/style.less",
      "/a/b/data.json",
      "/a/b/readme.md",
      "/a/b/ci.yml",
      "/a/b/icon.svg",
      "/a/b/.env.local",
      "/a/b/unknown.xyz",
    ].map((path) => window.languageIdForPath(path)),
  );
  assert.deepEqual(languageIds, [
    "typescript",
    "typescript",
    "vue",
    "html",
    "scss",
    "less",
    "json",
    "markdown",
    "yaml",
    "xml",
    "env",
    "plaintext",
  ]);

  // 2. tsconfig 映射
  const mapped = await page.evaluate(() => {
    const { compilerOptionsFromTsconfig: map } = window;
    const FullTsconfig = {
      compilerOptions: {
        target: "es2022",
        module: "nodenext",
        jsx: "react-jsx",
        strict: false,
        paths: { "@/*": ["src/*"] },
        baseUrl: ".",
        moduleResolution: "bundler",
        allowJs: true,
      },
    };
    const empty = map(null);
    const full = map(FullTsconfig);
    return {
      emptyStrict: empty.strict,
      emptyAllowJs: empty.allowJs,
      fullStrict: full.strict,
      fullAllowJs: full.allowJs,
      fullJsx: full.jsx,
      fullPaths: full.paths,
      moduleResolution: full.moduleResolution,
      targetClamped: full.target === map(null).target,
      moduleClamped: full.module === map(null).module,
    };
  });
  assert.equal(mapped.emptyStrict, true, "默认 strict 开启");
  assert.equal(mapped.emptyAllowJs, true, "默认 allowJs 开启");
  assert.equal(mapped.fullStrict, false, "tsconfig 的 strict=false 必须生效");
  assert.equal(mapped.fullAllowJs, true);
  assert.deepEqual(mapped.fullPaths, { "@/*": ["src/*"] }, "paths 必须透传");
  assert.equal(mapped.targetClamped, true, "es2022 收敛到 worker 支持的 ESNext");
  assert.equal(mapped.moduleClamped, true, "nodenext 收敛到 worker 支持的 ESNext");

  // 3. 真实 worker 诊断：类型错误必须产出 marker
  const markers = await page.evaluate(async () => {
    const { monaco } = window;
    await window.configureTypeScript(null);
    const uri = monaco.Uri.file("/tmp/prism-lang-check.ts");
    const model = monaco.editor.createModel(
      "const count: number = 'not a number';\n",
      "typescript",
      uri,
    );
    monaco.editor.create(document.getElementById("host"), { model, theme: "vs" });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const found = monaco.editor.getModelMarkers({ resource: uri });
      if (found.length > 0) {
        return found.map((marker) => ({
          severity: marker.severity,
          message: marker.message,
          line: marker.startLineNumber,
        }));
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return [];
  });
  assert.ok(markers.length > 0, "TS worker 必须对类型错误产出 marker");
  assert.equal(markers[0]!.line, 1, "marker 应落在第 1 行");
  assert.match(
    markers[0]!.message,
    /not assignable|不能将类型|string/i,
    `诊断信息应为类型不兼容，实际 "${markers[0]!.message}"`,
  );

  // 4. 格式化链路：provider → Monaco action → model 变更（内置 Prettier 引擎）
  const formatted = await page.evaluate(async () => {
    const { monaco } = window;
    window.registerFormatProviders({
      root: () => "/tmp",
      enabled: () => true,
      onError: (message) => {
        window.formatError = message;
      },
    });
    const uri = monaco.Uri.file("/tmp/prism-format-check.ts");
    const model = monaco.editor.createModel(
      "const  a  =  1\nfunction  b( ){return  2}\n",
      "typescript",
      uri,
    );
    const editor = monaco.editor.create(document.getElementById("host"), { model, theme: "vs" });
    const action = editor.getAction("editor.action.formatDocument");
    if (!action) return { text: "NO_ACTION", error: "" };
    await action.run();
    await new Promise((resolve) => setTimeout(resolve, 600));
    return { text: model.getValue(), error: window.formatError ?? "" };
  });
  assert.notEqual(formatted.text, "NO_ACTION", "Monaco 必须提供格式化 action");
  assert.ok(!formatted.error, `格式化不应报错，实际：${formatted.error}`);
  assert.match(
    formatted.text,
    /const a = 1;/,
    `格式化应规范空格与分号，实际：${JSON.stringify(formatted.text)}`,
  );

  // 5. HTML / CSS 补全：语言服务 → Monaco provider → suggest widget
  const suggests = await page.evaluate(async () => {
    const { monaco } = window;
    window.registerHtmlCssProviders();
    const read = async (editor: MonacoEditor, trigger: string) => {
      editor.trigger("selfcheck", trigger, {});
      await new Promise((resolve) => setTimeout(resolve, 700));
      const rows = Array.from(document.querySelectorAll(".suggest-widget .monaco-list-row"));
      return rows.map((row) => row.textContent ?? "");
    };
    const host = document.getElementById("host")!;

    const htmlUri = monaco.Uri.file("/tmp/prism-markup-check.html");
    const htmlModel = monaco.editor.createModel("<di", "html", htmlUri);
    const htmlEditor = monaco.editor.create(host, { model: htmlModel, theme: "vs" });
    htmlEditor.setPosition({ lineNumber: 1, column: 4 });
    const htmlRows = await read(htmlEditor, "editor.action.triggerSuggest");
    htmlEditor.dispose();
    htmlModel.dispose();

    window.registerEmmetProvider();
    const emmetUri = monaco.Uri.file("/tmp/prism-emmet-check.html");
    const emmetModel = monaco.editor.createModel("div.card", "html", emmetUri);
    const emmetEditor = monaco.editor.create(host, { model: emmetModel, theme: "vs" });
    emmetEditor.setPosition({ lineNumber: 1, column: 9 });
    const emmetRows = await read(emmetEditor, "editor.action.triggerSuggest");
    emmetEditor.trigger("selfcheck", "acceptSelectedSuggestion", {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    const emmetText = emmetModel.getValue();
    emmetEditor.dispose();
    emmetModel.dispose();

    // Vue：template 表达式内应出现 <script setup> 的顶层绑定
    const vueBindUri = monaco.Uri.file("/tmp/prism-vue-bind.vue");
    const vueBindSource = [
      "<script setup lang=\"ts\">",
      "const greeting = 'hi'",
      "function shout() {}",
      "</script>",
      "",
      "<template>",
      "  <div :title=\"gre\"></div>",
      "</template>",
      "",
    ].join("\n");
    const vueBindModel = monaco.editor.createModel(vueBindSource, "vue", vueBindUri);
    const vueBindEditor = monaco.editor.create(host, { model: vueBindModel, theme: "vs" });
    vueBindEditor.setPosition({ lineNumber: 7, column: 22 });
    const bindRows = await read(vueBindEditor, "editor.action.triggerSuggest");
    vueBindEditor.dispose();
    vueBindModel.dispose();

    const cssUri = monaco.Uri.file("/tmp/prism-style-check.css");
    const cssModel = monaco.editor.createModel(".a { dis\n", "css", cssUri);
    const cssEditor = monaco.editor.create(host, { model: cssModel, theme: "vs" });
    cssEditor.setPosition({ lineNumber: 1, column: 8 });
    const cssRows = await read(cssEditor, "editor.action.triggerSuggest");
    cssEditor.dispose();
    cssModel.dispose();

    return {
      htmlRows: htmlRows.slice(0, 40),
      cssRows: cssRows.slice(0, 40),
      emmetRows: emmetRows.slice(0, 10),
      emmetText,
      bindRows: bindRows.slice(0, 30),
    };
  });
  assert.ok(
    suggests.htmlRows.some((row) => /div/i.test(row)),
    `HTML 补全应包含 div，实际：${suggests.htmlRows.slice(0, 10).join(" | ")}`,
  );
  assert.ok(
    suggests.cssRows.some((row) => /display/i.test(row)),
    `CSS 补全应包含 display，实际：${suggests.cssRows.slice(0, 10).join(" | ")}`,
  );

  assert.ok(
    suggests.emmetRows.some((row) => /emmet/i.test(row)),
    `Emmet 缩写应给出展开建议，实际：${suggests.emmetRows.join(" | ")}`,
  );
  assert.ok(
    suggests.bindRows.some((row) => /greeting/.test(row)),
    `Vue template 应补出 script setup 绑定，实际：${suggests.bindRows.slice(0, 10).join(" | ")}`,
  );
  assert.match(
    suggests.emmetText,
    /class="card"/,
    `接受 Emmet 建议后应插入展开结果，实际：${JSON.stringify(suggests.emmetText)}`,
  );

  // 6. Vue SFC 高亮：三态 Monarch 必须给 template/script/style 出 token
  const vueTokens = await page.evaluate(() => {
    window.registerVueLanguage();
    const source = [
      "<template>",
      '  <div class="card">{{ title }}</div>',
      "</template>",
      "<script setup lang=\"ts\">",
      "const title = 'x'",
      "</script>",
      "<style scoped>",
      ".card { color: red; }",
      "</style>",
    ].join("\n");
    const lines = window.monaco.editor.tokenize(source, "vue");
    const types = lines.map((line) => line.map((token) => token.type).join(","));
    const model = window.monaco.editor.createModel(source, "vue", window.monaco.Uri.file("/tmp/x.vue"));
    const highlit = window.monaco.editor.tokenize(model.getValue(), "vue");
    model.dispose();
    return { lines: types, tokenCount: highlit.flat().length };
  });
  assert.ok(vueTokens.tokenCount > 10, "Vue 源码必须产出 token");
  assert.ok(
    vueTokens.lines[1]!.includes("tag") && vueTokens.lines[1]!.includes("attribute.name"),
    `template 行应有标签与属性 token，实际：${vueTokens.lines[1]}`,
  );
  assert.ok(
    /keyword|string/.test(vueTokens.lines[4]!),
    `script 行应有 JS token，实际：${vueTokens.lines[4]}`,
  );
  assert.ok(
    /attribute.name|type/.test(vueTokens.lines[7]!),
    `style 行应有 CSS token，实际：${vueTokens.lines[7]}`,
  );

  // 7. JSON / .env 诊断
  const diagnostics = await page.evaluate(async () => {
    const { monaco } = window;
    window.registerJsonEnvProviders();
    const jsonModel = monaco.editor.createModel(
      '{\n  "a": 1,\n  "b": ,\n}\n',
      "json",
      monaco.Uri.file("/tmp/prism-check.json"),
    );
    const envModel = monaco.editor.createModel(
      "API_URL=http://localhost\nAPI_URL=http://other\n",
      "env",
      monaco.Uri.file("/tmp/prism-check.env"),
    );
    await new Promise((resolve) => setTimeout(resolve, 900));
    const result = {
      json: monaco.editor.getModelMarkers({ resource: jsonModel.uri }).map((m) => m.message),
      env: monaco.editor.getModelMarkers({ resource: envModel.uri }).map((m) => m.message),
    };
    jsonModel.dispose();
    envModel.dispose();
    return result;
  });
  assert.ok(diagnostics.json.length > 0, "非法 JSON 必须产出诊断");
  assert.ok(diagnostics.env.length > 0, "重复 .env 键必须产出诊断");
  assert.match(diagnostics.env[0]!, /重复的环境变量 API_URL/, `实际：${diagnostics.env[0]}`);

  // 8. .vue script 段的 TS 诊断（等长虚拟文件 → 映射回 SFC）
  const vueDiagnostics = await page.evaluate(async () => {
    const { monaco } = window;
    window.registerVueLanguage();
    window.configureTypeScript(null);
    window.installVueScriptDiagnostics();
    const source = [
      "<template>",
      "  <div>{{ count }}</div>",
      "</template>",
      "",
      '<script setup lang="ts">',
      "const count: number = 'not a number'",
      "</script>",
      "",
    ].join("\n");
    const vueUri = monaco.Uri.file("/tmp/prism-vue-check.vue");
    const model = monaco.editor.createModel(source, "vue", vueUri);
    const deadline = Date.now() + 20000;
    let found: Array<{ line: number; message: string }> = [];
    while (Date.now() < deadline) {
      found = monaco.editor
        .getModelMarkers({ resource: vueUri, owner: "prism-vue-ts" })
        .map((marker) => ({ line: marker.startLineNumber, message: marker.message }));
      if (found.length) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const virtualExists = monaco.editor
      .getModels()
      .some((item) => item.uri.path.endsWith(".vue.ts"));
    model.dispose();
    return { found, virtualExists };
  });
  assert.ok(vueDiagnostics.virtualExists, "必须存在等长虚拟 TS 文件");
  assert.ok(vueDiagnostics.found.length > 0, ".vue script 的类型错误必须提升到 SFC model");
  assert.equal(vueDiagnostics.found[0]!.line, 6, "marker 应落在 script 内的第 6 行");

  // 9. .vue script 段的补全（TS worker → Monaco suggest）
  const vueSuggest = await page.evaluate(async () => {
    const { monaco } = window;
    window.registerVueScriptCompletions();
    const source = [
      '<script setup lang="ts">',
      "conso",
      "</script>",
      "",
    ].join("\n");
    const model = monaco.editor.createModel(source, "vue", monaco.Uri.file("/tmp/prism-vue-suggest.vue"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const editor = monaco.editor.create(document.getElementById("host")!, { model, theme: "vs" });
    editor.setPosition({ lineNumber: 2, column: 6 });
    editor.trigger("selfcheck", "editor.action.triggerSuggest", {});
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const rows = Array.from(document.querySelectorAll(".suggest-widget .monaco-list-row")).map(
      (row) => row.textContent ?? "",
    );
    editor.dispose();
    model.dispose();
    return rows.slice(0, 40);
  });
  assert.ok(
    vueSuggest.some((row) => /console/.test(row)),
    `.vue script 补全应包含 console，实际：${vueSuggest.slice(0, 10).join(" | ")}`,
  );

  // 10. ESLint 消息 → marker 映射（severity / 规则名 / 范围回退）
  const eslintMarkers = await page.evaluate(() =>
    window.eslintMarkersFromMessages([
      {
        line: 4,
        column: 3,
        end_line: 4,
        end_column: 9,
        severity: 2,
        message: "'foo' is not defined.",
        rule_id: "no-undef",
      },
      {
        line: 7,
        column: 1,
        end_line: 7,
        end_column: 1,
        severity: 1,
        message: "Unexpected console statement.",
        rule_id: null,
      },
    ]),
  );
  assert.equal(eslintMarkers.length, 2, "两条 ESLint 消息应产出两个 marker");
  assert.equal(eslintMarkers[0]!.severity, 8, "severity=2 应映射为 Error(8)");
  assert.equal(eslintMarkers[0]!.message, "'foo' is not defined. [no-undef]");
  assert.equal(eslintMarkers[1]!.severity, 4, "severity=1 应映射为 Warning(4)");
  assert.equal(eslintMarkers[1]!.endColumn, 2, "缺 endColumn 时应回退为 column+1");

  // 11. 面包屑符号链（TS worker 的 NavigationTree → 光标所在路径）
  const breadcrumbs = await page.evaluate(async () => {
    const { monaco } = window;
    await window.configureTypeScript(null);
    const source = [
      "export interface Shape { area(): number }",
      "export class Circle implements Shape {",
      "  radius = 1;",
      "  area() {",
      "    return this.radius * 3.14;",
      "  }",
      "}",
      "",
    ].join("\n");
    const model = monaco.editor.createModel(
      source,
      "typescript",
      monaco.Uri.file("/tmp/prism-breadcrumb.ts"),
    );
    const inside = await window.symbolChainAt(model, { lineNumber: 5, column: 12 });
    const topLevel = await window.symbolChainAt(model, { lineNumber: 1, column: 1 });
    const plain = await window.symbolChainAt(
      monaco.editor.createModel("plain text", "plaintext", monaco.Uri.file("/tmp/plain.txt")),
      { lineNumber: 1, column: 1 },
    );
    model.dispose();
    return { inside: inside.map((crumb) => crumb.name), topLevel, plain };
  });
  assert.ok(
    breadcrumbs.inside.includes("Circle") && breadcrumbs.inside.includes("area"),
    `类内方法处应给出 Circle › area，实际 ${JSON.stringify(breadcrumbs.inside)}`,
  );
  assert.deepEqual(breadcrumbs.plain, [], "纯文本不应有符号链");

  const ignoredErrors = pageErrors.filter((message) => !message.includes("__TAURI"));
  assert.deepEqual(ignoredErrors, [], `页面不应有未捕获错误：${ignoredErrors.join(" | ")}`);

  console.log("✅ Monaco 语言层自检通过");
} finally {
  await browser?.close();
  await server.close();
  await rm(fixture, { recursive: true, force: true });
}
