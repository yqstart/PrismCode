/**
 * 窗口身份与主窗口工作区锚点。
 *
 * 窗口身份：主窗口没有查询参数（固定 main），「在新窗口打开」创建的动态
 * 窗口由 URL 的 `windowId` 参数标识；该 ID 用于隔离编辑器 / 终端会话快照
 * 与生成窗口 label。
 *
 * 工作区锚点：只记录主窗口最近打开的工作区，供应用重启时恢复。动态窗口
 * 不写入——重启后只打开一个主窗口，不再重建退出时的多窗口布局。
 */

// key 沿用旧版多窗口索引名：读取时只取其中的 main 记录，写入时覆盖为
// 单条主窗口记录，顺带清掉历史遗留的动态窗口记录。
const STORAGE_KEY = "prismcode.window-sessions.v1";

export const MAIN_WINDOW_SESSION_ID = "main";

function validWindowId(value: unknown): value is string {
 return (
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)
 );
}

function readStorage(): Storage | null {
 try {
  return typeof localStorage === "undefined" ? null : localStorage;
 } catch {
  return null;
 }
}

/** 读取当前 WebView 对应的稳定窗口 ID；主窗口没有查询参数，固定为 main。 */
export function getWindowSessionId(search?: string): string {
 let query = search;
 if (query === undefined) {
  try {
   query = typeof window === "undefined" ? "" : window.location.search;
  } catch {
   query = "";
  }
 }
 try {
  const id = new URLSearchParams(query).get("windowId")?.trim();
  return validWindowId(id) ? id : MAIN_WINDOW_SESSION_ID;
 } catch {
  return MAIN_WINDOW_SESSION_ID;
 }
}

export function isMainWindowSession(windowId = getWindowSessionId()): boolean {
 return windowId === MAIN_WINDOW_SESSION_ID;
}

/** 创建不会与已有窗口混淆的新会话 ID。 */
export function createWindowSessionId(): string {
 try {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === "function") {
   return `window-${randomUUID()}`;
  }
 } catch {
  // 某些旧 WebView 没有 randomUUID，使用下面的降级实现。
 }
 return `window-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 保存主窗口当前工作区；动态窗口调用是 no-op。 */
export function saveMainWindowRoot(root: string): void {
 if (!isMainWindowSession()) return;
 const normalizedRoot = root.trim().replace(/\\/g, "/").replace(/\/+$/, "");
 if (!normalizedRoot) return;
 try {
  readStorage()?.setItem(
   STORAGE_KEY,
   JSON.stringify([
    {
     id: MAIN_WINDOW_SESSION_ID,
     root: normalizedRoot,
     updatedAt: Date.now(),
    },
   ]),
  );
 } catch {
  // 隐私模式 / localStorage 配额不足不应阻断打开工作区。
 }
}

/** 主窗口最近一次打开的工作区；兼容读取旧版多窗口索引中的 main 记录。 */
export function loadMainWindowRoot(): string | null {
 const storage = readStorage();
 if (!storage) return null;
 try {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return null;
  for (const item of parsed) {
   if (!item || typeof item !== "object") continue;
   const record = item as { id?: unknown; root?: unknown };
   if (record.id !== MAIN_WINDOW_SESSION_ID) continue;
   return typeof record.root === "string" && record.root.trim()
    ? record.root.trim()
    : null;
  }
  return null;
 } catch {
  return null;
 }
}

/** 主窗口正常关闭（非应用整体退出）时清除锚点，下次启动回退最近项目。 */
export function clearMainWindowRoot(): void {
 if (!isMainWindowSession()) return;
 try {
  readStorage()?.removeItem(STORAGE_KEY);
 } catch {
  // 忽略清理失败。
 }
}
