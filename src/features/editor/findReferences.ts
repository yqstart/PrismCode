// ==================== Find References ====================
// JS/TS/Vue script 优先走 TypeScript LanguageService，其他语言或服务不可用时
// 回退 workspaceSymbols。返回按文件+行排序的去重结果，供 UI 渲染 / rename 使用。

import { useEditorStore } from "@/stores/editor";
import { workspaceSymbols } from "@/features/editor/workspaceSymbols";
import { ensureTypeScriptProgram, tsService } from "@/features/editor/typeService";
import { createVueScriptContext, isInVueScript } from "@/features/editor/vueScript";
import { readTextFile } from "@/shared/fs";

export interface ReferenceLocation {
  path: string;
  line: number;
  column: number;
  isDefinition?: boolean;
}

function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
  const safe = Math.max(0, Math.min(text.length, offset));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < safe; i += 1) {
    if (text[i] === "\n") {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: safe - lineStart + 1 };
}

async function fileContent(
  root: string,
  path: string,
  sourceFile: string,
  sourceContent: string,
): Promise<string | null> {
  if (path === sourceFile) return sourceContent;
  const tab = useEditorStore().tabs.find((item) => item.path === path);
  if (tab) return tab.content;
  try {
    return await readTextFile(root, path);
  } catch {
    return null;
  }
}

/** 跨文件查找所有引用（默认 5 层深度） */
export async function findReferences(
  word: string,
  sourceFile: string,
  sourceContent: string,
  root: string,
  options: {
    maxDepth?: number;
    /** 找到后自动调 openInEditor 第一个结果 */
    autoOpenFirst?: boolean;
    /** 当前光标 offset；用于 TS 精确解析，未传时回退到首个同名词。 */
    position?: number;
    /** 重命名使用 TS 的 findRenameLocations，避免漏掉别名/重载关联位置。 */
    forRename?: boolean;
  } = {},
): Promise<ReferenceLocation[]> {
  const {
    maxDepth = 5,
    autoOpenFirst = false,
    position,
    forRename = false,
  } = options;
  if (!word) return [];
  let refs: ReferenceLocation[] = [];

  // JS/TS 优先走 TypeScript LanguageService，避免正则把同名属性/字符串
  // 误认成引用；类型服务失败时才回退工作区符号索引，保证轻量模式可用。
  try {
    const isVue = /\.vue$/i.test(sourceFile);
    const sourcePos =
      position ?? Math.max(0, sourceContent.indexOf(word));
    const inVueScript = isVue && isInVueScript(sourceContent, sourcePos);
    const virtual = inVueScript ? createVueScriptContext(sourceFile, sourceContent) : null;
    const serviceFile = virtual?.fileName ?? sourceFile;
    const serviceText = virtual?.text ?? sourceContent;
    if (!isVue || inVueScript) {
      const ready = await ensureTypeScriptProgram(root, serviceFile, serviceText, maxDepth);
      if (ready) {
        const semantic = forRename
          ? tsService.renameLocationsAt(serviceFile, sourcePos)
          : tsService.referencesAt(serviceFile, sourcePos);
        const virtualBack = new Map<string, string>([
          [serviceFile, sourceContent],
        ]);
        for (const item of semantic) {
          const path = item.fileName === serviceFile ? sourceFile : item.fileName;
          const content =
            virtualBack.get(item.fileName) ??
            (await fileContent(root, path, sourceFile, sourceContent));
          if (content === null) continue;
          const loc = offsetToLineColumn(content, item.textSpan.start);
          refs.push({
            path,
            line: loc.line,
            column: loc.column,
            isDefinition: item.isDefinition,
          });
        }
      }
    }
  } catch {
    // 类型服务未就绪/解析失败时进入正则索引兜底。
  } finally {
    // 主线程这套 LanguageService（第二份编译器 + DOM 标准库）只在本次查询期间需要
    tsService.release();
  }

  if (!refs.length) {
    refs = await workspaceSymbols.findAllReferences(root, word, sourceFile, sourceContent, maxDepth);
  }
  if (autoOpenFirst && refs.length > 0) {
    const first = refs[0];
    const editor = useEditorStore();
    void editor.openFileAt(first.path, first.line, first.column);
  }
  return refs;
}

/** 在 DevTools console 打印 + UI 弹条概要（用于 v1 快速闭环） */
export function logReferences(refs: ReferenceLocation[], word: string): void {
  if (refs.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`[findReferences] 符号 "${word}" 未找到任何引用`);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`[findReferences] 符号 "${word}" 共 ${refs.length} 处引用：`);
  for (const r of refs) {
    // eslint-disable-next-line no-console
    console.log(`  ${r.path}:${r.line}:${r.column}`);
  }
}
