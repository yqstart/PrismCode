// ==================== 编辑器选项自检 ====================
// 设置项 → Monaco option 的映射：默认值、切换后生效、以及函数式相对行号。
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";
import type * as MonacoApi from "monaco-editor/editor";

declare global {
  interface Window {
    monaco: typeof MonacoApi;
    patchEditor: (patch: Record<string, unknown>) => void;
    largeFileProbe: () => Record<string, unknown>;
    readOptions: () => {
      sticky: boolean;
      minimap: boolean;
      rulers: number[];
      wordWrap: string;
      fontSize: number;
      lineNumbersIsFunction: boolean;
      tabSize: number;
      storeTabSize: number;
    };
  }
}

const root = process.cwd();
const fixture = await mkdtemp(join(root, ".monaco-options-"));
const server = await createServer({
  server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
  logLevel: "error",
});
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;

try {
  await writeFile(
    join(fixture, "index.html"),
    `<!doctype html>
    <html><body><div id="editor" style="height:400px;width:700px"></div>
    <script type="module">
      import { createApp, h } from 'vue';
      import { createPinia } from 'pinia';
      import MonacoEditor from '/src/features/editor/MonacoEditor.vue';
      import { monaco } from '/src/features/editor/monaco/setup.ts';
      import { useSettingsStore } from '/src/stores/settings.ts';
      import { languageForContent, largeFileOptions, LARGE_FILE_CHARS, HUGE_FILE_CHARS } from '/src/features/editor/monaco/largeFile.ts';

      createApp({
        render: () => h(MonacoEditor, {
          path: '/tmp/options-check.ts',
          content: 'export const a = 1;\\n'.repeat(40),
        }),
      }).use(createPinia()).mount('#editor');

      const store = useSettingsStore();
      window.monaco = monaco;
      window.patchEditor = (patch) => { store.patchEditor(patch); };
      window.largeFileProbe = () => ({
        small: largeFileOptions('a'.repeat(1000)),
        large: largeFileOptions('a'.repeat(LARGE_FILE_CHARS + 1)),
        huge: largeFileOptions('a'.repeat(HUGE_FILE_CHARS + 1)),
        hugeLang: languageForContent('/tmp/x.ts', 'a'.repeat(HUGE_FILE_CHARS + 1)),
        largeLang: languageForContent('/tmp/x.ts', 'a'.repeat(LARGE_FILE_CHARS + 1)),
      });
      window.readOptions = () => {
        const editor = monaco.editor.getEditors()[0];
        const model = editor.getModel();
        return {
          sticky: editor.getOption(monaco.editor.EditorOption.stickyScroll).enabled,
          minimap: editor.getOption(monaco.editor.EditorOption.minimap).enabled,
          rulers: editor
            .getOption(monaco.editor.EditorOption.rulers)
            .map((ruler) => ruler.column),
          wordWrap: editor.getOption(monaco.editor.EditorOption.wordWrap),
          fontSize: editor.getOption(monaco.editor.EditorOption.fontSize),
          // Monaco 把 lineNumbers 规范化成 { renderType, renderFn }；
          // 相对行号表现为 renderFn 变成函数。
          lineNumbersIsFunction: (() => {
            const value = editor.getOption(monaco.editor.EditorOption.lineNumbers);
            return typeof value === 'function' || typeof value?.renderFn === 'function';
          })(),
          tabSize: model ? model.getOptions().tabSize : 0,
          storeTabSize: store.editor.tabSize,
        };
      };
    </script></body></html>`,
  );
  await server.listen();

  browser = await puppeteer.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => localStorage.clear());
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${server.resolvedUrls!.local[0]}${basename(fixture)}/index.html`);
  await page.waitForSelector(".monaco-editor .view-lines", { timeout: 30000 });

  const before = await page.evaluate(() => window.readOptions());
  assert.equal(before.sticky, true, "粘性滚动默认开启");
  assert.equal(before.minimap, false, "小地图默认关闭");
  assert.deepEqual(before.rulers, [100], "默认标尺 100");
  assert.equal(before.wordWrap, "on", "默认自动换行开启");
  assert.equal(before.lineNumbersIsFunction, false, "默认行号不是函数式");
  assert.equal(before.tabSize, 2, "默认缩进 2");

  const after = await page.evaluate(async () => {
    window.patchEditor({
      stickyScroll: false,
      minimap: true,
      rulers: [80, 120],
      wordWrap: false,
      fontSize: 16,
      relativeLineNumbers: true,
      tabSize: 4,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    return window.readOptions();
  });
  assert.equal(after.sticky, false, "关闭粘性滚动必须生效");
  assert.equal(after.minimap, true, "开启小地图必须生效");
  assert.deepEqual(after.rulers, [80, 120], "标尺必须跟随设置");
  assert.equal(after.wordWrap, "off", "关闭自动换行必须生效");
  assert.equal(after.fontSize, 16, "字号必须跟随设置");
  assert.equal(after.lineNumbersIsFunction, true, "相对行号应切换为函数式行号");
  assert.equal(after.tabSize, 4, "缩进必须同步到 model 选项");

  // 大文件分级：2MB 起关语法装饰，5MB 起降级纯文本
  const largeFile = await page.evaluate(() => window.largeFileProbe());
  assert.deepEqual(largeFile.small, {}, "小文件不应产生选项覆盖");
  assert.equal(
    (largeFile.large as { bracketPairColorization?: { enabled: boolean } }).bracketPairColorization
      ?.enabled,
    false,
    "2MB 以上应关闭括号着色",
  );
  assert.equal(
    (largeFile.large as { folding?: boolean }).folding,
    undefined,
    "2MB 档不应关闭折叠",
  );
  assert.equal(
    (largeFile.huge as { folding?: boolean }).folding,
    false,
    "5MB 以上应关闭折叠",
  );
  assert.equal(largeFile.hugeLang, "plaintext", "5MB 以上应降级纯文本语言");
  assert.equal(largeFile.largeLang, "typescript", "2MB 档仍保留语言服务");

  const ignoredErrors = pageErrors.filter((message) => !message.includes("__TAURI"));
  assert.deepEqual(ignoredErrors, [], `页面不应有未捕获错误：${ignoredErrors.join(" | ")}`);

  console.log("✅ 编辑器选项自检通过");
} finally {
  await browser?.close();
  await server.close();
  await rm(fixture, { recursive: true, force: true });
}
