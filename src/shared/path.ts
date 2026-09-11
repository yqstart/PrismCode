const RECENT_KEY = "prismcode.recentFolders.v1";
const LEGACY_RECENT_KEY = "mirocode.recentFolders.v1";

export function loadRecentFolders(): string[] {
  try {
    const raw =
      localStorage.getItem(RECENT_KEY) ?? localStorage.getItem(LEGACY_RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 写入失败（隐私模式 / 配额超限）时静默降级：最近列表仅是便利功能，
 *  不能因 localStorage 不可写而中断 openFolder 的 store 重置流程 */
function safeSetItem(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export function pushRecentFolder(path: string): string[] {
  const next = [path, ...loadRecentFolders().filter((x) => x !== path)].slice(0, 8);
  safeSetItem(RECENT_KEY, JSON.stringify(next));
  return next;
}

export function saveRecentFolders(paths: string[]): string[] {
  const next = paths.filter((x) => typeof x === "string").slice(0, 8);
  safeSetItem(RECENT_KEY, JSON.stringify(next));
  return next;
}

export function removeRecentFolder(path: string): string[] {
  return saveRecentFolders(loadRecentFolders().filter((x) => x !== path));
}

export function clearRecentFolders(): string[] {
  return saveRecentFolders([]);
}
