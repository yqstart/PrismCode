/**
 * 外部打开路由（纯函数 + 本地透传，与 Tauri / 别名无关）。
 *
 * 主窗口收到 Rust 端 `app://open-external` 事件后，不再直接把外部文件塞进
 * 当前工作区，而是先用 `planExternalOpen` 按工作区归属分流：
 * - 已在当前工作区内的文件：留在本窗口打开定位；
 * - 工作区外的文件：按父目录分组，每组新开一个窗口展示；
 * - 目录：与当前工作区相同则忽略，不同则新开窗口；
 * - 无工作区（欢迎页）时：首个文件组（或首个目录）留给本窗口，其余新开。
 *
 * 新窗口的文件透传走 localStorage（各窗口同源共享），随窗口创建写入、
 * 新窗口启动时一次性取走，避免 URL 编码长路径。
 */

import type { ExternalOpenTarget } from "./externalOpen.ts";

export interface NewWindowFileGroup {
  folder: string;
  targets: ExternalOpenTarget[];
}

export interface ExternalOpenPlan {
  inCurrentDirs: ExternalOpenTarget[];
  inCurrentFiles: ExternalOpenTarget[];
  newWindowDirs: ExternalOpenTarget[];
  newWindowGroups: NewWindowFileGroup[];
}

const BOOT_FILES_PREFIX = "prismcode.window-boot-files.v1:";

function normalizePath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

function isPathUnderRoot(root: string, target: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedTarget = normalizePath(target);
  if (normalizedRoot === "/") return normalizedTarget.startsWith("/");
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}/`)
  );
}

function isSameFolder(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

/**
 * 求父目录，与 AppShell 原逻辑保持一致：Unix 根目录文件的父目录视为 `/`。
 */
export function parentDirectory(path: string): string {
  const trimmed = path.trim();
  const sep = trimmed.includes("\\") ? "\\" : "/";
  const idx = trimmed.lastIndexOf(sep);
  if (idx <= 0) {
    if (!trimmed.includes("\\") && trimmed.startsWith("/")) return "/";
    return trimmed;
  }
  return trimmed.slice(0, idx) || "/";
}

function validTarget(target: ExternalOpenTarget): boolean {
  return Boolean(
    target &&
      typeof target.path === "string" &&
      target.path.trim() &&
      typeof target.isDir === "boolean",
  );
}

function cleanTarget(target: ExternalOpenTarget): ExternalOpenTarget {
  return { ...target, path: target.path.trim() };
}

/**
 * 按当前工作区归属把外部打开目标分流为「本窗口消费」与「新窗口消费」。
 * 返回的目标均为清洗后（去空白）的副本，调用方可直接使用。
 */
export function planExternalOpen(
  targets: readonly ExternalOpenTarget[],
  currentRoot: string | null,
): ExternalOpenPlan {
  const cleaned = targets.filter(validTarget).map(cleanTarget);
  const dirs = cleaned.filter((target) => target.isDir);
  const files = cleaned.filter((target) => !target.isDir);

  const plan: ExternalOpenPlan = {
    inCurrentDirs: [],
    inCurrentFiles: [],
    newWindowDirs: [],
    newWindowGroups: [],
  };
  const groups = new Map<string, ExternalOpenTarget[]>();
  const pushToGroup = (file: ExternalOpenTarget) => {
    const folder = parentDirectory(file.path);
    const list = groups.get(folder);
    if (list) list.push(file);
    else groups.set(folder, [file]);
  };

  const root = currentRoot?.trim() ? currentRoot.trim() : null;
  if (root) {
    for (const dir of dirs) {
      // 已在当前工作区：无需任何动作（之前会整窗切换过去，属于打扰）。
      if (isSameFolder(root, dir.path)) continue;
      plan.newWindowDirs.push(dir);
    }
    for (const file of files) {
      if (isPathUnderRoot(root, file.path)) plan.inCurrentFiles.push(file);
      else pushToGroup(file);
    }
  } else if (files.length) {
    // 无工作区时首个父目录组留给本窗口，避免一次多文件打开炸出 N 个窗口。
    const stayParent = parentDirectory(files[0]!.path);
    for (const file of files) {
      if (isSameFolder(parentDirectory(file.path), stayParent)) {
        plan.inCurrentFiles.push(file);
      } else {
        pushToGroup(file);
      }
    }
    plan.newWindowDirs.push(...dirs);
  } else if (dirs.length) {
    plan.inCurrentDirs.push(dirs[0]!);
    plan.newWindowDirs.push(...dirs.slice(1));
  }

  plan.newWindowGroups = [...groups.entries()].map(([folder, groupTargets]) => ({
    folder,
    targets: groupTargets,
  }));
  return plan;
}

function readStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function bootFilesKey(windowId: string): string {
  return `${BOOT_FILES_PREFIX}${windowId}`;
}

/** 新窗口创建前把待开文件写入，与窗口 ID 绑定。 */
export function saveBootFiles(windowId: string, targets: readonly ExternalOpenTarget[]): void {
  if (!windowId) return;
  const files = targets.filter(validTarget).map(cleanTarget);
  try {
    readStorage()?.setItem(bootFilesKey(windowId), JSON.stringify(files));
  } catch {
    // 配额不足时新窗口仅打开目录，文件可手动再开，不阻断窗口创建。
  }
}

/** 新窗口启动时一次性取走待开文件（无论解析成功与否都清理，避免残留）。 */
export function takeBootFiles(windowId: string): ExternalOpenTarget[] {
  if (!windowId) return [];
  const storage = readStorage();
  if (!storage) return [];
  let raw: string | null = null;
  try {
    raw = storage.getItem(bootFilesKey(windowId));
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    storage.removeItem(bootFilesKey(windowId));
  } catch {
    // 清理失败不影响本次打开
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as ExternalOpenTarget[]).filter(validTarget).map(cleanTarget);
  } catch {
    return [];
  }
}

/** 窗口创建失败时清理已写入的待开文件。 */
export function removeBootFiles(windowId: string): void {
  if (!windowId) return;
  try {
    readStorage()?.removeItem(bootFilesKey(windowId));
  } catch {
    // 忽略清理失败
  }
}
