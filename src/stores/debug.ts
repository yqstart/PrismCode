// ==================== 调试状态 ====================
// 断点、线程、调用栈、变量与单步控制。DAP 协议细节都在 dapSession，
// 这里只维护界面需要的状态与「启动链」的顺序。
import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { t } from "@/i18n";
import {
  DAP_CONNECT_TIMEOUT_MS,
  DAP_INITIALIZE_TIMEOUT_MS,
  currentDapClient,
  dapLogs,
  probeDapAdapter,
  startDapSession,
  stopDapSession,
  type DapClient,
  type DapEvent,
} from "@/features/debug/dapSession";
import { startJavaDebugServer } from "@/features/java/javaSession";
import { basename } from "@/shared/fs";
import { isWindowsPlatform, launchCommandLine, type JavaLaunchPlan } from "@/shared/javaRun";
import { useJavaStore } from "@/stores/java";
import { useSessionsStore } from "@/stores/sessions";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";

export type DebugState = "idle" | "starting" | "running" | "paused" | "stopped";

export interface DebugThread {
  id: number;
  name: string;
}

export interface DebugStackFrame {
  id: number;
  name: string;
  path: string | null;
  line: number;
}

export interface DebugVariable {
  name: string;
  value: string;
  type?: string;
}

/** 计时器句柄：本仓库同时有 DOM 与 Node 的类型定义，形状用一处别名收口 */
type TimerHandle = ReturnType<typeof setTimeout>;

const OUTPUT_LINES = 400;

export const useDebugStore = defineStore("debug", () => {
  const state = ref<DebugState>("idle");
  const sessionId = ref<string | null>(null);
  const threads = ref<DebugThread[]>([]);
  const activeThreadId = ref<number | null>(null);
  const stackFrames = ref<DebugStackFrame[]>([]);
  const activeFrameId = ref<number | null>(null);
  const scopes = ref<Array<{ name: string; variablesReference: number }>>([]);
  const variables = ref<DebugVariable[]>([]);
  const output = ref<string[]>([]);
  const breakpoints = ref(new Map<string, number[]>());
  const stopReason = ref<string | null>(null);
  const configurationId = ref<string | null>(null);
  const debugPort = ref<number | null>(null);
  const busy = ref(false);
  /**
   * 启动链中途被取消（面板收起或点了停止）。启动要跨好几个 await，
   * 没有这个标记就会在用户已经放弃之后继续把 JVM 挂起来。
   */
  let cancelRequested = false;
  /**
   * 目标进程所在的终端标签。用户中途切到别的终端时，打断（Ctrl-C）仍要打对地方，
   * 否则会留下一个永远挂在 `suspend=y` 上的 JVM。
   */
  let targetTerminalId: string | null = null;

  /** 断点总数：面板与标签上的角标用 */
  const breakpointCount = computed(() =>
    [...breakpoints.value.values()].reduce((total, lines) => total + lines.length, 0),
  );

  function linesFor(path: string): number[] {
    return [...(breakpoints.value.get(path) ?? [])].sort((left, right) => left - right);
  }

  function pushOutput(line: string): void {
    output.value.push(line);
    if (output.value.length > OUTPUT_LINES) {
      output.value.splice(0, output.value.length - OUTPUT_LINES);
    }
  }

  async function sendBreakpoints(client: DapClient, path: string): Promise<void> {
    const lines = linesFor(path);
    try {
      await client.request("setBreakpoints", {
        source: { name: basename(path), path },
        breakpoints: lines.map((line) => ({ line })),
        lines,
      });
    } catch (error) {
      pushOutput(error instanceof Error ? error.message : String(error));
    }
  }

  async function syncAllBreakpoints(client: DapClient): Promise<void> {
    for (const path of breakpoints.value.keys()) {
      await sendBreakpoints(client, path);
    }
  }

  /** 切换断点：会话活着时立刻同步给适配器，否则等下次启动 */
  async function toggleBreakpoint(path: string, line: number): Promise<void> {
    const current = linesFor(path);
    const next = current.includes(line)
      ? current.filter((value) => value !== line)
      : [...current, line].sort((left, right) => left - right);
    if (next.length) breakpoints.value.set(path, next);
    else breakpoints.value.delete(path);
    const client = currentDapClient();
    if (client && !client.isDisposed) {
      await sendBreakpoints(client, path);
    }
  }

  async function fetchThreads(): Promise<number | null> {
    const client = currentDapClient();
    if (!client || client.isDisposed) return null;
    const result = (await client.request("threads", {})) as { threads?: DebugThread[] };
    threads.value = result?.threads ?? [];
    return threads.value[0]?.id ?? null;
  }

  async function refreshVariables(variablesReference: number): Promise<void> {
    const client = currentDapClient();
    if (!client || client.isDisposed) return;
    try {
      const result = (await client.request("variables", { variablesReference })) as {
        variables?: Array<{ name: string; value: string; type?: string }>;
      };
      variables.value = result?.variables ?? [];
    } catch (error) {
      pushOutput(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshScopes(frameId: number): Promise<void> {
    const client = currentDapClient();
    if (!client || client.isDisposed) return;
    try {
      const result = (await client.request("scopes", { frameId })) as {
        scopes?: Array<{ name: string; variablesReference: number }>;
      };
      scopes.value = (result?.scopes ?? []).filter((scope) => scope.variablesReference > 0);
      const first = scopes.value[0];
      if (first) await refreshVariables(first.variablesReference);
      else variables.value = [];
    } catch (error) {
      pushOutput(error instanceof Error ? error.message : String(error));
    }
  }

  /** 命中暂停后拉一轮线程 + 调用栈 + 变量 */
  async function refreshPaused(threadId?: number): Promise<void> {
    const client = currentDapClient();
    if (!client || client.isDisposed) return;
    busy.value = true;
    try {
      const threadIdToUse = threadId ?? activeThreadId.value ?? (await fetchThreads());
      if (threadIdToUse == null) return;
      activeThreadId.value = threadIdToUse;
      const stack = (await client.request("stackTrace", {
        threadId: threadIdToUse,
        startFrame: 0,
        levels: 20,
      })) as {
        stackFrames?: Array<{ id: number; name: string; line: number; source?: { path?: string } }>;
      };
      stackFrames.value = (stack?.stackFrames ?? []).map((frame) => ({
        id: frame.id,
        name: frame.name,
        path: frame.source?.path ?? null,
        line: frame.line,
      }));
      const first = stackFrames.value[0];
      activeFrameId.value = first?.id ?? null;
      if (first) await refreshScopes(first.id);
      else {
        scopes.value = [];
        variables.value = [];
      }
    } catch (error) {
      pushOutput(error instanceof Error ? error.message : String(error));
    } finally {
      busy.value = false;
    }
  }

  /** 选中调用栈帧：变量区跟着换 */
  async function selectFrame(frameId: number): Promise<void> {
    activeFrameId.value = frameId;
    await refreshScopes(frameId);
  }

  function handleEvent(event: DapEvent): void {
    const body = (event.body ?? {}) as Record<string, unknown>;
    switch (event.event) {
      case "output":
        if (typeof body.output === "string") pushOutput(body.output);
        break;
      case "stopped":
        state.value = "paused";
        stopReason.value = typeof body.reason === "string" ? body.reason : null;
        void refreshPaused(typeof body.threadId === "number" ? body.threadId : undefined);
        break;
      case "continued":
        state.value = "running";
        stackFrames.value = [];
        variables.value = [];
        break;
      case "terminated":
      case "exited":
        state.value = "stopped";
        stackFrames.value = [];
        variables.value = [];
        break;
      case "thread":
        void fetchThreads();
        break;
      default:
        break;
    }
  }

  function noteAdapterNotice(line: string): void {
    if (line.trim()) pushOutput(line);
  }

  /** 会话日志贴进输出栏：适配器连不上时，这里是唯一能看到原因的地方 */
  async function appendSessionLog(id: string): Promise<void> {
    for (const line of await dapLogs(id)) pushOutput(line);
  }

  /** 启动链被取消：收掉适配器与挂起的目标，返回 true 表示调用方应中止 */
  async function abortIfCancelled(): Promise<boolean> {
    if (!cancelRequested) return false;
    cancelRequested = false;
    useSessionsStore().interruptLocalTerminal(targetTerminalId ?? undefined);
    await stopDapSession();
    sessionId.value = null;
    state.value = "idle";
    return true;
  }

  /**
   * 启动链（java-debug 是 jdt.ls 插件，不是 stdio 进程）：
   * 拿调试启动计划 → 确认插件已打包 → 让 jdt.ls 起 DAP 服务端拿端口 →
   * 终端起目标（suspend=y）→ 连端口 → attach → 同步断点 → configurationDone。
   * 适配器会在 configurationDone 之后自行恢复被挂起的目标，客户端不要再发 continue
   * （那会在目标已经运行时对线程 resume，报 IllegalThreadState）。
   * 30 秒连不上就打断目标并报错，不留挂死的 JVM。
   */
  async function start(id: string): Promise<boolean> {
    const workspace = useWorkspaceStore();
    const java = useJavaStore();
    if (state.value === "starting") return false;
    state.value = "starting";
    configurationId.value = id;
    output.value = [];
    stopReason.value = null;
    cancelRequested = false;

    const plan: JavaLaunchPlan | null = await java.prepareLaunch(id, true);
    if (!plan || !plan.debugPort) {
      state.value = "idle";
      return false;
    }
    debugPort.value = plan.debugPort;
    if (await abortIfCancelled()) return false;

    const adapter = await probeDapAdapter(useSettingsStore().java.adapterPath || null);
    if (!adapter) {
      state.value = "idle";
      workspace.showNotice(t("debug.notice.adapterMissing"), 6000);
      return false;
    }
    // 端口来自 JDTLS 里的 java-debug 插件：语言服务没起来就拿不到
    const dapPort = await startJavaDebugServer();
    if (!dapPort) {
      state.value = "idle";
      workspace.showNotice(t("debug.notice.adapterUnavailable"), 6000);
      return false;
    }
    if (await abortIfCancelled()) return false;

    const session = await startDapSession(dapPort, {
      onEvent: handleEvent,
      onNotice: noteAdapterNotice,
      onExit: () => {
        pushOutput(t("debug.notice.adapterExited"));
        state.value = "stopped";
        sessionId.value = null;
        if (session) void appendSessionLog(session.id);
      },
    });
    if (!session) {
      state.value = "idle";
      workspace.showNotice(t("debug.notice.adapterMissing"), 6000);
      return false;
    }
    sessionId.value = session.id;

    // 目标先起来并挂住：适配器 attach 之前它不会执行任何用户代码
    const sessions = useSessionsStore();
    sessions.runInLocalTerminal(launchCommandLine(plan, isWindowsPlatform()), plan.cwd || workspace.rootPath);
    targetTerminalId = sessions.activeLocalId;
    if (await abortIfCancelled()) return false;

    try {
      await session.client.request(
        "initialize",
        {
          clientID: "prismcode",
          clientName: "Prism Code",
          adapterID: "java",
          linesStartAt1: true,
          columnsStartAt1: true,
          pathFormat: "path",
          supportsRunInTerminalRequest: false,
        },
        DAP_INITIALIZE_TIMEOUT_MS,
      );
      if (await abortIfCancelled()) return false;
      await withTimeout(
        session.client.request("attach", { hostName: "127.0.0.1", port: plan.debugPort }),
        DAP_CONNECT_TIMEOUT_MS,
        t("debug.notice.connectTimeout"),
      );
      if (await abortIfCancelled()) return false;
      await syncAllBreakpoints(session.client);
      await session.client.request("configurationDone", {});
      state.value = "running";
      void fetchThreads();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 连不上时目标还挂在 suspend=y 上：先打断它，别留下卡死的 JVM
      sessions.interruptLocalTerminal(targetTerminalId ?? undefined);
      await appendSessionLog(session.id);
      await stopDapSession();
      sessionId.value = null;
      state.value = "idle";
      workspace.showNotice(message, 6000);
      return false;
    }
  }

  async function control(command: string, args: unknown = {}): Promise<void> {
    const client = currentDapClient();
    if (!client || client.isDisposed) return;
    busy.value = true;
    try {
      await client.request(command, args);
      if (command === "continue") state.value = "running";
      if (["next", "stepIn", "stepOut", "continue"].includes(command)) {
        stackFrames.value = [];
      }
    } catch (error) {
      pushOutput(error instanceof Error ? error.message : String(error));
    } finally {
      busy.value = false;
    }
  }

  async function resume(): Promise<void> {
    await control("continue", { threadId: activeThreadId.value ?? undefined });
  }

  async function pause(): Promise<void> {
    await control("pause", { threadId: activeThreadId.value ?? undefined });
  }

  async function stepOver(): Promise<void> {
    await control("next", { threadId: activeThreadId.value ?? undefined });
  }

  async function stepInto(): Promise<void> {
    await control("stepIn", { threadId: activeThreadId.value ?? undefined });
  }

  async function stepOut(): Promise<void> {
    await control("stepOut", { threadId: activeThreadId.value ?? undefined });
  }

  async function stop(): Promise<void> {
    // 启动链自己会在下一个检查点收尾；这里只登记取消，
    // 免得两处同时去停同一个会话
    if (state.value === "starting") {
      cancelRequested = true;
      return;
    }
    const client = currentDapClient();
    if (client && !client.isDisposed) {
      // disconnect 带上 terminateDebuggee：目标进程由终端持有，交给适配器收掉
      try {
        await client.request("disconnect", { terminateDebuggee: true, restart: false });
      } catch {
        // 适配器可能已经退出
      }
    }
    await stopDapSession();
    sessionId.value = null;
    targetTerminalId = null;
    state.value = "stopped";
    stackFrames.value = [];
    variables.value = [];
    scopes.value = [];
    threads.value = [];
    activeThreadId.value = null;
    activeFrameId.value = null;
  }

  /** 面板关闭时的收尾：不常驻调试器 */
  async function reset(): Promise<void> {
    await stop();
    state.value = "idle";
    output.value = [];
    breakpoints.value.clear();
    configurationId.value = null;
    debugPort.value = null;
  }

  return {
    state,
    sessionId,
    threads,
    activeThreadId,
    stackFrames,
    activeFrameId,
    scopes,
    variables,
    output,
    breakpoints,
    breakpointCount,
    stopReason,
    configurationId,
    debugPort,
    busy,
    linesFor,
    toggleBreakpoint,
    refreshPaused,
    fetchThreads,
    selectFrame,
    refreshVariables,
    start,
    resume,
    pause,
    stepOver,
    stepInto,
    stepOut,
    stop,
    reset,
  };
});

/** 给带超时的等待包一层中文错误：调试连接超时是最常见的一种失败 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: TimerHandle | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
