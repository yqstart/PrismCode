import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  mapWithConcurrency,
  prioritizeActiveTab,
} from "../src/features/editor/sessionRestore.ts";

const projectRoot = resolve(import.meta.dirname, "..");

function source(path: string): string {
  return readFileSync(resolve(projectRoot, path), "utf8");
}

// ==================== 文件监听：禁止回归到全量 FileId 缓存 ====================

const workspaceSource = source("src/stores/workspace.ts");
assert.match(
  workspaceSource,
  /watchImmediate\s+as\s+watchFs/,
  "工作区监听必须使用 watchImmediate，避免 notify_debouncer_full 递归预扫描",
);
assert.doesNotMatch(
  workspaceSource,
  /delayMs\s*:/,
  "工作区监听已在前端合并事件，不应再次启用原生全量去抖缓存",
);

// ==================== 首屏分包：包名必须按 node_modules 边界匹配 ====================

const viteSource = source("vite.config.ts");
assert.match(
  viteSource,
  /\/node_modules\/monaco-editor\/esm\/vs\/editor\//,
  "Monaco 内核必须按 editor 目录拆成 monaco-core",
);
assert.match(
  viteSource,
  /\/node_modules\/monaco-editor\/esm\/vs\/features\//,
  "Monaco feature 必须按 features 目录拆成 monaco-features",
);
assert.match(
  viteSource,
  /\/node_modules\/monaco-editor\/esm\/vs\/languages\/definitions\//,
  "Monaco 语言定义必须按 definitions 目录拆成 monaco-langs",
);
assert.doesNotMatch(
  viteSource,
  /monaco-editor\/esm\/vs\/languages\/features\//,
  "languages/features（含 worker 源码）不得打进命名首屏 chunk",
);
assert.doesNotMatch(
  viteSource,
  /id\.includes\(["']typescript["']\)/,
  "禁止用宽泛子串匹配 TypeScript，避免 typescript.svg 把编译器拉进首屏",
);
assert.match(
  viteSource,
  /\/node_modules\/@xterm\//,
  "xterm vendor 必须精确匹配真实包目录",
);

const appShellSource = source("src/app/AppShell.vue");
assert.match(
  appShellSource,
  /defineAsyncComponent\(\s*\(\)\s*=>\s*import\(["']@\/features\/sessions\/TerminalPanel\.vue["']\)/,
  "终端面板必须按需加载，未打开终端时不应进入首屏依赖图",
);
assert.doesNotMatch(
  appShellSource,
  /import\s+TerminalPanel\s+from/,
  "终端面板不能保留静态导入",
);

const sessionsSource = source("src/stores/sessions.ts");
assert.match(
  sessionsSource,
  /const\s+viewHydrated\s*=\s*ref\(false\)/,
  "终端 store 必须区分磁盘快照与本次运行已挂载的终端视图",
);
assert.match(
  sessionsSource,
  /viewHydrated\.value\s*=\s*saved\.open/,
  "恢复已收起的终端快照时不能提前挂载 xterm",
);
assert.match(
  sessionsSource,
  /function\s+openSessions[\s\S]*?viewHydrated\.value\s*=\s*true/,
  "用户真正展开终端时才应触发终端视图按需加载",
);

// ==================== 会话恢复：活动标签优先、后台读取限流 ====================

const savedTabs = [
  { path: "/repo/a.ts" },
  { path: "/repo/b.ts" },
  { path: "/repo/c.ts" },
];
const prioritized = prioritizeActiveTab(savedTabs, "/repo/c.ts");
assert.deepEqual(
  prioritized.map((tab) => tab.path),
  ["/repo/c.ts", "/repo/a.ts", "/repo/b.ts"],
);
assert.deepEqual(
  savedTabs.map((tab) => tab.path),
  ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"],
  "排序不能原地修改持久化会话",
);

let inFlight = 0;
let peakInFlight = 0;
const restored = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
  inFlight += 1;
  peakInFlight = Math.max(peakInFlight, inFlight);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 4));
  inFlight -= 1;
  return value * 10;
});
assert.deepEqual(restored, [10, 20, 30, 40, 50]);
assert.equal(peakInFlight, 2, "后台标签读取必须遵守并发上限");

const editorSource = source("src/stores/editor.ts");
const restoreStart = editorSource.indexOf("async function restoreSession");
const restoreEnd = editorSource.indexOf("async function openFile", restoreStart);
assert.ok(restoreStart >= 0 && restoreEnd > restoreStart, "必须能定位 restoreSession 实现");
const restoreBody = editorSource.slice(restoreStart, restoreEnd);
assert.doesNotMatch(
  restoreBody,
  /await\s+openFile\(/,
  "会话恢复不能逐标签调用带激活/定位副作用的 openFile",
);
assert.match(
  restoreBody,
  /mapWithConcurrency/,
  "非活动标签必须限流并发恢复",
);

// `pnpm build` 后额外校验真实入口依赖图，而不只相信源码配置。
if (process.argv.includes("--bundle")) {
  const html = source("dist/index.html");
  const preloads = html
    .split("\n")
    .filter((line) => line.includes('rel="modulepreload"'))
    .join("\n");
  assert.doesNotMatch(
    preloads,
    /typescript-vendor/,
    "TypeScript 编译器不能被首屏 modulepreload",
  );
  assert.doesNotMatch(
    preloads,
    /worker/i,
    "首屏 modulepreload 不含任何 worker chunk",
  );
  assert.doesNotMatch(
    preloads,
    /xterm-vendor/,
    "终端依赖不能被首屏 modulepreload",
  );
}

console.log("✅ 项目打开性能自检通过");
