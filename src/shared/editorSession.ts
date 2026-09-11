/**
 * 编辑器会话恢复。
 *
 * 按窗口 + 工作区根目录隔离数据，不把会话内容混进应用设置。干净标签只
 * 保存路径/光标/固定状态；有未保存改动的标签额外保存恢复所需的缓冲区快照，
 * 让重启后的恢复行为接近 VS Code 的 hot exit，同时不保存完整项目文件。
 */

import { getWindowSessionId, MAIN_WINDOW_SESSION_ID } from "./windowSession.ts";

const STORAGE_PREFIX = "prismcode.editor-session.v3:";
const LEGACY_STORAGE_PREFIX = "mirocode.editor-session.v2:";
const MAX_TABS = 60;
const MAX_RECENT_PATHS = 50;
const MAX_DIRTY_TABS = 12;
const MAX_CONTENT_CHARS = 1_000_000;
/** localStorage 配额预算（UTF-16 code unit，中文 1 字 = 1 单元）：
 *  WebKit 配额约 5MB，留约 0.5MB 余量给设置/评审状态等其它 key。 */
const QUOTA_BUDGET_CHARS = 4_500_000;

export interface EditorSessionTab {
  path: string;
  cursor: { line: number; column: number };
  pinned: boolean;
  dirty?: boolean;
  content?: string;
  original?: string;
}

export interface EditorSession {
  tabs: EditorSessionTab[];
  activePath: string | null;
  recentPaths?: string[];
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isPathInRoot(root: string, path: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  if (!normalizedRoot || !normalizedPath) return false;
  const rootKey = normalizedRoot.toLowerCase();
  const pathKey = normalizedPath.toLowerCase();
  return pathKey === rootKey || pathKey.startsWith(`${rootKey}/`);
}

function storageKey(root: string, windowId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(windowId)}:${encodeURIComponent(normalizePath(root))}`;
}

function legacyStorageKey(root: string): string {
  return `${LEGACY_STORAGE_PREFIX}${normalizePath(root)}`;
}

function validCursor(value: unknown): value is { line: number; column: number } {
  if (!value || typeof value !== "object") return false;
  const cursor = value as { line?: unknown; column?: unknown };
  return (
    typeof cursor.line === "number" &&
    Number.isFinite(cursor.line) &&
    cursor.line >= 1 &&
    typeof cursor.column === "number" &&
    Number.isFinite(cursor.column) &&
    cursor.column >= 1
  );
}

function parseSession(raw: string, root: string): EditorSession | null {
  try {
    const parsed = JSON.parse(raw) as {
      tabs?: unknown;
      activePath?: unknown;
      recentPaths?: unknown;
    };
    if (!Array.isArray(parsed.tabs)) return null;

    const tabs: EditorSessionTab[] = [];
    for (const item of parsed.tabs.slice(0, MAX_TABS)) {
      if (!item || typeof item !== "object") continue;
      const candidate = item as Partial<EditorSessionTab>;
      if (
        typeof candidate.path !== "string" ||
        !isPathInRoot(root, candidate.path) ||
        !validCursor(candidate.cursor)
      ) {
        continue;
      }
      const recovered: EditorSessionTab = {
        path: candidate.path,
        cursor: {
          line: Math.max(1, Math.floor(candidate.cursor.line)),
          column: Math.max(1, Math.floor(candidate.cursor.column)),
        },
        pinned: candidate.pinned === true,
      };
      if (
        candidate.dirty === true &&
        typeof candidate.content === "string" &&
        typeof candidate.original === "string" &&
        candidate.content.length <= MAX_CONTENT_CHARS &&
        candidate.original.length <= MAX_CONTENT_CHARS
      ) {
        recovered.dirty = true;
        recovered.content = candidate.content;
        recovered.original = candidate.original;
      }
      tabs.push(recovered);
    }

    const activePath =
      typeof parsed.activePath === "string" &&
      tabs.some((tab) => tab.path === parsed.activePath)
        ? parsed.activePath
        : tabs[0]?.path ?? null;
    const recentCandidates = Array.isArray(parsed.recentPaths)
      ? parsed.recentPaths
      : [activePath, ...tabs.map((tab) => tab.path)];
    const recentPaths = [
      ...new Set(
        recentCandidates.filter(
          (path): path is string =>
            typeof path === "string" && isPathInRoot(root, path),
        ),
      ),
    ].slice(0, MAX_RECENT_PATHS);
    return { tabs, activePath, recentPaths };
  } catch {
    return null;
  }
}

export function loadEditorSession(
  root: string,
  windowId = getWindowSessionId(),
): EditorSession | null {
  if (!root) return null;
  try {
    const raw =
      localStorage.getItem(storageKey(root, windowId)) ??
      (windowId === MAIN_WINDOW_SESSION_ID
        ? localStorage.getItem(legacyStorageKey(root))
        : null);
    return raw ? parseSession(raw, root) : null;
  } catch {
    return null;
  }
}

/**
 * 构建会话 payload。withSnapshots=false 时丢弃未保存内容快照，
 * 只保留路径/光标/固定状态（降级形态）。
 */
function buildSessionPayload(
  session: EditorSession,
  withSnapshots: boolean,
): EditorSession | null {
  const dirtyPaths = new Set(
    withSnapshots
      ? session.tabs
          .filter((tab) => tab.dirty)
          .slice(0, MAX_DIRTY_TABS)
          .map((tab) => tab.path)
      : [],
  );
  const tabs = session.tabs.slice(0, MAX_TABS).map((tab) => {
    const saved: EditorSessionTab = {
      path: tab.path,
      cursor: {
        line: Math.max(1, Math.floor(tab.cursor.line)),
        column: Math.max(1, Math.floor(tab.cursor.column)),
      },
      pinned: tab.pinned === true,
    };
    if (
      withSnapshots &&
      dirtyPaths.has(tab.path) &&
      typeof tab.content === "string" &&
      typeof tab.original === "string" &&
      tab.content.length <= MAX_CONTENT_CHARS &&
      tab.original.length <= MAX_CONTENT_CHARS
    ) {
      saved.dirty = true;
      saved.content = tab.content;
      saved.original = tab.original;
    }
    return saved;
  });
  return {
    tabs,
    activePath: tabs.some((tab) => tab.path === session.activePath)
      ? session.activePath
      : tabs[0]?.path ?? null,
    recentPaths: [...new Set(session.recentPaths ?? [])].slice(0, MAX_RECENT_PATHS),
  };
}

/** 序列化并在预算内写入；超预算或写入失败返回 false（不抛）。 */
function trySetItem(key: string, payload: EditorSession): boolean {
  try {
    const raw = JSON.stringify(payload);
    if (raw.length > QUOTA_BUDGET_CHARS) return false;
    localStorage.setItem(key, raw);
    return true;
  } catch {
    return false;
  }
}

export function saveEditorSession(
  root: string,
  session: EditorSession,
  windowId = getWindowSessionId(),
): void {
  if (!root) return;
  const key = storageKey(root, windowId);

  // 完整形态（含未保存快照）：先尝试，超预算/配额直接进入降级。
  const full = buildSessionPayload(session, true);
  if (full && trySetItem(key, full)) return;

  // 降级 1：丢弃未保存快照（干净标签的路径/光标/固定状态仍保留）。
  const degraded = buildSessionPayload(session, false);
  if (degraded && trySetItem(key, degraded)) return;

  // 降级 2：快照超限仍放不下时，按档位裁剪标签数量（保底 1 个）。
  for (const ratio of [0.5, 0.25, 0.125]) {
    const limit = Math.max(1, Math.floor(session.tabs.length * ratio));
    const trimmed = buildSessionPayload(
      {
        tabs: session.tabs.slice(0, limit),
        activePath: session.activePath,
        recentPaths: session.recentPaths,
      },
      false,
    );
    if (trimmed && trySetItem(key, trimmed)) return;
  }

  // 全部失败：显式告警（隐私模式 / 极端配额），不再静默。
  console.warn("[editorSession] 会话保存失败：localStorage 容量不足，本次崩溃恢复快照已丢失");
}
