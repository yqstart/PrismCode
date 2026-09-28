// ==================== 文件图标懒加载自测 ====================
// 图标清单与 SVG URL 表移出首屏后，必须仍能在加载完成后解析出真实图标。
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer";

declare global {
  interface Window {
    iconVersion: () => number;
    resolveIcon: (path: string, isDir?: boolean) => string;
    ensureIconAssets: () => Promise<void>;
  }
}

const root = process.cwd();
const fixture = await mkdtemp(join(root, ".file-icons-"));
const server = await createServer({
  server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
  logLevel: "error",
});
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;

try {
  await writeFile(
    join(fixture, "index.html"),
    `<!doctype html><html><body>
    <script type="module">
      import { ensureIconAssets, iconAssetsVersion, resolveMaterialIconUrl } from '/src/shared/fileIcons.ts';
      window.ensureIconAssets = ensureIconAssets;
      window.iconVersion = () => iconAssetsVersion.value;
      window.resolveIcon = (path, isDir) => resolveMaterialIconUrl(path, { isDir: Boolean(isDir) });
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

  // 资源未加载时：给出通用图标而不是空串
  const before = await page.evaluate(() => ({
    version: window.iconVersion(),
    fileUrl: window.resolveIcon("a.ts"),
    dirUrl: window.resolveIcon("/tmp/src", true),
  }));
  assert.equal(before.version, 0, "初始版本应为 0（清单尚未加载）");
  assert.ok(before.fileUrl.length > 0, "清单未就绪时也应给出通用文件图标");
  assert.ok(before.dirUrl.length > 0, "清单未就绪时也应给出通用文件夹图标");

  // 预热后：version 自增，TypeScript 文件解析到专属图标
  const after = await page.evaluate(async () => {
    await window.ensureIconAssets();
    return {
      version: window.iconVersion(),
      tsUrl: window.resolveIcon("a.ts"),
      folderUrl: window.resolveIcon("/tmp/src", true),
      unknownUrl: window.resolveIcon("a.unknownext"),
    };
  });
  assert.ok(after.version > 0, "预热后版本必须自增以触发图标重算");
  assert.notEqual(after.tsUrl, before.fileUrl, ".ts 应解析到 TypeScript 专属图标");
  assert.ok(after.folderUrl.length > 0, "文件夹图标必须可解析");
  assert.ok(after.unknownUrl.length > 0, "未知扩展名应回退到通用文件图标");

  const ignoredErrors = pageErrors.filter((message) => !message.includes("__TAURI"));
  assert.deepEqual(ignoredErrors, [], `页面不应有未捕获错误：${ignoredErrors.join(" | ")}`);

  console.log("✅ 文件图标懒加载自测通过");
} finally {
  await browser?.close();
  await server.close();
  await rm(fixture, { recursive: true, force: true });
}
