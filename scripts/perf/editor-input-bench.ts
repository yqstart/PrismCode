// ==================== Monaco 编辑器链路微基准 ====================
// （node --experimental-strip-types scripts/perf/editor-input-bench.ts）
// 度量三件真实开销：模型创建、标签切换（setModel + 视图状态）、装饰刷新。
// 输出为每次操作的平均耗时（ms），非断言脚本；数值随机器浮动，看相对量级。
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";

const root = process.cwd();
const fixture = await mkdtemp(join(root, ".perf-bench-"));
const server = await createServer({
  server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
  logLevel: "error",
});
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;

try {
  await writeFile(
    join(fixture, "index.html"),
    `<!doctype html><html><body><div id="host" style="height:600px;width:900px"></div>
    <script type="module">
      import { monaco } from '/src/features/editor/monaco/setup.ts';
      window.monaco = monaco;
      window.ready = true;
    </script></body></html>`,
  );
  await server.listen();

  browser = await puppeteer.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  await page.goto(`${server.resolvedUrls!.local[0]}${basename(fixture)}/index.html`);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true, {
    timeout: 30000,
  });

  const results = await page.evaluate(async () => {
    const { monaco } = window;
    const host = document.getElementById("host")!;
    const source = Array.from({ length: 2000 }, (_, i) => `const value${i} = ${i};`).join("\n");
    const out: Record<string, number> = {};

    const time = (label: string, iterations: number, fn: () => void) => {
      const start = performance.now();
      for (let i = 0; i < iterations; i += 1) fn();
      out[label] = (performance.now() - start) / iterations;
    };

    // 1. 模型创建（2000 行 TS）
    const models: ReturnType<typeof monaco.editor.createModel>[] = [];
    time("modelCreate", 10, () => {
      models.push(
        monaco.editor.createModel(
          source,
          "typescript",
          monaco.Uri.file(`/tmp/bench-${models.length}.ts`),
        ),
      );
    });

    // 2. 编辑器创建
    let editor: ReturnType<typeof monaco.editor.create> | null = null;
    time("editorCreate", 5, () => {
      editor?.dispose();
      editor = monaco.editor.create(host, { model: models[0], theme: "vs" });
    });

    // 3. 标签切换（setModel + saveViewState/restoreViewState）
    const target = editor!;
    let flip = 0;
    time("tabSwitch", 200, () => {
      flip += 1;
      const state = target.saveViewState();
      target.setModel(models[flip % models.length]!);
      if (state) target.restoreViewState(state);
    });

    // 4. 装饰刷新（500 条行装饰）
    const decorations = Array.from({ length: 500 }, (_, i) => ({
      range: new monaco.Range(i + 1, 1, i + 1, 1),
      options: { isWholeLine: true, className: "bench-line" },
    }));
    const collection = target.createDecorationsCollection([]);
    time("decorations500", 20, () => {
      collection.set(decorations);
    });
    collection.clear();

    for (const model of models) model.dispose();
    editor?.dispose();
    return out;
  });

  console.log("Monaco 编辑器链路微基准（越低越好）");
  for (const [label, value] of Object.entries(results)) {
    console.log(`  ${label.padEnd(16)} ${value.toFixed(3)} ms`);
  }
} finally {
  await browser?.close();
  await server.close();
  await rm(fixture, { recursive: true, force: true });
}
