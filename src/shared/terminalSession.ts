/** 本地终端标签的持久化快照（PTY 进程本身不会跨应用退出保留）。 */

import { getWindowSessionId } from "./windowSession.ts";

const STORAGE_PREFIX = "prismcode.terminal-session.v1:";
const MAX_TERMINALS = 32;

export interface TerminalSessionItem {
  id: string;
  title: string;
  /** 标签标题对应的 shell 名（zsh / bash / powershell）；旧快照可能缺失，由调用方推断 */
  shell?: string;
  cwd: string | null;
}

export interface TerminalSession {
  localTerminals: TerminalSessionItem[];
  activeLocalId: string | null;
  open: boolean;
  dormant: boolean;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function storageKey(root: string, windowId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(windowId)}:${encodeURIComponent(normalizePath(root))}`;
}

function readStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function parseSession(raw: string): TerminalSession | null {
  try {
    const parsed = JSON.parse(raw) as {
      localTerminals?: unknown;
      activeLocalId?: unknown;
      open?: unknown;
      dormant?: unknown;
    };
    if (!Array.isArray(parsed.localTerminals)) return null;

    const seen = new Set<string>();
    const localTerminals: TerminalSessionItem[] = [];
    for (const item of parsed.localTerminals.slice(0, MAX_TERMINALS)) {
      if (!item || typeof item !== "object") continue;
      const candidate = item as {
        id?: unknown;
        title?: unknown;
        shell?: unknown;
        cwd?: unknown;
      };
      if (
        typeof candidate.id !== "string" ||
        !candidate.id.trim() ||
        seen.has(candidate.id) ||
        typeof candidate.title !== "string" ||
        (candidate.shell !== undefined && typeof candidate.shell !== "string") ||
        (candidate.cwd !== null && typeof candidate.cwd !== "string")
      ) {
        continue;
      }
      seen.add(candidate.id);
      localTerminals.push({
        id: candidate.id,
        title: candidate.title,
        ...(typeof candidate.shell === "string" ? { shell: candidate.shell } : {}),
        cwd: candidate.cwd,
      });
    }

    const firstId = localTerminals[0]?.id ?? null;
    const activeLocalId =
      typeof parsed.activeLocalId === "string" &&
      localTerminals.some((item) => item.id === parsed.activeLocalId)
        ? parsed.activeLocalId
        : firstId;
    const open = parsed.open === true && localTerminals.length > 0;
    return {
      localTerminals,
      activeLocalId,
      open,
      // 收起保活和展开状态互斥；异常快照按展开优先修正。
      dormant: !open && parsed.dormant === true && localTerminals.length > 0,
    };
  } catch {
    return null;
  }
}

export function loadTerminalSession(
  root: string,
  windowId = getWindowSessionId(),
): TerminalSession | null {
  if (!root) return null;
  try {
    const raw = readStorage()?.getItem(storageKey(root, windowId));
    return raw ? parseSession(raw) : null;
  } catch {
    return null;
  }
}

export function saveTerminalSession(
  root: string,
  session: TerminalSession,
  windowId = getWindowSessionId(),
): void {
  if (!root) return;
  try {
    const localTerminals = session.localTerminals
      .slice(0, MAX_TERMINALS)
      .map((item) => ({
        id: item.id,
        title: item.title,
        shell: item.shell,
        cwd: item.cwd,
      }));
    const open = session.open && localTerminals.length > 0;
    readStorage()?.setItem(
      storageKey(root, windowId),
      JSON.stringify({
        localTerminals,
        activeLocalId: localTerminals.some(
          (item) => item.id === session.activeLocalId,
        )
          ? session.activeLocalId
          : localTerminals[0]?.id ?? null,
        open,
        dormant: !open && session.dormant && localTerminals.length > 0,
      } satisfies TerminalSession),
    );
  } catch {
    // 隐私模式 / localStorage 容量不足不应阻断终端使用。
  }
}
