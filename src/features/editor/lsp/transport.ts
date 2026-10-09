// ==================== Tauri LSP 传输 ====================
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface LspTransport {
  send(message: string): Promise<void>;
  close(): Promise<void>;
}

export interface TauriLspHandlers {
  onMessage(raw: string): void;
  onStderr?(line: string): void;
  onExit?(code: number | null): void;
}

export function createTauriLspTransport(
  sessionId: string,
  handlers: TauriLspHandlers,
): LspTransport {
  const unlisten: Array<Promise<UnlistenFn>> = [
    listen<string>(`lsp://message/${sessionId}`, (event) => {
      handlers.onMessage(event.payload);
    }),
    listen<string>(`lsp://stderr/${sessionId}`, (event) => {
      handlers.onStderr?.(event.payload);
    }),
    listen<number | null>(`lsp://exit/${sessionId}`, (event) => {
      handlers.onExit?.(event.payload);
    }),
  ];

  return {
    async send(message: string) {
      await invoke("lsp_send", { sessionId, message });
    },
    async close() {
      const stops = await Promise.all(unlisten);
      for (const stop of stops) stop();
    },
  };
}
