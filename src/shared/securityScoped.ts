/**
 * macOS security-scoped bookmark 持久化
 *
 * 痛点：自动更新替换 bundle 后，新进程 ID 不同，macOS TCC 会撤销之前 NSOpenPanel
 * 给的「一次性访问」授权，下次打开同一文件夹再问一次。
 *
 * 解决：用户首次 NSOpenPanel 选工作区后，把该路径写为 security-scoped bookmark 存到
 * localStorage；下次启动时调 Rust 端 `resolve_security_scoped_bookmarks` 把 NSURL
 * 还原并 `startAccessingSecurityScopedResource()`，让接下来的 listDir / readFile
 * 不再被 TCC 弹问。
 *
 * 非 macOS 平台调用全部 no-op（命令在 Rust 端是桩），不影响 Windows / Linux。
 */

import { invoke } from "@tauri-apps/api/core";

const STORE_KEY = "prismcode.securityScopedBookmarks.v1";

/** 从 localStorage 读出 path -> bookmark 映射（仅 macOS 有用） */
function loadStore(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

function saveStore(map: Record<string, string>): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(map));
  } catch {
    // 满 / 隐私模式
  }
}

/** 把用户授权过的路径写为 bookmark（macOS 专用，其他平台 no-op） */
export async function saveBookmark(path: string): Promise<void> {
  try {
    const bookmark = await invoke<string | null>("create_security_scoped_bookmarks", { path });
    if (bookmark) {
      const map = loadStore();
      map[path] = bookmark;
      saveStore(map);
    }
  } catch {
    // 写失败忽略，下次启动再问一次
  }
}

/** 启动时把路径对应的 bookmark resolve 并激活，失败返回 false（用户需重新授权） */
export async function resolveBookmark(path: string): Promise<boolean> {
  const map = loadStore();
  const bookmark = map[path];
  if (!bookmark) return false;
  try {
    return await invoke<boolean>("resolve_security_scoped_bookmarks", { path, bookmark });
  } catch {
    // bookmark 失效（用户移到别的目录 / 改名），清掉
    delete map[path];
    saveStore(map);
    return false;
  }
}

/** 删除某路径的 bookmark（工作区关闭 / 用户主动移除） */
export function dropBookmark(path: string): void {
  const map = loadStore();
  delete map[path];
  saveStore(map);
}
