// ==================== Java 语言服务会话 ====================
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { t } from "@/i18n";
import { monaco } from "@/features/editor/monaco/setup";
import { LspClient } from "@/features/editor/lsp/client";
import { createTauriLspTransport, type LspTransport } from "@/features/editor/lsp/transport";
import {
  toMonacoMarker,
  toMonacoRange,
  type LspTextEdit,
  type LspWorkspaceEdit,
  uriToPath,
  pathToUri,
} from "@/features/editor/lsp/convert";
import {
  applyLspTextEdits,
  DidOpenQueue,
  INITIALIZE_TIMEOUT_MS,
  JAVA_LANGUAGE_ID,
  SERVICE_READY_ABSOLUTE_TIMEOUT_MS,
  SERVICE_READY_IDLE_TIMEOUT_MS,
  SHUTDOWN_TIMEOUT_MS,
  clientCapabilities,
  initializationOptions,
  isJavaWatchedPath,
  isServiceReady,
  javaConfigurationForSection,
  javaSettings,
  progressFromStatus,
  toDidChangeParams,
  workspaceEditBlockReason,
} from "@/features/java/jdtls";
import { fileScopeRoot } from "@/shared/fileScope";
import { readTextFile, writeTextFile } from "@/shared/fs";
import { useEditorStore } from "@/stores/editor";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";

export interface JavaStatus {
  state: "stopped" | "starting" | "initializing" | "ready" | "error";
  message?: string;
  percentage?: number;
  detail?: string;
}

export const javaStatus = ref<JavaStatus>({ state: "stopped" });

interface JavaSession {
  id: string;
  client: LspClient;
  transport: LspTransport;
  ready: boolean;
}

let session: JavaSession | null = null;
let starting: Promise<boolean> | null = null;
let readyWait: {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  touch: () => void;
  cancel: () => void;
} | null = null;
const openQueue = new DidOpenQueue();
const openedUris = new Set<string>();
const progressTokens = new Set<string>();
let documentsInstalled = false;
let idleInstalled = false;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let watchTimer: ReturnType<typeof setTimeout> | undefined;
let pendingWatch = new Set<string>();

function patchStatus(patch: Partial<JavaStatus>): void {
  javaStatus.value = { ...javaStatus.value, ...patch };
}

export function currentJavaClient(): LspClient | null {
  return session?.client ?? null;
}

export function currentJavaSessionId(): string | null {
  return session?.id ?? null;
}

function modelUri(model: { uri: { toString(): string; scheme: string } }): string {
  return model.uri.toString();
}

function hasOpenJavaFile(): boolean {
  return monaco.editor.getModels().some(
    (model) => model.getLanguageId() === JAVA_LANGUAGE_ID && model.uri.scheme === "file",
  );
}

function windowInactive(): boolean {
  return document.visibilityState === "hidden" || !document.hasFocus();
}

function armIdleStop(): void {
  if (idleTimer !== undefined) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  const minutes = useSettingsStore().java.idleStopMinutes;
  if (!minutes || minutes <= 0) return;
  if (!session || hasOpenJavaFile() || !windowInactive()) return;
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    if (session && !hasOpenJavaFile() && windowInactive()) void stopJavaSession();
  }, minutes * 60_000);
}

function installIdleStop(): void {
  if (idleInstalled || typeof window === "undefined") return;
  idleInstalled = true;
  window.addEventListener("blur", armIdleStop);
  window.addEventListener("focus", () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  });
  document.addEventListener("visibilitychange", armIdleStop);
}

function snapshotOpen(model: monaco.editor.ITextModel) {
  return {
    uri: modelUri(model),
    languageId: JAVA_LANGUAGE_ID,
    version: model.getVersionId(),
    text: model.getValue(),
  };
}

function sendOpen(model: monaco.editor.ITextModel): void {
  const item = snapshotOpen(model);
  if (!session?.ready) {
    openQueue.push(item);
    return;
  }
  session.client.notify("textDocument/didOpen", { textDocument: item });
}

function installDocumentSync(): void {
  if (documentsInstalled) return;
  documentsInstalled = true;
  monaco.editor.onDidCreateModel((model) => bindJavaModel(model));
  for (const model of monaco.editor.getModels()) bindJavaModel(model);
}

function bindJavaModel(model: monaco.editor.ITextModel): void {
  if (model.getLanguageId() !== JAVA_LANGUAGE_ID || model.isDisposed()) return;
  const uri = modelUri(model);
  if (openedUris.has(uri)) return;
  openedUris.add(uri);
  const contentSub = model.onDidChangeContent((event) => {
    if (!session?.ready) {
      openQueue.push(snapshotOpen(model));
      return;
    }
    session.client.notify(
      "textDocument/didChange",
      toDidChangeParams(uri, model.getVersionId(), event.changes),
    );
  });
  model.onWillDispose(() => {
    contentSub.dispose();
    openedUris.delete(uri);
    openQueue.remove(uri);
    monaco.editor.setModelMarkers(model, "java", []);
    if (session?.ready) {
      session.client.notify("textDocument/didClose", { textDocument: { uri } });
    }
    armIdleStop();
  });
  sendOpen(model);
}

function beginReadyWait() {
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let idleTimerId: ReturnType<typeof setTimeout> | undefined;
  const absoluteTimer = setTimeout(() => {
    rejectReady(new Error("Java 语言服务启动超时"));
  }, SERVICE_READY_ABSOLUTE_TIMEOUT_MS);
  const touch = () => {
    if (idleTimerId !== undefined) clearTimeout(idleTimerId);
    idleTimerId = setTimeout(() => {
      rejectReady(new Error("Java 语言服务无响应"));
    }, SERVICE_READY_IDLE_TIMEOUT_MS);
  };
  touch();
  const cancel = () => {
    if (idleTimerId !== undefined) clearTimeout(idleTimerId);
    clearTimeout(absoluteTimer);
  };
  readyWait = { promise, resolve: resolveReady, reject: rejectReady, touch, cancel };
  return readyWait;
}

function clearJavaMarkers(): void {
  for (const model of monaco.editor.getModels()) {
    monaco.editor.setModelMarkers(model, "java", []);
  }
}

function publishDiagnostics(params: unknown): void {
  if (!params || typeof params !== "object") return;
  const value = params as { uri?: string; diagnostics?: unknown[] };
  if (!value.uri) return;
  const model = monaco.editor.getModel(monaco.Uri.parse(value.uri));
  if (!model) return;
  const markers = (value.diagnostics ?? [])
    .filter((item): item is Parameters<typeof toMonacoMarker>[0] => Boolean(item && typeof item === "object"))
    .map((item) => toMonacoMarker(item));
  monaco.editor.setModelMarkers(model, "java", markers);
}

function textEditsByUri(edit: LspWorkspaceEdit): Map<string, LspTextEdit[]> {
  const grouped = new Map<string, LspTextEdit[]>();
  const add = (uri: string, edits: LspTextEdit[]) => {
    grouped.set(uri, [...(grouped.get(uri) ?? []), ...edits]);
  };
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) add(uri, edits);
  for (const change of edit.documentChanges ?? []) {
    if (!change || typeof change !== "object" || !("textDocument" in change)) continue;
    const documentChange = change as { textDocument?: { uri?: string }; edits?: LspTextEdit[] };
    if (documentChange.textDocument?.uri) add(documentChange.textDocument.uri, documentChange.edits ?? []);
  }
  return grouped;
}

export async function applyWorkspaceEdit(
  edit: unknown,
): Promise<{ applied: boolean; failureReason?: string }> {
  const reason = workspaceEditBlockReason(edit);
  if (reason) return { applied: false, failureReason: reason };
  const editor = useEditorStore();
  const workspace = useWorkspaceStore();
  try {
    for (const [uri, edits] of textEditsByUri(edit as LspWorkspaceEdit)) {
      if (!uri.startsWith("file:")) {
        return { applied: false, failureReason: "暂不应用非文件编辑" };
      }
      const path = uriToPath(uri);
      const model =
        monaco.editor.getModel(monaco.Uri.parse(uri)) ??
        monaco.editor.getModel(monaco.Uri.file(path));
      if (model) {
        model.pushEditOperations(
          [],
          edits.map((item) => ({ range: toMonacoRange(item.range), text: item.newText })),
          () => null,
        );
        editor.markExternalUpdate(path);
        editor.setContent(path, model.getValue());
        continue;
      }
      const tab = editor.tabs.find((item) => item.path === path);
      if (tab) {
        const next = applyLspTextEdits(tab.content, edits);
        editor.markExternalUpdate(path);
        editor.setContent(path, next);
        continue;
      }
      const scope = fileScopeRoot(workspace.rootPath, path);
      if (!scope) return { applied: false, failureReason: "文件不在工作区" };
      const disk = await readTextFile(scope, path);
      workspace.markSelfWrite(path);
      await writeTextFile(scope, path, applyLspTextEdits(disk, edits));
    }
    return { applied: true };
  } catch (error) {
    return {
      applied: false,
      failureReason: error instanceof Error ? error.message : String(error),
    };
  }
}

function onServerRequest(method: string, params: unknown): Promise<unknown> {
  if (method === "workspace/configuration") {
    const items = (params as { items?: Array<{ section?: string | null }> } | null)?.items ?? [];
    return Promise.resolve(items.map((item) => javaConfigurationForSection(item.section ?? null)));
  }
  if (method === "client/registerCapability" || method === "client/unregisterCapability") {
    return Promise.resolve(null);
  }
  if (method === "window/workDoneProgress/create") {
    const token = (params as { token?: string | number } | null)?.token;
    if (token !== undefined) progressTokens.add(String(token));
    return Promise.resolve(null);
  }
  if (method === "workspace/applyEdit") {
    return applyWorkspaceEdit((params as { edit?: unknown } | null)?.edit);
  }
  if (method === "window/showMessageRequest") return Promise.resolve(null);
  return Promise.reject(new Error("Method not found"));
}

function onNotification(method: string, params: unknown): void {
  if (method === "window/showMessage") {
    const message = (params as { message?: string } | null)?.message;
    if (message) useWorkspaceStore().showNotice(message, 4000);
    return;
  }
  if (method === "textDocument/publishDiagnostics") {
    publishDiagnostics(params);
    return;
  }
  if (method === "language/status") {
    const progress = progressFromStatus(params);
    if (progress) {
      patchStatus({
        message: progress.message ?? javaStatus.value.message,
        percentage: progress.percentage,
      });
    }
    readyWait?.touch();
    if (isServiceReady(params)) readyWait?.resolve();
    return;
  }
  if (method === "$/progress") {
    const token = (params as { token?: string | number } | null)?.token;
    if (token === undefined || !progressTokens.has(String(token))) return;
    const progress = progressFromStatus(params);
    if (!progress) return;
    patchStatus({
      message: progress.message ?? javaStatus.value.message,
      percentage: progress.percentage ?? javaStatus.value.percentage,
    });
    readyWait?.touch();
  }
}

async function startJavaSession(): Promise<boolean> {
  const settings = useSettingsStore();
  const workspace = useWorkspaceStore();
  if (!settings.java.enabled) return false;
  const root = workspace.rootPath;
  if (!root) return false;
  installDocumentSync();
  installIdleStop();
  patchStatus({ state: "starting", message: t("java.status.starting"), detail: undefined });
  let plan: {
    program: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    workspaceKey: string;
  };
  try {
    await invoke("java_probe_runtime", {
      jrePath: settings.java.jrePath || null,
      jdtlsPath: settings.java.jdtlsPath || null,
    });
    plan = await invoke("java_launch_plan", {
      root,
      heapMb: settings.java.serverMemoryMb,
      jrePath: settings.java.jrePath || null,
      jdtlsPath: settings.java.jdtlsPath || null,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    patchStatus({ state: "error", detail, message: t("java.status.error") });
    workspace.showNotice(t("java.notice.runtimeMissing", { detail }), 4200);
    return false;
  }

  const sessionId = `java-${plan.workspaceKey.slice(0, 16)}`;
  const wait = beginReadyWait();
  const transport = createTauriLspTransport(sessionId, {
    onMessage: (raw) => session?.client.handleMessage(raw),
    onStderr: () => {},
    onExit: () => {
      if (session?.id === sessionId) {
        session = null;
        patchStatus({ state: "stopped", message: t("java.status.stopped") });
      }
    },
  });
  const client = new LspClient({
    transport,
    onNotification,
    onServerRequest,
    onExit: () => {},
  });
  session = { id: sessionId, client, transport, ready: false };
  try {
    await invoke("lsp_start", {
      sessionId,
      program: plan.program,
      args: plan.args,
      cwd: plan.cwd,
      env: plan.env,
    });
    const rootUri = pathToUri(root);
    await client.request(
      "initialize",
      {
        processId: null,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: root.split(/[/\\]/).pop() || root }],
        initializationOptions: initializationOptions(),
        capabilities: clientCapabilities(),
      },
      INITIALIZE_TIMEOUT_MS,
    );
    client.notify("initialized", {});
    client.notify("workspace/didChangeConfiguration", { settings: javaSettings() });
    patchStatus({ state: "initializing", message: t("java.status.initializing") });
    await wait.promise;
    wait.cancel();
    readyWait = null;
    if (session) session.ready = true;
    for (const item of openQueue.drain()) {
      client.notify("textDocument/didOpen", { textDocument: item });
    }
    patchStatus({ state: "ready", message: t("java.status.ready"), percentage: undefined });
    return true;
  } catch (error) {
    wait.cancel();
    readyWait = null;
    const detail = error instanceof Error ? error.message : String(error);
    patchStatus({ state: "error", detail, message: detail });
    await stopJavaSession();
    patchStatus({ state: "error", detail, message: detail });
    return false;
  }
}

export function ensureJavaSession(_reason: "file-open" | "manual"): Promise<boolean> {
  if (!useSettingsStore().java.enabled) return Promise.resolve(false);
  if (session?.ready) return Promise.resolve(true);
  if (starting) return starting;
  starting = startJavaSession().finally(() => {
    starting = null;
  });
  return starting;
}

export async function stopJavaSession(): Promise<void> {
  if (idleTimer !== undefined) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  readyWait?.cancel();
  readyWait?.reject(new Error("Java 语言服务已停止"));
  readyWait = null;
  const current = session;
  session = null;
  openQueue.drain();
  openedUris.clear();
  progressTokens.clear();
  clearJavaMarkers();
  patchStatus({ state: "stopped", message: t("java.status.stopped"), percentage: undefined, detail: undefined });
  if (!current) return;
  try {
    await current.client.request("shutdown", undefined, SHUTDOWN_TIMEOUT_MS);
  } catch {
    // 进程可能已经退出，停止命令仍然要发出。
  }
  current.client.notify("exit");
  current.client.dispose();
  await current.transport.close();
  try {
    await invoke("lsp_stop", { sessionId: current.id });
  } catch {
    // 会话不存在时后端返回成功；其它失败不再抛给设置按钮。
  }
}

export function notifyJavaDidSave(path: string): void {
  if (!session?.ready || !path.toLowerCase().endsWith(".java")) return;
  session.client.notify("textDocument/didSave", { textDocument: { uri: pathToUri(path) } });
}

export function notifyJavaWatchedFiles(paths: readonly string[]): void {
  if (!session?.ready || !paths.length) return;
  const root = useWorkspaceStore().rootPath;
  if (!root) return;
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  for (const path of paths) {
    const normalized = path.replace(/\\/g, "/");
    const relative = normalized.startsWith(`${normalizedRoot}/`)
      ? normalized.slice(normalizedRoot.length + 1)
      : normalized;
    if (isJavaWatchedPath(relative)) pendingWatch.add(pathToUri(normalized));
  }
  if (!pendingWatch.size) return;
  if (watchTimer !== undefined) clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    watchTimer = undefined;
    const changes = [...pendingWatch].map((uri) => ({ uri, type: 2 }));
    pendingWatch = new Set();
    session?.client.notify("workspace/didChangeWatchedFiles", { changes });
  }, 350);
}

export async function formatJavaText(path: string, content: string): Promise<string> {
  const ready = await ensureJavaSession("file-open");
  const client = currentJavaClient();
  if (!ready || !client) throw new Error("Java 语言服务未就绪");
  const uri = path.startsWith("jdt:") ? path : pathToUri(path);
  const edits = (await client.request("textDocument/formatting", {
    textDocument: { uri },
    options: { tabSize: 4, insertSpaces: true },
  })) as LspTextEdit[] | null;
  if (!edits?.length) return content;
  return applyLspTextEdits(content, edits);
}
