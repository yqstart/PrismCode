// ==================== TS 类型服务补全源（真类型感知成员 + 真自动导入） ====================
// 接入分派链：script 上下文（非 .vue）优先本源，类型服务未就绪/异常返回 null → 轻量语义兜底。
// 类型感知：obj. 成员来自真实类型推断；未导入符号附带自动导入（VS Code Auto Import）。

import type { Completion, CompletionContext, CompletionSource } from "@codemirror/autocomplete";
import { ensureTypeScriptProgram, tsService } from "./index";
import { buildAutoImportApply, type TsCompletionEntry } from "./tsService";

/** ts.CompletionEntry.kind（TS 字符串枚举）→ CM6 type */
export function tsKindToCmType(kind: string): Completion["type"] {
  switch (kind) {
    case "function": return "function";
    case "method": return "method";
    case "class": return "class";
    case "interface": return "interface";
    case "property": return "property";
    case "variable": return "variable";
    case "constant": return "constant";
    case "enum": return "enum";
    case "keyword": return "keyword";
    case "type": return "type";
    case "module": return "namespace";
    case "typeParameter": return "type";
    case "member": return "property";
    case "alias": return "type";
    default: return "text";
  }
}

/** 构造 apply：普通项插入文本；自动导入项插入符号 + 顶部 import 语句（逻辑在 tsService 纯函数） */
function buildApply(
  entry: TsCompletionEntry,
  docText: string,
): Completion["apply"] {
  return buildAutoImportApply(entry, docText);
}

/**
 * 创建类型服务补全源（JS/TS/Vue script 使用）
 */
export function createTsCompletionSource(
  filePath: string,
  sourceOptions?: {
    serviceFilePath?: string;
    serviceText?: (document: string) => string;
  },
): CompletionSource {
  return async (context: CompletionContext) => {
    const docText = context.state.doc.toString();
    const pos = context.pos;
    const serviceFilePath = sourceOptions?.serviceFilePath ?? filePath;
    const serviceText = sourceOptions?.serviceText?.(docText) ?? docText;

    // 准备当前文件与 import 闭包；未就绪/加载失败时回退轻量语义补全。
    try {
      const { useWorkspaceStore } = await import("@/stores/workspace");
      const root = useWorkspaceStore().rootPath;
      if (!root || !(await ensureTypeScriptProgram(root, serviceFilePath, serviceText))) return null;
    } catch {
      return null;
    }

    // 查询补全（同步；异常降级）
    let entries: TsCompletionEntry[];
    try {
      entries = tsService.completionsAt(serviceFilePath, pos);
    } catch {
      return null;
    }
    if (!entries.length) return null;

    const word = context.matchBefore(/[\w$]*/);
    const wordFrom = word?.from ?? pos;

    // 转换（最多 60 项；sortText 透传 CM 排序；文档懒加载）
    const options: Completion[] = entries.slice(0, 60).map((e) => {
      const cm: Completion = {
        label: e.name,
        type: tsKindToCmType(e.kind),
        detail: e.labelDetails ?? (e.kindModifiers || undefined),
        sortText: e.sortText,
        boost: 5, // 类型服务项优先于轻量语义
        apply: buildApply(e, docText),
      };
      if (e.sourceDisplay) {
        cm.detail = `${cm.detail ?? "导入"} · ${e.sourceDisplay}`;
      }
      // 文档懒加载（选中时查 completionEntryDetails）
      cm.info = () => {
        const el = document.createElement("div");
        el.className = "prism-completion-doc";
        try {
          const details = tsService.completionDetails(serviceFilePath, pos, e.name);
          el.textContent = details?.documentation || e.kindModifiers || e.name;
          if (details?.detail) {
            const d = document.createElement("div");
            d.style.color = "var(--text-muted)";
            d.textContent = details.detail;
            el.prepend(d);
          }
        } catch {
          el.textContent = e.kindModifiers || e.name;
        }
        return el;
      };
      return cm;
    });

    return { from: wordFrom, options, validFor: /^[\w$]*$/ };
  };
}
