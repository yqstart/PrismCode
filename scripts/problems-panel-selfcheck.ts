// ==================== 问题面板自测 ====================
// marker → 面板列表 → 点击跳转（requestOpenAt）的完整链路。
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";
import type * as MonacoApi from "monaco-editor/editor";

declare global {
  interface Window {
    monaco: typeof MonacoApi;
    addMarkers: () => void;
    rowTexts: () => string[];
    openRequests: () => Array<{ path: string; line: number; column: number }>;
    ready: boolean;
  }
}

const root = process.cwd();
const fixture = await mkdtemp(join(root, ".problems-"));
const server = await createServer({
  server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
  logLevel: "error",
});
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;

try {
  await writeFile(
    join(fixture, "index.html"),
    `<!doctype html><html><body>
    <div id="panel" style="height:320px;width:640px"></div>
    <script type="module">
      import { createApp, h } from 'vue';
      import { createPinia } from 'pinia';
      import ProblemsPanel from '/src/features/problems/ProblemsPanel.vue';
      import { monaco } from '/src/features/editor/monaco/setup.ts';
      import { useEditorStore } from '/src/stores/editor.ts';

      createApp({ render: () => h(ProblemsPanel) }).use(createPinia()).mount('#panel');

      const store = useEditorStore();
      window.__requests = [];
      const original = store.requestOpenAt;
      store.requestOpenAt = (path, line, column) => {
        window.__requests.push({ path, line, column });
        original(path, line, column);
      };

      window.monaco = monaco;
      window.addMarkers = () => {
        const uri = monaco.Uri.file('/tmp/prism-problems.ts');
        const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel('const a = 1;\\n', 'typescript', uri);
        monaco.editor.setModelMarkers(model, 'selfcheck', [
          { severity: 8, message: '类型不兼容', startLineNumber: 4, startColumn: 3, endLineNumber: 4, endColumn: 8, source: 'ts' },
          { severity: 4, message: '未使用的变量', startLineNumber: 9, startColumn: 1, endLineNumber: 9, endColumn: 2, source: 'eslint' },
        ]);
      };
      window.rowTexts = () =>
        Array.from(document.querySelectorAll('.problems .row')).map((row) => row.textContent ?? '');
      window.openRequests = () => window.__requests;
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
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true, {
    timeout: 30000,
  });

  await page.evaluate(() => window.addMarkers());
  await new Promise((resolve) => setTimeout(resolve, 400));

  const rows = await page.evaluate(() => window.rowTexts());
  assert.equal(rows.length, 2, `两条 marker 应渲染两行，实际 ${rows.length}`);
  assert.ok(rows[0]!.includes("4:3"), `错误行应显示位置，实际 ${rows[0]}`);
  assert.ok(rows[0]!.includes("类型不兼容"), "应显示错误消息");
  assert.ok(rows[0]!.includes("ts"), "应显示来源");
  assert.ok(rows[1]!.includes("未使用的变量"), "应显示警告消息");

  // 筛选：只看错误（按顺序：全部 / 错误 / 警告，不依赖文案）
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll(".problems .filter"));
    (buttons[1] as HTMLButtonElement | undefined)?.click();
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const filtered = await page.evaluate(() => window.rowTexts());
  assert.equal(filtered.length, 1, "筛选错误后应只剩 1 行");
  assert.ok(filtered[0]!.includes("类型不兼容"), "保留的应是错误项");

  // 点击跳转
  await page.evaluate(() => {
    (document.querySelector(".problems .row") as HTMLButtonElement | null)?.click();
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const requests = await page.evaluate(() => window.openRequests());
  assert.equal(requests.length, 1, "点击应触发一次跳转请求");
  assert.deepEqual(
    { line: requests[0]!.line, column: requests[0]!.column },
    { line: 4, column: 3 },
    "跳转目标应为该问题的行列",
  );
  assert.ok(requests[0]!.path.endsWith("prism-problems.ts"), "跳转路径应为问题所在文件");

  const ignoredErrors = pageErrors.filter((message) => !message.includes("__TAURI"));
  assert.deepEqual(ignoredErrors, [], `页面不应有未捕获错误：${ignoredErrors.join(" | ")}`);

  console.log("✅ 问题面板自测通过");
} finally {
  await browser?.close();
  await server.close();
  await rm(fixture, { recursive: true, force: true });
}
