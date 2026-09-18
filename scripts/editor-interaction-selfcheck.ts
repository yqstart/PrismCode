// ==================== 编辑器鼠标交互回归自测 ====================
// 挂载真实组件；模拟 WKWebView 忽略 preventScroll，验证用户可见选区与滚动。
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";
import type { EditorView } from "@codemirror/view";
import { setTimeout as delay } from "node:timers/promises";

declare global {
  interface Window {
    checkView: EditorView;
  }
}

const root = process.cwd();
const fixture = await mkdtemp(join(root, ".editor-interaction-"));
const server = await createServer({
  server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
  logLevel: "error",
});
let browser;
try {
  await writeFile(
    join(fixture, "index.html"),
    `<!doctype html>
    <html><body><button id="outside">编辑区外</button><div id="editor"></div>
    <style>#editor { height: 400px; width: 700px; } .cm-editor { height: 100%; }</style>
    <script type="module">
      import { createApp, h } from 'vue';
      import { createPinia } from 'pinia';
      import { EditorView } from '@codemirror/view';
      import CodeMirrorEditor from '/src/features/editor/CodeMirrorEditor.vue';
      const content = Array.from({length: 300}, (_, i) => 'line' + i + ' alpha beta gamma').join('\\n');
      createApp({ render: () => h(CodeMirrorEditor, { path: '/mouse-check.txt', content }) })
        .use(createPinia()).mount('#editor');
      window.checkView = EditorView.findFromDOM(document.querySelector('.cm-content'));
    </script></body></html>`,
  );
  await server.listen();
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(
    `${server.resolvedUrls!.local[0]}${basename(fixture)}/index.html`,
  );
  await page.waitForFunction(() => !!window.checkView);
  const prepare = async (breakFocus: boolean) => {
    await page.evaluate((broken) => {
      const view = window.checkView;
      view.dispatch({ selection: { anchor: 0 } });
      document.querySelector<HTMLButtonElement>("#outside")!.focus();
      view.scrollDOM.scrollTop = 1600;
      const dom = view.contentDOM;
      dom.focus = function (options: FocusOptions) {
        HTMLElement.prototype.focus.call(this, options);
        // 模拟 Safari 26 / WKWebView 聚焦时滚回旧光标的回归。
        if (broken) view.scrollDOM.scrollTop = 0;
      };
    }, breakFocus);
    await delay(100);
    return page.evaluate(() => {
      const view = window.checkView;
      const rect = view.scrollDOM.getBoundingClientRect();
      const x = rect.left + 140,
        y = rect.top + 130;
      return {
        x,
        y,
        pos: view.posAtCoords({ x, y }),
        top: view.scrollDOM.scrollTop,
      };
    });
  };
  const state = () =>
    page.evaluate(() => {
      const view = window.checkView;
      const { anchor, head, empty } = view.state.selection.main;
      return {
        anchor,
        head,
        empty,
        top: view.scrollDOM.scrollTop,
        text: view.state.sliceDoc(
          view.state.selection.main.from,
          view.state.selection.main.to,
        ),
        ranges: view.state.selection.ranges.length,
      };
    });

  const target = await prepare(true);
  await page.mouse.click(target.x, target.y);
  await delay(50);
  const refocused = await state();
  assert.equal(refocused.top, target.top, "聚焦不可滚回旧光标区域");
  assert.equal(
    refocused.head,
    target.pos,
    "聚焦单击应落在点击前可见的文本位置",
  );
  assert.equal(refocused.empty, true, "聚焦单击不应产生跨区域选区");

  // 无需等待上一击的定时器，连续点击不同位置。
  for (let i = 0; i < 12; i++) {
    const x = target.x + (i % 3) * 30,
      y = target.y + (i % 4) * 20;
    const pos = await page.evaluate(
      ({ x, y }) => window.checkView.posAtCoords({ x, y }),
      { x, y },
    );
    await page.mouse.click(x, y);
    const clicked = await state();
    assert.equal(clicked.empty, true, "快速连续单击不应误选区域");
    assert.equal(clicked.head, pos, "快速连续单击不应跳到其他位置");
    assert.equal(clicked.top, target.top, "快速连续单击不应改变视口");
  }

  const word = await prepare(true);
  await page.mouse.click(word.x, word.y, { count: 2 });
  assert.match((await state()).text, /^\w+$/, "失焦后双击仍应选中单词");
  assert.equal((await state()).top, word.top, "双击聚焦也应保留视口");

  const line = await prepare(true);
  await page.mouse.click(line.x, line.y, { count: 3 });
  assert.match(
    (await state()).text,
    /^line\d+ alpha beta gamma\n$/,
    "三击仍应选中整行",
  );
  assert.equal((await state()).top, line.top, "三击不应跳转视口");

  const drag = await prepare(true);
  await page.mouse.move(drag.x, drag.y);
  await page.mouse.down();
  await page.mouse.move(drag.x + 80, drag.y + 40, { steps: 5 });
  await page.mouse.up();
  assert.equal((await state()).empty, false, "失焦后拖选不应被折叠");
  assert.equal((await state()).top, drag.top, "拖选聚焦应保留视口");

  const shift = await prepare(false);
  await page.mouse.click(shift.x, shift.y);
  await page.keyboard.down("Shift");
  await page.mouse.click(shift.x + 50, shift.y + 20);
  await page.keyboard.up("Shift");
  assert.equal((await state()).anchor, shift.pos, "Shift 点击应保留原选区锚点");
  assert.equal((await state()).empty, false, "Shift 点击应扩展选区");

  const multi = await prepare(true);
  await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
  await page.mouse.click(multi.x, multi.y);
  await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
  assert.equal((await state()).ranges, 2, "修饰键点击应保留多光标");
  assert.equal((await state()).top, multi.top, "多光标聚焦不应跳转视口");

  console.log(
    "编辑器交互自测通过：聚焦防跳动、连续单击、双击选词、三击选行、拖选、Shift 扩选、多光标",
  );
} finally {
  await browser?.close();
  await server.close();
  await rm(fixture, { recursive: true, force: true });
}
