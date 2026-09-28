import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import replace from "@rollup/plugin-replace";
import { transformSync } from "esbuild";
import { fileURLToPath, URL } from "node:url";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [
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
