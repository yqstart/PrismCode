// ==================== Monaco 编辑器回归自测 ====================
// 挂载真实 MonacoEditor.vue，验证渲染、内容同步契约、标签切换状态保留、
// 外部更新后的光标定位与 scrollTo 落点。
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";
import { setTimeout as delay } from "node:timers/promises";
import type * as MonacoApi from "monaco-editor/editor";

declare global {
  interface Window {
    monaco: typeof MonacoApi;
    setPath: (path: string) => void;
    setContent: (content: string) => void;
    markExternal: (path: string) => void;
    closeTabB: () => void;
    tabContent: (index: number) => string;
    activeEditor: () => MonacoApi.editor.ICodeEditor;
    editorApi: () => { scrollTo: (line: number, column: number) => void };
    contentWrites: Array<{ path: string; content: string }>;
    cursorWrites: Array<{ path: string; line: number; column: number }>;
  }
}

const root = process.cwd();
const fixture = await mkdtemp(join(root, ".monaco-editor-"));
const server = await createServer({
  server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
  logLevel: "error",
});
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;

try {
  const contentA = Array.from({ length: 300 }, (_, i) => `line${i} alpha beta gamma`).join("\n");
  const contentB = "second file\nline two\nline three";

  await writeFile(
    join(fixture, "index.html"),
    `<!doctype html>
    <html><body>
    <div id="editor"></div>
    <style>
      html, body { margin: 0; height: 100%; }
      #editor { height: 420px; width: 760px; }
    </style>
    <script type="module">
      import { createApp, h, ref } from 'vue';
      import { createPinia } from 'pinia';
      import MonacoEditor from '/src/features/editor/MonacoEditor.vue';
      import { monaco } from '/src/features/editor/monaco/setup.ts';
      import { useEditorStore } from '/src/stores/editor.ts';

      const contentA = ${JSON.stringify(contentA)};
      const contentB = ${JSON.stringify(contentB)};
      const path = ref('/tmp/monaco-check-a.txt');
      const content = ref(contentA);
      let componentApi = null;

      const app = createApp({
        render: () =>
          h(MonacoEditor, {
            ref: (instance) => { componentApi = instance; },
            path: path.value,
            content: content.value,
          }),
      });
      app.use(createPinia());
      app.mount('#editor');

      const store = useEditorStore();
      // 真实场景里编辑器只渲染已打开的标签；自检先造出两个标签，
      // 否则 pruneModels 会把非标签 model 全部回收。
      const makeTab = (id, tabPath, tabContent) => ({
        id,
        path: tabPath,
        name: tabPath.split('/').pop(),
        content: tabContent,
        original: tabContent,
        language: 'Plain Text',
        cursor: { line: 1, column: 1 },
        previewNonce: 0,
        pinned: false,
        dirty: false,
      });
      store.tabs.push(
        makeTab('tab-a', '/tmp/monaco-check-a.txt', contentA),
        makeTab('tab-b', '/tmp/monaco-check-b.txt', contentB),
      );

      window.contentWrites = [];
      window.cursorWrites = [];
      const setContent = store.setContent;
      const setCursor = store.setCursor;
      store.setContent = (nextPath, nextContent) => {
        window.contentWrites.push({ path: nextPath, content: nextContent });
        setContent(nextPath, nextContent);
      };
      store.setCursor = (nextPath, line, column) => {
        window.cursorWrites.push({ path: nextPath, line, column });
        setCursor(nextPath, line, column);
      };

      window.monaco = monaco;
      window.setPath = (next) => { path.value = next; };
      window.setContent = (next) => { content.value = next; };
      window.markExternal = (target) => { store.markExternalUpdate(target); };
      window.closeTabB = () => { store.tabs.splice(1, 1); };
      window.tabContent = (index) => store.tabs[index].content;
      window.activeEditor = () => monaco.editor.getEditors()[0];
      window.editorApi = () => componentApi;
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
  await page.waitForSelector(".monaco-editor .view-lines", { timeout: 30000 });

  // 1. 渲染
  const rendered = await page.evaluate(() => ({
    lineNumbers: document.querySelectorAll(".monaco-editor .line-numbers").length,
    lines: document.querySelectorAll(".monaco-editor .view-line").length,
    firstLine: (document.querySelector(".monaco-editor .view-line")?.textContent ?? "").replace(/\u00a0/g, " "),
  }));
  assert.ok(rendered.lineNumbers > 10, `行号应渲染，实际 ${rendered.lineNumbers}`);
  assert.ok(rendered.lines > 10, `文本行应渲染，实际 ${rendered.lines}`);
  assert.match(rendered.firstLine, /line0 alpha beta gamma/, "首行内容必须可见");

  // 2. 编辑 → setContent 契约
  await page.evaluate(() => {
    const editor = window.activeEditor();
    editor.setPosition({ lineNumber: 1, column: 1 });
    editor.trigger("selfcheck", "type", { text: "X" });
  });
  await delay(200);
  const writes = await page.evaluate(() => window.contentWrites);
  assert.ok(writes.length > 0, "编辑必须写回 store.setContent");
  assert.equal(writes.at(-1)!.path, "/tmp/monaco-check-a.txt");
  assert.match(writes.at(-1)!.content, /^Xline0/, `写回内容应以 X 开头，实际 "${writes.at(-1)!.content.slice(0, 12)}"`);

  // 3. 光标写回
  const cursorWrites = await page.evaluate(() => window.cursorWrites);
  assert.ok(cursorWrites.length > 0, "光标变化必须写回 store.setCursor");
  assert.equal(cursorWrites.at(-1)!.line, 1, "光标应停在第 1 行");

  // 4. 切标签：B 内容生效，切回 A 保留编辑内容，再切 B 保留光标
  await page.evaluate(() => window.setContent(window.tabContent(1)));
  await page.evaluate(() => window.setPath("/tmp/monaco-check-b.txt"));
  await delay(300);
  const onB = await page.evaluate(() => ({
    first: (document.querySelector(".monaco-editor .view-line")?.textContent ?? "").replace(/\u00a0/g, " "),
    modelCount: window.monaco.editor.getModels().length,
  }));
  assert.match(onB.first, /^second file/, `切到 B 应显示 B 内容，实际 "${onB.first}"`);
  assert.equal(onB.modelCount, 2, "两个文件应各持一个 model");

  await page.evaluate(() => {
    window.activeEditor().setPosition({ lineNumber: 3, column: 5 });
  });
  await delay(120);
  await page.evaluate(() => window.setContent(window.tabContent(0)));
  await page.evaluate(() => window.setPath("/tmp/monaco-check-a.txt"));
  await delay(300);
  const backToA = await page.evaluate(
    () => (document.querySelector(".monaco-editor .view-line")?.textContent ?? "").replace(/\u00a0/g, " "),
  );
  assert.match(backToA, /^Xline0/, `切回 A 应恢复编辑内容，实际 "${backToA}"`);

  await page.evaluate(() => window.setContent(window.tabContent(1)));
  await page.evaluate(() => window.setPath("/tmp/monaco-check-b.txt"));
  await delay(300);
  const posB = await page.evaluate(() => {
    const position = window.activeEditor().getPosition()!;
    return { line: position.lineNumber, column: position.column };
  });
  assert.deepEqual(posB, { line: 3, column: 5 }, "切回 B 应恢复光标位置");

  // 5. 外部更新：内容替换 + 光标按行列保持
  await page.evaluate(() => window.setContent(window.tabContent(0)));
  await page.evaluate(() => window.setPath("/tmp/monaco-check-a.txt"));
  await delay(250);
  await page.evaluate(() => {
    window.activeEditor().setPosition({ lineNumber: 40, column: 3 });
    window.markExternal("/tmp/monaco-check-a.txt");
    window.setContent(`PREFIX\n${window.tabContent(0)}`);
  });
  await delay(350);
  const external = await page.evaluate(() => {
    const position = window.activeEditor().getPosition()!;
    return {
      firstLine: window.monaco.editor.getModels()[0]!.getLineContent(1),
      line: position.lineNumber,
      column: position.column,
    };
  });
  assert.equal(external.firstLine, "PREFIX", "外部更新后首行应为新内容");
  assert.deepEqual(
    { line: external.line, column: external.column },
    { line: 40, column: 3 },
    "外部更新后光标应保持行列",
  );

  // 6. scrollTo：行列落点
  const scrolled = await page.evaluate(async () => {
    window.editorApi().scrollTo(220, 4);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const position = window.activeEditor().getPosition()!;
    return { line: position.lineNumber, column: position.column };
  });
  assert.deepEqual(scrolled, { line: 220, column: 4 }, "scrollTo 应定位到指定行列");

  // 7. 模型回收：关闭标签后 model 释放
  const disposed = await page.evaluate(async () => {
    window.closeTabB();
    window.setPath("/tmp/monaco-check-b.txt");
    await new Promise((resolve) => setTimeout(resolve, 150));
    window.setPath("/tmp/monaco-check-a.txt");
    await new Promise((resolve) => setTimeout(resolve, 400));
    return window.monaco.editor.getModels().map((model) => model.uri.path);
  });
  assert.deepEqual(disposed, ["/tmp/monaco-check-a.txt"], "未打开标签的 model 必须回收");

  const ignoredErrors = pageErrors.filter(
    (message) => !message.includes("__TAURI") && !message.includes("invoke"),
  );
  assert.deepEqual(ignoredErrors, [], `页面不应有未捕获错误：${ignoredErrors.join(" | ")}`);

  console.log("✅ Monaco 编辑器自检通过");
} finally {
  await browser?.close();
  await server.close();
  await rm(fixture, { recursive: true, force: true });
}
