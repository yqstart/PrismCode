// ==================== DAP 调试会话 ====================
// 与 javaSession 同形：单例会话 + starting/readyWait 去重。
// 帧编解码在 Rust（复用 LSP 那套 Content-Length），这里只做请求关联与事件分发。
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** 适配器请求的默认超时：初始化与 attach 比普通请求慢得多 */
const DAP_REQUEST_TIMEOUT_MS = 10_000;
export const DAP_INITIALIZE_TIMEOUT_MS = 30_000;
/** 目标进程挂起等待调试器的窗口：超时就杀目标并报错，避免留一个卡住的 JVM */
export const DAP_CONNECT_TIMEOUT_MS = 30_000;

export interface DapEvent {
  event: string;
  body: unknown;
}

/** 计时器句柄：本仓库同时有 DOM 与 Node 的类型定义，形状用一处别名收口 */
type TimerHandle = ReturnType<typeof setTimeout>;

interface DapPending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: TimerHandle | undefined;
}

interface RawMessage {
  type?: string;
  seq?: number;
  request_seq?: number;
  success?: boolean;
  command?: string;
  event?: string;
  body?: unknown;
  message?: string;
}

export interface DapTransport {
  send(message: string): Promise<void>;
  close(): Promise<void>;
}

/** DAP 用 `seq` 关联请求与响应（没有 jsonrpc 的 id） */
export class DapClient {
  private nextSeq = 1;
  private readonly pending = new Map<number, DapPending>();
  private disposed = false;

  constructor(
    private readonly transport: DapTransport,
    private readonly handlers: {
      onEvent(event: DapEvent): void;
      onNotice?(line: string): void;
      onExit?(code: number | null): void;
    },
  ) { }

  async request(
    command: string,
    args: unknown = {},
    timeoutMs: number = DAP_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.disposed) throw new Error("调试会话已结束");
    const seq = this.nextSeq++;
    const payload = JSON.stringify({ seq, type: "request", command, arguments: args ?? {} });
    return new Promise<unknown>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          if (this.pending.delete(seq)) {
            reject(new Error(`调试请求超时: ${command}`));
          }
        }, timeoutMs)
        : undefined;
      this.pending.set(seq, { resolve, reject, timer });
      void this.transport.send(payload).catch((error: unknown) => {
        const entry = this.pending.get(seq);
        if (!entry) return;
        this.pending.delete(seq);
        clearTimeout(entry.timer);
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  handleMessage(raw: string): void {
    let message: RawMessage;
    try {
      message = JSON.parse(raw) as RawMessage;
    } catch {
      return;
    }
    if (message.type === "response") {
      const seq = message.request_seq;
      if (typeof seq !== "number") return;
      const entry = this.pending.get(seq);
      if (!entry) return;
      this.pending.delete(seq);
      clearTimeout(entry.timer);
      if (message.success === false) {
        entry.reject(new Error(message.message || `调试请求失败: ${message.command ?? ""}`));
        return;
      }
      entry.resolve(message.body ?? null);
      return;
    }
    if (message.type === "event" && message.event) {
      this.handlers.onEvent({ event: message.event, body: message.body ?? null });
    }
  }

  handleNotice(line: string): void {
    this.handlers.onNotice?.(line);
  }

  handleExit(code: number | null): void {
    this.disposed = true;
    for (const [seq, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("调试适配器已退出"));
      this.pending.delete(seq);
    }
    this.handlers.onExit?.(code);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const [seq, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("调试会话已结束"));
      this.pending.delete(seq);
    }
    await this.transport.close();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

/**
 * 随包分发的 java-debug 插件 jar。它不是可执行进程：由 JDTLS 通过
 * `initializationOptions.bundles` 装载，再开 TCP 端口跑 DAP。
 */
export interface DapAdapter {
  jarPath: string;
  version: string;
  root: string;
}

export interface DapSession {
  id: string;
  client: DapClient;
}

let session: DapSession | null = null;
let starting: Promise<boolean> | null = null;

export function currentDapSessionId(): string | null {
  return session?.id ?? null;
}

export function currentDapClient(): DapClient | null {
  return session?.client ?? null;
}

/**
 * 探测调试适配器：优先用设置里的 `adapterPath`，其次环境变量与随包资源。
 * 缺包时返回 null，由调用方给中文指引。
 */
export async function probeDapAdapter(adapterPath: string | null = null): Promise<DapAdapter | null> {
  try {
    const adapter = await invoke<DapAdapter | null>("dap_probe_adapter", { adapterPath });
    return adapter?.jarPath ? adapter : null;
  } catch {
    return null;
  }
}

/**
 * 连上 java-debug 开出的 DAP 端口。`port` 由 JDTLS 的
 * `vscode.java.startDebugSession` 返回（见 javaSession.startJavaDebugServer）。
 */
export async function startDapSession(
  port: number,
  handlers: {
    onEvent(event: DapEvent): void;
    onNotice?(line: string): void;
    onExit?(code: number | null): void;
  },
): Promise<DapSession | null> {
  if (session) return session;
  if (starting) {
    const ok = await starting;
    return ok ? session : null;
  }
  starting = (async () => {
    const id = await invoke<string>("dap_connect", { port });
    const unlisten: Array<Promise<UnlistenFn>> = [
      listen<string>(`dap://message/${id}`, (event) => {
        session?.client.handleMessage(event.payload);
      }),
      listen<string>(`dap://notice/${id}`, (event) => {
        session?.client.handleNotice(event.payload);
      }),
      listen<number | null>(`dap://exit/${id}`, (event) => {
        session?.client.handleExit(event.payload);
      }),
    ];
    const client = new DapClient(
      {
        send: (message) => invoke("dap_send", { sessionId: id, message }),
        close: async () => {
          const stops = await Promise.all(unlisten);
          for (const stop of stops) stop();
        },
      },
      handlers,
    );
    session = { id, client };
    return true;
  })().catch(() => false);

  const ok = await starting;
  starting = null;
  if (!ok) {
    session = null;
    return null;
  }
  return session;
}

export async function stopDapSession(): Promise<void> {
  const current = session;
  session = null;
  if (!current) return;
  try {
    await current.client.dispose();
  } catch {
    // 适配器已经退出：忽略关闭期的写入失败
  }
  try {
    await invoke("dap_stop", { sessionId: current.id });
  } catch {
    // 会话表里已经没有了：视为已停止
  }
}

/** 会话日志（连接、帧错误）：出错时贴到面板里给用户看的中文线索 */
export async function dapLogs(sessionId: string): Promise<string[]> {
  try {
    return await invoke<string[]>("dap_logs", { sessionId });
  } catch {
    return [];
  }
}
