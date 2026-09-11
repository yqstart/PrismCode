/**
 * 应用级窗口会话索引。
 *
 * Tauri 的窗口状态插件可以恢复窗口尺寸等原生状态，但不会根据动态窗口
 * 标签重新创建窗口。因此这里另外保存「当前有哪些窗口、每个窗口打开哪个
 * 工作区」，启动时由主窗口按索引重建动态窗口。
 */

const STORAGE_KEY = "prismcode.window-sessions.v1";
const MAX_WINDOWS = 32;

export const MAIN_WINDOW_SESSION_ID = "main";

export interface WindowSessionRecord {
  id: string;
  root: string;
  updatedAt: number;
}

function validWindowId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)
  );
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function readStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function writeRecords(records: WindowSessionRecord[]): void {
  try {
    readStorage()?.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // 隐私模式 / localStorage 配额不足不应阻断窗口创建和关闭。
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

/** 动态窗口的 Tauri label；同一会话 ID 重启后复用，可同时得到原生窗口状态恢复。 */
export function windowLabel(windowId: string): string {
  return `proj-${windowId}`;
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

export function loadWindowSessions(): WindowSessionRecord[] {
  const storage = readStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    const seen = new Set<string>();
    const records: WindowSessionRecord[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const candidate = item as {
        id?: unknown;
        root?: unknown;
        updatedAt?: unknown;
      };
      if (
        !validWindowId(candidate.id) ||
        typeof candidate.root !== "string" ||
        !candidate.root.trim() ||
        seen.has(candidate.id)
      ) {
        continue;
      }
      seen.add(candidate.id);
      records.push({
        id: candidate.id,
        root: candidate.root,
        updatedAt:
          typeof candidate.updatedAt === "number" &&
          Number.isFinite(candidate.updatedAt)
            ? candidate.updatedAt
            : 0,
      });
      if (records.length >= MAX_WINDOWS) break;
    }
    return records;
  } catch {
    return [];
  }
}

/** 保存一个窗口当前的工作区；同一窗口 ID 的旧记录会被原子替换。 */
export function saveWindowSession(
  root: string,
  windowId = getWindowSessionId(),
): void {
  const normalizedRoot = normalizePath(root.trim());
  if (!normalizedRoot || !validWindowId(windowId)) return;
  const records = loadWindowSessions().filter((item) => item.id !== windowId);
  records.push({ id: windowId, root: normalizedRoot, updatedAt: Date.now() });
  writeRecords(records.slice(-MAX_WINDOWS));
}

/** 正常关闭单个窗口时移除其记录；应用整体退出时不要调用。 */
export function removeWindowSession(windowId = getWindowSessionId()): void {
  if (!validWindowId(windowId)) return;
  const records = loadWindowSessions().filter((item) => item.id !== windowId);
  writeRecords(records);
}
