import { invoke } from "@tauri-apps/api/core";

export interface DirEntryInfo {
  name: string;
  path: string;
  isDir: boolean;
}

export async function listDir(
  root: string,
  path: string,
  extraIgnores: string[] = [],
): Promise<DirEntryInfo[]> {
  return invoke("list_dir", { root, path, extraIgnores });
}

export async function readTextFile(root: string, path: string): Promise<string> {
  return invoke("read_text_file", { root, path });
}

export async function writeTextFile(
  root: string,
  path: string,
  content: string,
): Promise<void> {
  return invoke("write_text_file", { root, path, content });
}

export async function createEntry(
  root: string,
  path: string,
  isDir: boolean,
): Promise<void> {
  return invoke("create_entry", { root, path, isDir });
}

export async function renameEntry(
  root: string,
  from: string,
  to: string,
): Promise<void> {
  return invoke("rename_entry", { root, from, to });
}

export async function deleteEntry(root: string, path: string): Promise<void> {
  return invoke("delete_entry", { root, path });
}

export async function copyEntry(
  root: string,
  from: string,
  to: string,
): Promise<void> {
  return invoke("copy_entry", { root, from, to });
}

export async function pathExists(root: string, path: string): Promise<boolean> {
  return invoke("path_exists", { root, path });
}

/**
 * 复制/粘贴命名冲突时的 `-copyN` 候选名。
 * 内部粘贴与外部粘贴两条链路共用同一规则，自测锁定，改一处必须两处生效。
 */
export function nextCopyName(name: string, n: number): string {
  return name.includes(".")
    ? name.replace(/(\.[^.]+)?$/, "-copy" + n + "$1")
    : `${name}-copy${n}`;
}

/**
 * 读系统剪贴板中的文件路径列表（Finder / 资源管理器复制的文件）。
 * 无文件时返回空数组；Linux 等未实现平台同样返回空数组。
 */
export async function readSystemClipboardFiles(): Promise<string[]> {
  return invoke("read_system_clipboard_files");
}

/** 把工作区外的文件/目录复制进工作区（源为绝对路径，不受工作区边界限制）。 */
export async function copyExternalEntry(
  root: string,
  from: string,
  to: string,
): Promise<void> {
  return invoke("copy_external_entries", { root, from, to });
}

export function joinPath(parent: string, name: string): string {
  if (parent.endsWith("/") || parent.endsWith("\\")) {
    return `${parent}${name}`;
  }
  const sep = parent.includes("\\") ? "\\" : "/";
  return `${parent}${sep}${name}`;
}

export function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function dirname(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const idx = path.lastIndexOf(sep);
  if (idx <= 0) return path;
  return path.slice(0, idx);
}

/** 相对工作区根的路径；根自身返回 `.` */
export function relativeToRoot(root: string, absPath: string): string {
  const normRoot = root.replace(/[/\\]+$/, "");
  if (absPath === normRoot) return ".";
  const prefixSlash = `${normRoot}/`;
  const prefixBack = `${normRoot}\\`;
  if (absPath.startsWith(prefixSlash)) return absPath.slice(prefixSlash.length);
  if (absPath.startsWith(prefixBack)) return absPath.slice(prefixBack.length);
  return absPath;
}

/** 将仓库相对路径转为绝对路径；已是绝对路径则原样返回 */
export function toAbsolutePath(root: string, path: string): string {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return joinPath(root, path);
}

/** 计算 from 目录到 to 路径的相对 import 路径（使用 `/` 分隔） */
export function relativePath(fromDir: string, toAbs: string): string {
  const split = (p: string) =>
    p.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
  const fromParts = split(fromDir);
  const toParts = split(toAbs);
  let i = 0;
  while (
    i < fromParts.length &&
    i < toParts.length &&
    fromParts[i].toLowerCase() === toParts[i].toLowerCase()
  ) {
    i += 1;
  }
  const ups = fromParts.length - i;
  const down = toParts.slice(i);
  const parts = [...Array(Math.max(0, ups)).fill(".."), ...down];
  return parts.length ? parts.join("/") : ".";
}

export function normalizeAbsPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * 将相对片段（含 `./` `../`）解析为干净绝对路径，结果中不含 `.`/`..` 组件。
 * 后端 path_exists 会拒绝含 `..` 的路径，import 跳转必须先规范化。
 */
export function resolveRelativePath(fromDir: string, spec: string): string {
  const base = normalizeAbsPath(fromDir);
  const parts = base ? base.split("/") : [];
  // 保留开头的空段（Unix 根）或 Windows 盘符
  for (const seg of spec.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  if (!parts.length) return "/";
  if (parts[0] === "") return `/${parts.slice(1).join("/")}`;
  return parts.join("/");
}

/**
 * 路径别名解析：将 `@/foo` 等别名 spec 映射为工作区内的绝对路径。
 * 默认对齐本项目 tsconfig：`baseUrl: "."` + `paths: { "@/*": ["src/*"] }`，
 * 即 `@/foo` → `<root>/src/foo`。别名前缀（`@`）与映射根（默认 `src`）可配置。
 * 非别名 spec 原样返回 null。
 */
export function resolveAliasPath(
  root: string,
  spec: string,
  options?: { prefix?: string; baseDir?: string },
): string | null {
  const prefix = options?.prefix ?? "@";
  const baseDir = options?.baseDir ?? "src";
  const head = `${prefix}/`;
  if (!spec.startsWith(head)) return null;
  const rest = spec.slice(head.length);
  if (!rest) return null;
  const rootClean = root.replace(/[/\\]+$/, "");
  // 有的项目把 baseDir 直接设为项目根（如 `./`），此处兼容空串与 `.`
  if (!baseDir || baseDir === "." || baseDir === "./") {
    return `${rootClean}/${rest}`;
  }
  const bd = baseDir.replace(/^\.\//, "").replace(/[/\\]+$/, "");
  return `${rootClean}/${bd}/${rest}`;
}

/** to 是否在 prefix 目录下（含自身） */
export function isPathUnder(prefix: string, target: string): boolean {
  const p = normalizeAbsPath(prefix);
  const t = normalizeAbsPath(target);
  return t === p || t.startsWith(`${p}/`);
}

export function languageFromPath(path: string): string {
  const name = basename(path).toLowerCase();
  if (name.endsWith(".vue")) return "Vue";
  if (name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".mts") || name.endsWith(".cts")) {
    return "TypeScript";
  }
  if (name.endsWith(".js") || name.endsWith(".jsx") || name.endsWith(".mjs") || name.endsWith(".cjs")) {
    return "JavaScript";
  }
  if (name.endsWith(".json")) return "JSON";
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "Markdown";
  if (name.endsWith(".html") || name.endsWith(".htm")) return "HTML";
  if (name.endsWith(".css")) return "CSS";
  if (name.endsWith(".scss") || name.endsWith(".sass")) return "Sass";
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return "YAML";
  if (name.endsWith(".xml")) return "XML";
  if (name.endsWith(".svg")) return "SVG";
  if (
    name.endsWith(".png") ||
    name.endsWith(".jpg") ||
    name.endsWith(".jpeg") ||
    name.endsWith(".gif") ||
    name.endsWith(".webp") ||
    name.endsWith(".bmp") ||
    name.endsWith(".ico") ||
    name.endsWith(".avif") ||
    name.endsWith(".tif") ||
    name.endsWith(".tiff")
  ) {
    return "Image";
  }
  if (name === ".env" || name.startsWith(".env.")) return "Env";
  return "Plain Text";
}
