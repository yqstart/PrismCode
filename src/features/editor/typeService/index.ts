// ==================== 类型服务浏览器入口（单例 + 惰性加载） ====================
// typescript 包 ~8MB 动态 import（vite 拆独立 chunk），首次 JS/TS 补全才加载；
// 加载完成前补全源返回 null → 分派链降级轻量语义层。

import { TsLanguageService, type FileContentSource, type TsModule } from "./tsService";
import { fileScopeRoot } from "@/shared/fileScope";

let tsPromise: Promise<TsModule> | null = null;

/** 惰性加载 typescript（失败可重试） */
export function loadTypeScript(): Promise<TsModule> {
  tsPromise ??= import("typescript");
  tsPromise.catch(() => {
    tsPromise = null;
  });
  return tsPromise;
}

/** 已打开文件内容（editor store；Pinia 未激活/无 tab 返回 undefined） */
export async function openedContent(path: string): Promise<string | undefined> {
  try {
    const { useEditorStore } = await import("@/stores/editor");
    const tab = useEditorStore().tabs.find((t) => t.path === path);
    return tab?.content;
  } catch {
    return undefined;
  }
}

/** 磁盘读取（读写作用域根 + readTextFile；light 模式取文件所在目录） */
export async function readDiskContent(path: string): Promise<string | null> {
  try {
    const { useWorkspaceStore } = await import("@/stores/workspace");
    const scope = fileScopeRoot(useWorkspaceStore().rootPath, path);
    if (!scope) return null;
    const { readTextFile } = await import("@/shared/fs");
    return await readTextFile(scope, path);
  } catch {
    return null;
  }
}

/** 浏览器文件源（openedContent 异步获取：ensureFile 时先查已打开 tab） */
const dynamicSource: FileContentSource = {
  openedContent,
  readDisk: readDiskContent,
};

/** 类型服务单例 */
export const tsService = new TsLanguageService();

/** 确保类型服务就绪（返回 true 表示可继续查询） */
export async function ensureTypeService(root: string): Promise<boolean> {
  if (tsService.ready && tsService.currentRoot === root) return true;
  try {
    const [tsMod, { LIB_FILES }] = await Promise.all([
      loadTypeScript(),
      import("./libFiles"),
    ]);
    tsService.init(tsMod, root, dynamicSource, LIB_FILES);
    return true;
  } catch {
    return false;
  }
}

/**
 * 同步已打开文件到类型服务程序（编辑器创建/内容变化时调用）。
 * 返回 true 表示文件已注册到程序。
 */
export function syncOpenedFile(path: string, content: string): boolean {
  if (!tsService.ready) return false;
  tsService.setFile(path, content);
  return true;
}

/**
 * 准备一个 JS/TS 文件及其相对 import 闭包，供补全、hover、定义、引用、
 * 诊断和重命名共用。只注册 JS/TS 家族文件，Vue SFC 由 Vue 适配层处理，
 * 不把整份 HTML 模板误交给 TypeScript parser。
 */
export async function ensureTypeScriptProgram(
  root: string,
  filePath: string,
  content: string,
  maxDepth = 8,
): Promise<boolean> {
  if (!(await ensureTypeService(root))) return false;
  tsService.setFile(filePath, content);

  try {
    const { useEditorStore } = await import("@/stores/editor");
    for (const tab of useEditorStore().tabs) {
      if (/\.(?:[cm]?ts|tsx|jsx|js)$/i.test(tab.path)) {
        tsService.setFile(tab.path, tab.content);
      }
    }
  } catch {
    // 没有 Pinia 上下文时至少保留当前文件。
  }

  const { IMPORT_RE, resolveImportPath } = await import("@/shared/importReferences");
  const visited = new Set<string>([filePath]);
  const queue: Array<{ path: string; text: string; depth: number }> = [
    { path: filePath, text: content, depth: 0 },
  ];
  while (queue.length) {
    const current = queue.shift();
    if (!current || current.depth >= maxDepth) continue;
    const re = new RegExp(IMPORT_RE.source, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(current.text))) {
      const spec = match[1];
      if (!(spec.startsWith(".") || spec.startsWith("@/"))) continue;
      const resolved = await resolveImportPath(root, current.path, spec).catch(() => null);
      if (!resolved || visited.has(resolved) || !/\.(?:[cm]?ts|tsx|jsx|js)$/i.test(resolved)) {
        continue;
      }
      visited.add(resolved);
      await tsService.ensureFile(resolved);
      const opened = await openedContent(resolved);
      const text = opened ?? (await readDiskContent(resolved));
      if (text !== null && text !== undefined) {
        queue.push({ path: resolved, text, depth: current.depth + 1 });
      }
    }
  }
  return true;
}
