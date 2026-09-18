/**
 * 文件读写作用域。
 *
 * 后端 `resolve_inside_workspace` 要求目标路径位于传入 root 之内。项目窗口用
 * 工作区根；light 模式（窗口未打开工作区、只承载独立文件）改用文件所在目录，
 * 让单文件打开同样能读写、格式化、走类型服务，而该目录不会因此变成项目。
 */

import { parentDirectory } from "./externalOpenRoute.ts";

/**
 * 求某文件的读写作用域根。
 * 有工作区时恒为工作区；否则用文件父目录，路径不含目录信息时返回 null。
 */
export function fileScopeRoot(
  root: string | null | undefined,
  path: string,
): string | null {
  const trimmedRoot = root?.trim();
  if (trimmedRoot) return trimmedRoot;
  const trimmedPath = path.trim();
  if (!trimmedPath) return null;
  const dir = parentDirectory(trimmedPath);
  return dir && dir !== trimmedPath ? dir : null;
}
