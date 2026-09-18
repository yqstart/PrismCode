import { nextTick, watch, type WatchStopHandle } from "vue";
import { useEditorStore } from "@/stores/editor";
import { useSettingsStore } from "@/stores/settings";
import { useSessionsStore } from "@/stores/sessions";

/**
 * 自动保存：
 * - 开启时：内容变更后按延迟写盘
 * - 兜底：窗口隐藏 / 关闭前强制落盘（避免延迟未触发就崩溃丢改）
 */
export interface AutoSaveOptions {
  /**
   * 关闭窗口前保存窗口级编辑器/终端快照。
   * 返回 `false` 表示取消本次关闭（如 light 模式还有未保存的独立文件）。
   */
  beforeClose?: () => boolean | void | Promise<boolean | void>;
}

export function setupAutoSave(options: AutoSaveOptions = {}): () => void {
  const settings = useSettingsStore();
  const editor = useEditorStore();
  const sessions = useSessionsStore();

  let delayTimer: number | undefined;
  let flushPromise: Promise<void> | null = null;
  const stops: WatchStopHandle[] = [];
  const cleanups: Array<() => void> = [];

  function clearDelay() {
    if (delayTimer !== undefined) {
      window.clearTimeout(delayTimer);
      delayTimer = undefined;
    }
  }

  function scheduleDelayedSave() {
    if (!settings.editor.autoSave) return;
    if (!editor.hasAutoSaveableChanges()) return;
    clearDelay();
    const delay = Math.max(200, settings.editor.autoSaveDelayMs || 1000);
    delayTimer = window.setTimeout(() => {
      delayTimer = undefined;
      void flushNow();
    }, delay);
  }

  async function flushNow() {
    if (flushPromise) {
      await flushPromise;
      return;
    }
    if (!settings.editor.autoSave) return;
    if (!editor.hasAutoSaveableChanges()) return;
    clearDelay();
    const current = editor.saveAll({ quiet: true, auto: true });
    flushPromise = current;
    try {
      await current;
    } finally {
      if (flushPromise === current) {
        flushPromise = null;
      }
    }
  }

  stops.push(
    watch(
      // dirtyPaths 的 Set 引用只在脏标签集合实际变化时替换（editor.ts 缓存），
      // 连续输入不触发；比「tabs 拼接脏标记字符串」省去每键 O(tab 数) 构建
      () => editor.dirtyPaths,
      () => scheduleDelayedSave(),
    ),
  );

  stops.push(
    watch(
      () => [settings.editor.autoSave, settings.editor.autoSaveDelayMs] as const,
      () => {
        clearDelay();
        if (settings.editor.autoSave) scheduleDelayedSave();
      },
    ),
  );

  function onVisibility() {
    if (document.visibilityState === "hidden") {
      void flushNow();
    }
  }

  function onPageHide() {
    void flushNow();
  }

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  cleanups.push(() => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
  });

  // Tauri 窗口关闭：先完成终端清理，再继续原生关闭流程。
  // close-requested 由 Tauri API 的异步事件包装器派发；清理期间必须拦截
  // 后续点击，清理完成后允许原生关闭事件通过，避免红绿灯事件再次进入
  // 同一个关闭处理器而把窗口留在已拦截状态。
  let closeUnlisten: (() => void | Promise<void>) | undefined;
  let closePromise: Promise<void> | null = null;
  let allowNativeClose = false;

  async function finishWindowClose(win: { destroy: () => Promise<void> }) {
    try {
      // beforeClose 返回 false 表示用户取消了关闭：窗口保持原样，
      // 监听器仍在（allowNativeClose 未置位），下一次关闭请求照常进入。
      if ((await options.beforeClose?.()) === false) return;
    } catch {
      // 状态快照失败也不能跳过终端清理或阻止窗口关闭。
    }
    try {
      await sessions.closeSessions({ preserveSession: true });
      await nextTick();
    } catch {
      // 终端清理失败也不能把窗口留在半关闭状态。
    }
    try {
      await flushNow();
    } catch {
      // 自动保存失败也不能阻止窗口关闭。
    }

    // 允许后续原生 close 请求通过。不能只依赖异步注销监听，否则 macOS
    // 可能在注销完成前再次把请求拦住。
    allowNativeClose = true;
    closeUnlisten?.();
    closeUnlisten = undefined;

    // macOS 红绿灯的原生关闭请求可能仍在等待 Tauri 的事件链；通过 Rust
    // 在 AppKit 主线程直接关闭 NSWindow，避免再次排队到同一条 IPC 链后面。
    window.setTimeout(() => {
      void import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("close_window"),
      ).catch(() => {
        // 原生关闭命令不可用时再使用 Tauri 的强制销毁兜底。
        void win.destroy().catch(() => undefined);
      });
    }, 0);
  }

  void (async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      closeUnlisten = await win.onCloseRequested((event) => {
        if (allowNativeClose) return;
        event.preventDefault();
        // 清理期间的重复点击只阻止重复启动清理；第一次请求对应的
        // finishWindowClose 会在完成后继续原生 close，不需要用户再次点击。
        if (closePromise) return;
        closePromise = finishWindowClose(win);
        void closePromise.then(
          () => {
            closePromise = null;
          },
          () => {
            closePromise = null;
          },
        );
      });
    } catch {
      // 纯浏览器预览无 Tauri
    }
  })();

  return () => {
    clearDelay();
    for (const stop of stops) stop();
    for (const fn of cleanups) fn();
    closeUnlisten?.();
  };
}
