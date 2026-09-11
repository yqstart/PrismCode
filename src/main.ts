import { createApp } from "vue";
import App from "./App.vue";
import { pinia } from "@/stores/pinia";
import "./styles/global.css";

// ==================== 首屏防闪白 ====================
// CSS 加载与 pinia 启动之间存在窗口期（data-theme 尚未挂上）；
// 在 #app 落地前先用默认深色背景兜底，避免一帧白屏。
// 真正的 data-theme 由 settings store 启动后注入。
document.documentElement.style.background = "#101114";
document.documentElement.style.colorScheme = "dark";

// 禁用 WebView 原生右键菜单；各处自定义菜单自行 preventDefault 后展示
document.addEventListener(
  "contextmenu",
  (event) => {
    event.preventDefault();
  },
  true,
);

// ==================== 真机 IPC 自检工具 ====================
// 暴露到 window.__ipcSelfCheck（仅 dev 模式），便于在 WebView DevTools
// 控制台一行命令复现"push 卡住 800ms 期间并发 10 个 git_status"场景，
// 量化每条 IPC 真实耗时，验证 120s 超时窗口下 UI 仍可点击。
if (import.meta.env.DEV) {
  type IpcCmd = string;
  interface IpcResult {
    cmd: string;
    elapsed: number;
    ok: boolean;
  }
  interface WindowWithCheck {
    __ipcSelfCheck: (opts?: {
      slowCmd?: IpcCmd;
      slowMs?: number;
      fastCmd?: IpcCmd;
      fastCount?: number;
    }) => Promise<{ slow: IpcResult; fast: IpcResult[]; verdict: string }>;
  }
  (window as unknown as WindowWithCheck).__ipcSelfCheck = async (opts = {}) => {
    const { invoke } = await import("@tauri-apps/api/core");
    const slowCmd = opts.slowCmd ?? "dev_fake_block";
    const slowMs = opts.slowMs ?? 800;
    const fastCmd = opts.fastCmd ?? "git_status";
    const fastCount = opts.fastCount ?? 10;
    const workspaceStore = await import("@/stores/workspace");
    const root = workspaceStore.useWorkspaceStore().rootPath ?? "";
    if (!root) {
      return {
        slow: { cmd: slowCmd, elapsed: 0, ok: false },
        fast: [],
        verdict: "未打开工作区，无法测量",
      };
    }

    // 第一阶段：基线 1× fastCmd 测量（无卡住，量化"无干扰"下的 IPC 耗时）
    const t0 = performance.now();
    let baselineOk = false;
    try {
      await invoke(fastCmd, { root });
      baselineOk = true;
    } catch {
      /* 忽略 */
    }
    const baselineElapsed = performance.now() - t0;

    // 第二阶段：触发 fake 卡住 + 同时并发 fastCount 个 fastCmd
    // - slowCmd 默认 dev_fake_block：真 Tauri 调度层 + tokio::time::sleep
    // - 等价"git_push 卡住 N ms 期间并发 git_status"的真机复现
    const t1 = performance.now();
    const slowPromise = (async () => {
      const s = performance.now();
      let ok = false;
      try {
        await invoke(slowCmd, { root, ms: slowMs });
        ok = true;
      } catch {
        /* 忽略 */
      }
      return { cmd: slowCmd, elapsed: performance.now() - s, ok };
    })();
    // 给 slowPromise 50ms 启动时间（让 IPC 桥先被占用），再并发 fast
    await new Promise((r) => setTimeout(r, 50));

    const fastResults: IpcResult[] = [];
    const fastPromises: Promise<void>[] = [];
    for (let i = 0; i < fastCount; i++) {
      const p = (async () => {
        const s = performance.now();
        let ok = false;
        try {
          await invoke(fastCmd, { root });
          ok = true;
        } catch {
          /* 忽略 */
        }
        fastResults.push({ cmd: fastCmd, elapsed: performance.now() - s, ok });
      })();
      fastPromises.push(p);
    }
    await Promise.all(fastPromises);
    const slowResult = await slowPromise;
    const totalElapsed = performance.now() - t1;

    const maxFast = Math.max(...fastResults.map((r) => r.elapsed));
    const avgFast = fastResults.length
      ? fastResults.reduce((s, r) => s + r.elapsed, 0) / fastResults.length
      : 0;
    // 关键判定：并发 fast 的总耗时应接近 slowMs（说明 fast 在 slow 期间**不排队**）
    // 而非接近 fastCount × 单次耗时（被串行化排队）
    const serialWorst = avgFast * fastCount;
    const verdict =
      totalElapsed < slowMs * 1.5
        ? `✅ UI 即时响应：${slowCmd} 卡 ${slowMs}ms 期间 ${fastCount} 个并发 ${fastCmd} 完成 ${totalElapsed.toFixed(0)}ms（最大 ${maxFast.toFixed(0)}ms / 平均 ${avgFast.toFixed(0)}ms）`
        : `⚠️ UI 有卡顿：并发 ${fastCount} 个 ${fastCmd} 总耗时 ${totalElapsed.toFixed(0)}ms（> ${slowMs}ms，疑似串行；串行最坏 ${serialWorst.toFixed(0)}ms）`;

    console.log(
      `[ipcSelfCheck] baseline (1× ${fastCmd}): ${baselineElapsed.toFixed(0)}ms, ${baselineOk ? "ok" : "err"}`,
    );
    console.log(
      `[ipcSelfCheck] slow (1× ${slowCmd} ${slowMs}ms): ${slowResult.elapsed.toFixed(0)}ms, ${slowResult.ok ? "ok" : "err"}`,
    );
    console.log(
      `[ipcSelfCheck] fast (${fastCount}× ${fastCmd}) during slow: total ${totalElapsed.toFixed(0)}ms, max ${maxFast.toFixed(0)}ms, avg ${avgFast.toFixed(0)}ms`,
    );
    console.log(`[ipcSelfCheck] ${verdict}`);

    return {
      slow: slowResult,
      fast: fastResults,
      verdict,
    };
  };

  // 在 dev 启动时打印自检指引
  // eslint-disable-next-line no-console
  console.log(
    "%c[PrismCode 真机自检]%c 打开工作区后，在 Console 粘贴: await __ipcSelfCheck()",
    "background:#7c3aed;color:#fff;padding:2px 6px;border-radius:3px",
    "color:#888",
  );
  // eslint-disable-next-line no-console
  console.log(
    "[PrismCode 真机自检] 真机复现 push 卡住期间并发 IPC：await __ipcSelfCheck({ slowMs: 800, fastCount: 20 })",
  );
  // eslint-disable-next-line no-console
  console.log(
    "[PrismCode 真机自检] 或配慢网络点 Push 后立刻跑：await __ipcSelfCheck({ fastCount: 20 })",
  );

  // ==================== ⌘/Ctrl+滚轮调字号自测 ====================
  // dev 模式访问 http://localhost:1420/?wheel=1 时自动挂载真实 CodeMirrorEditor
  // 组件并派发真实 WheelEvent（带 metaKey），结果渲染到 #wheel-selftest-result，
  // 供外部自动化直接读取文本验证「wheel → CM6 handler → patchEditor → 字号生效」链路。
  if (location.search.includes("wheel=1")) {
    (async () => {
      const { createApp } = await import("vue");
      const { default: CodeMirrorEditor } = await import("@/features/editor/CodeMirrorEditor.vue");
      const { useSettingsStore } = await import("@/stores/settings");
      const host = document.createElement("div");
      host.style.cssText =
        "position:fixed;left:0;top:0;width:900px;height:520px;z-index:99999;background:#1e1e1e;padding:12px";
      document.body.appendChild(host);
      const resultBox = document.createElement("pre");
      resultBox.id = "wheel-selftest-result";
      resultBox.style.cssText =
        "position:fixed;left:0;top:540px;z-index:99999;background:#111;color:#7ee787;padding:8px;font:12px monospace;white-space:pre-wrap;max-width:900px";
      document.body.appendChild(resultBox);
      const write = (text: string) => {
        resultBox.textContent = text;
      };
      try {
        write("挂载组件中…");
        const app = createApp(CodeMirrorEditor, {
          path: "/tmp/selftest.ts",
          content: "const greeting = 'hi';\nconsole.log(greeting);\n",
        });
        app.mount(host);
        await new Promise((r) => setTimeout(r, 800));
        const content = host.querySelector<HTMLElement>(".cm-content");
        if (!content) {
          write("失败：未找到 .cm-content（组件挂载失败）");
          return;
        }
        const store = useSettingsStore();
        const before = store.editor.fontSize;
        // 下推一格（deltaY=+100，模拟鼠标一格）→ 期望调大
        content.dispatchEvent(
          new WheelEvent("wheel", { deltaY: 100, deltaX: 0, metaKey: true, bubbles: true, cancelable: true }),
        );
        await new Promise((r) => setTimeout(r, 120));
        const afterDown = store.editor.fontSize;
        const domDown = getComputedStyle(content).fontSize;
        // 上推一格（deltaY=-100）→ 期望调小
        content.dispatchEvent(
          new WheelEvent("wheel", { deltaY: -100, deltaX: 0, metaKey: true, bubbles: true, cancelable: true }),
        );
        await new Promise((r) => setTimeout(r, 120));
        const afterUp = store.editor.fontSize;
        const domUp = getComputedStyle(content).fontSize;
        // 无修饰键滚轮 → 不应调字号
        content.dispatchEvent(
          new WheelEvent("wheel", { deltaY: 100, deltaX: 0, metaKey: false, bubbles: true, cancelable: true }),
        );
        await new Promise((r) => setTimeout(r, 120));
        const afterPlain = store.editor.fontSize;
        const domPlain = getComputedStyle(content).fontSize;
        const ok =
          afterDown === before + 1 && afterUp === before && afterPlain === before && domDown !== domUp;
        write(
          [
            ok ? "✅ 通过" : "❌ 失败",
            `store: before=${before} afterDown=${afterDown}(期望 ${before + 1}) afterUp=${afterUp}(期望 ${before}) afterPlain=${afterPlain}(期望 ${before})`,
            `DOM: 下推后=${domDown}(期望 ${afterDown}px) 上推后=${domUp}(期望 ${afterUp}px) 无修饰键=${domPlain}`,
            "方向: 下推调大 / 上推调小 / 无修饰键不变",
          ].join("\n"),
        );
      } catch (err) {
        write(`异常: ${String(err)}`);
      }
    })();
  }
}

const app = createApp(App);
app.use(pinia);
app.mount("#app");
