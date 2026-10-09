// ==================== LSP 客户端（协议语义在前端） ====================
import type { LspTransport } from "./transport";

export interface LspClientOptions {
  transport: LspTransport;
  requestTimeoutMs?: number;
  onNotification(method: string, params: unknown): void;
  onServerRequest(method: string, params: unknown): Promise<unknown>;
  onExit?(code: number | null): void;
  onStderr?(line: string): void;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LspRequestError extends Error {
  code: number;
  method: string;

  constructor(code: number, method: string, message: string) {
    super(message);
    this.name = "LspRequestError";
    this.code = code;
    this.method = method;
  }
}

export class LspClient {
  private nextId = 0;
  private pending = new Map<number, PendingRequest>();
  private disposed = false;
  private readonly timeoutMs: number;
  private readonly options: LspClientOptions;

  constructor(options: LspClientOptions) {
    this.options = options;
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  request(method: string, params?: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new LspRequestError(-32800, method, "语言服务已停止"));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.notify("$/cancelRequest", { id });
        reject(new LspRequestError(-32800, method, "请求超时"));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      const body: { jsonrpc: "2.0"; id: number; method: string; params?: unknown } = {
        jsonrpc: "2.0",
        id,
        method,
      };
      if (params !== undefined) body.params = params;
      void this.options.transport.send(JSON.stringify(body)).catch((error: unknown) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) return;
    const body: { jsonrpc: "2.0"; method: string; params?: unknown } = {
      jsonrpc: "2.0",
      method,
    };
    if (params !== undefined) body.params = params;
    void this.options.transport.send(JSON.stringify(body));
  }

  handleMessage(raw: string): void {
    let message: {
      id?: number | null;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }
    const hasId = message.id !== undefined && message.id !== null;
    if (hasId && typeof message.method === "string") {
      const id = message.id as number;
      Promise.resolve()
        .then(() => this.options.onServerRequest(message.method as string, message.params))
        .then(
          (result) => {
            void this.options.transport.send(
              JSON.stringify({ jsonrpc: "2.0", id, result: result ?? null }),
            );
          },
          () => {
            void this.options.transport.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                error: { code: -32601, message: "Method not found" },
              }),
            );
          },
        );
      return;
    }
    if (hasId) {
      const pending = this.pending.get(message.id as number);
      if (!pending) return;
      this.pending.delete(message.id as number);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new LspRequestError(
            message.error.code ?? -32603,
            pending.method,
            message.error.message ?? "语言服务请求失败",
          ),
        );
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") {
      this.options.onNotification(message.method, message.params);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new LspRequestError(-32800, pending.method, "语言服务已停止"));
      this.pending.delete(id);
    }
  }
}
