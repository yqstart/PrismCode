import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import replace from "@rollup/plugin-replace";
import { transformSync } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const host = process.env.TAURI_DEV_HOST;

// monaco 的 languages/features/typescript/tsMode.js 直接 import './workerManager.js'。
// 上游实现 keepIdleModels:true，且只在配置变化时重启 worker：失焦窗口的 TypeScript
// 编译器会一直留在内存里。这里把它换成仓库内 tsWorkerManager.ts（暴露挂起 / 停用 API）。
// dev 走 optimizeDeps 的 esbuild 预构建（config 变化会自动失效重打包），build 与源码
// 服务模式走下面的 resolveId 插件。
const monacoWorkerManager = fileURLToPath(
  new URL("./src/features/editor/monaco/tsWorkerManager.ts", import.meta.url),
);

// 依赖预构建的缓存 key 只含插件名（vite 的 getConfigHash 取 plugins.map(p => p.name)），
// 不含插件实现：换了 tsWorkerManager.ts 必须换名才会重新预构建，否则 dev 会继续跑旧产物。
const monacoWorkerManagerPlugin = `monaco-ts-worker-manager-${createHash("sha1")
  .update(readFileSync(monacoWorkerManager, "utf8"))
  .digest("hex")
  .slice(0, 8)}`;

/** tsMode.js 里的 './workerManager.js' → 仓库内实现；其它导入不动 */
function replaceMonacoWorkerManager(source: string, importer: string): string | null {
  if (!source.endsWith("workerManager.js")) return null;
  if (!importer.replace(/\\/g, "/").endsWith("typescript/tsMode.js")) return null;
  return monacoWorkerManager;
}

export default defineConfig(async () => ({
  plugins: [
    {
      name: monacoWorkerManagerPlugin,
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer) return null;
        return replaceMonacoWorkerManager(source, importer);
      },
    },
    // typescript 编译器 UMD 内的 node 引用替换为浏览器兼容值（类型服务 chunk 专用；
    // 项目源码无 process 引用，精确子串替换安全）
    replace({
      preventAssignment: true,
      values: {
        "process.platform": JSON.stringify("browser"),
        "process.cwd()": "(() => '/')()",
        "process.nextTick(": "((fn, ...args) => setTimeout(() => fn(...args), 0))(",
        "process.memoryUsage()": "(() => ({ rss: 0, heapTotal: 0, heapUsed: 0 }))()",
        "process.env": "({})",
        "process.pid": "0",
        "process.execArgv": "[]",
        "process.argv": "[]",
        "process.exit(": "((code) => { throw new Error('process.exit(' + code + ')'); })(",
        "process.stdout": "({ write: () => {}, isTTY: false })",
        "process.recordreplay": "undefined",
        "process.browser": "true",
      },
    }),
    // rollup 无法静态分析 typescript.js 巨型 IIFE-UMD 的导出（dev 的 esbuild
    // 预构建正常，build 会丢 API）→ build 阶段用 esbuild 把 UMD 转 ESM
    {
      name: "typescript-umd-to-esm",
      apply: "build",
      enforce: "pre",
      transform(code, id) {
        if (id.includes("/typescript/lib/typescript.js")) {
          const out = transformSync(code, {
            format: "esm",
            platform: "browser",
            target: "es2020",
          });
          return { code: out.code, map: null };
        }
        return null;
      },
    },
    vue(),
  ],
  // dev 的依赖预构建走 esbuild（不经过上面的 resolveId），同样的替换要再做一次
  optimizeDeps: {
    esbuildOptions: {
      plugins: [
        {
          name: monacoWorkerManagerPlugin,
          setup(build) {
            build.onResolve({ filter: /workerManager\.js$/ }, (args) => {
              const target = replaceMonacoWorkerManager(args.path, args.importer);
              return target ? { path: target } : null;
            });
          },
        },
      ],
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // 稳定大依赖拆独立 vendor chunk：入口只含业务代码，冷启动解析量更小、
        // vendor 变更不触发全量缓存失效；语言服务/类型服务等已走动态 import 独立 chunk
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, "/");
          if (!normalizedId.includes("/node_modules/")) return undefined;
          // Monaco 内核 / feature 注册 / 语言定义分块。
          // languages/features（含 worker 源码）不设规则，交给 ?worker 各自打包。
          if (normalizedId.includes("/node_modules/monaco-editor/esm/vs/editor/")) {
            return "monaco-core";
          }
          if (normalizedId.includes("/node_modules/monaco-editor/esm/vs/features/")) {
            return "monaco-features";
          }
          if (normalizedId.includes("/node_modules/monaco-editor/esm/vs/languages/definitions/")) {
            return "monaco-langs";
          }
          if (
            normalizedId.includes("/node_modules/vue/") ||
            normalizedId.includes("/node_modules/pinia/") ||
            normalizedId.includes("/node_modules/@vue/")
          ) {
            return "vue-vendor";
          }
          if (
            normalizedId.includes("/node_modules/@xterm/") ||
            normalizedId.includes("/node_modules/xterm/")
          ) {
            return "xterm-vendor";
          }
          return undefined;
        },
      },
    },
    // Monaco 内核单块
    chunkSizeWarningLimit: 2500,
  },
  worker: {
    format: "es",
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
        protocol: "ws",
        host,
        port: 1421,
      }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
