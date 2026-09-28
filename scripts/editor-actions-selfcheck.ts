// ==================== 编辑器命令与键位自检 ====================
// 1) 键位表里的每个 Monaco action id 必须真实存在（写错 id 的键位会静默失效）
// 2) 真实按键触发：⌘/ 注释、⌘D 在 WebStorm / VS Code 预设下行为相反
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
    missingActions: () => string[];
    lineCount: () => number;
    lineText: (line: number) => string;
    selectionCount: () => number;
    clearDoc: () => void;
  }
}

const root = process.cwd();
const fixture = await mkdtemp(join(root, ".monaco-actions-"));
const server = await createServer({
  server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
  logLevel: "error",
});
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;

try {
  await writeFile(
    join(fixture, "index.html"),
    `<!doctype html>
    <html><body><div id="editor" style="height:420px;width:760px"></div>
    <script type="module">
      import { createApp, h } from 'vue';
      import { createPinia } from 'pinia';
      import MonacoEditor from '/src/features/editor/MonacoEditor.vue';
      import { monaco } from '/src/features/editor/monaco/setup.ts';
      import { useSettingsStore } from '/src/stores/settings.ts';
      import { KEYMAP_BINDINGS } from '/src/features/editor/monaco/actions.ts';

      const initial = [
        'const alpha = 1;',
        'const beta = 2;',
        'const gamma = alpha + beta;',
        '',
        'function pick() {',
        '  return alpha;',
        '}',
        '',
      ].join('\\n');

      createApp({
        render: () => h(MonacoEditor, { path: '/tmp/actions-check.ts', content: initial }),
      }).use(createPinia()).mount('#editor');

      const store = useSettingsStore();
      window.monaco = monaco;
      window.patchEditor = (patch) => { store.patchEditor(patch); };
      window.missingActions = () => {
        const editor = monaco.editor.getEditors()[0];
        return KEYMAP_BINDINGS
          .filter((binding) => !editor.getAction(binding.id))
          .map((binding) => binding.id);
      };
      const model = () => monaco.editor.getEditors()[0].getModel();
      window.lineCount = () => model().getLineCount();
      window.lineText = (line) => model().getLineContent(line);
      window.selectionCount = () => {
        const selections = monaco.editor.getEditors()[0].getSelections();
        return selections ? selections.length : 0;
      };
      window.clearDoc = () => {
        const editor = monaco.editor.getEditors()[0];
        const target = model();
        const lines = [];
        for (let line = 1; line <= target.getLineCount(); line += 1) {
          lines.push(target.getLineContent(line).replace(/^\\/\\/ ?/, ''));
        }
        target.setValue(lines.join('\\n'));
        editor.setPosition({ lineNumber: 1, column: 1 });
        editor.focus();
      };
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

  // 用 registerAction2 注册的 action 不出现在 getSupportedActions() 里，
  // 这些 id 已逐个在 monaco-editor 0.57 源码中核对（goToCommands.js /
  // codeAction.js / standaloneReferenceSearch.js）。
  const PLATFORM_ACTION_IDS = new Set([
    "editor.action.revealDefinition",
    "editor.action.goToTypeDefinition",
    "editor.action.goToImplementation",
    "editor.action.goToLocations",
    "editor.action.referenceSearch.trigger",
    "editor.action.quickFix",
  ]);
  const missing = await page.evaluate(() => window.missingActions());
  const unknown = missing.filter((id) => !PLATFORM_ACTION_IDS.has(id));
  assert.deepEqual(unknown, [], `键位表里存在无效的 action id：${unknown.join(", ")}`);
  const staleWhitelist = [...PLATFORM_ACTION_IDS].filter((id) => !missing.includes(id));
  assert.deepEqual(
    staleWhitelist,
    [],
    `白名单里的 id 已能被 getSupportedActions 找到，应移出白名单：${staleWhitelist.join(", ")}`,
  );

  const press = async (combo: string) => {
    await page.evaluate(() => {
      window.monaco.editor.getEditors()[0].focus();
    });
    const parts = combo.split("+");
    const key = parts.pop()!;
    for (const modifier of parts) await page.keyboard.down(modifier);
    await page.keyboard.press(key);
    for (const modifier of parts.reverse()) await page.keyboard.up(modifier);
    await new Promise((resolve) => setTimeout(resolve, 250));
  };

  // WebStorm：⌘/ 行注释
  await page.evaluate(() => window.clearDoc());
  await press("Meta+Slash");
  const commented = await page.evaluate(() => window.lineText(1));
  assert.match(commented, /^\/\//, `⌘/ 应注释当前行，实际 "${commented}"`);

  // WebStorm：⌘D 复制行（该预设下应为 copyLinesDownAction）
  const before = await page.evaluate(() => ({
    lines: window.lineCount(),
    first: window.lineText(1),
  }));
  await press("Meta+KeyD");
  const after = await page.evaluate(() => ({
    lines: window.lineCount(),
    first: window.lineText(1),
    second: window.lineText(2),
  }));
  assert.equal(after.lines, before.lines + 1, "WebStorm 预设下 ⌘D 应复制当前行");
  assert.equal(after.second, before.first, "复制出来的行内容应与原行一致");

  // 切到 VS Code 预设：⌘D 应变为「选择下一个匹配」（不改变行数）
  await page.evaluate(() => {
    window.patchEditor({ keymap: "vscode" });
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await page.evaluate(() => window.clearDoc());
  const vsBefore = await page.evaluate(() => window.lineCount());
  // 第一次 ⌘D 选中当前词，第二次才把下一个匹配加入多光标
  await press("Meta+KeyD");
  await press("Meta+KeyD");
  const vsAfter = await page.evaluate(() => ({
    lines: window.lineCount(),
    selections: window.selectionCount(),
  }));
  assert.equal(vsAfter.lines, vsBefore, "VS Code 预设下 ⌘D 不应复制行");
  assert.ok(vsAfter.selections >= 2, `VS Code 预设下 ⌘D 应产生多光标，实际 ${vsAfter.selections}`);

  const ignoredErrors = pageErrors.filter((message) => !message.includes("__TAURI"));
  assert.deepEqual(ignoredErrors, [], `页面不应有未捕获错误：${ignoredErrors.join(" | ")}`);

  console.log("✅ 编辑器命令与键位自检通过");
} finally {
  await browser?.close();
  await server.close();
  await rm(fixture, { recursive: true, force: true });
}
