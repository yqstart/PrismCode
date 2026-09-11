// ==================== LSP CompletionItem → CodeMirror 6 Completion 适配 ====================
// 纯函数：不依赖语言服务运行时与编辑器实例，输入 LSP 形状的补全项，输出 CM6 Completion。
// 独立文件便于 node --experimental-strip-types 直测（仅 type 依赖）。
//
// 范围说明：CM6 的 Completion 无 per-item 范围（from/to 在 CompletionResult 级），
// 而 HTML/CSS 语言服务的 textEdit 基本只覆盖「当前 word」——因此这里统一取
// wordFrom 作为 result.from，逐项用 apply 决定插入文本，无需 per-item range。
//
// 对齐 VS Code 的接受行为：
// - commitCharacters 透传（输入 `.`/`(`/`;` 等自动提交并追加该字符）
// - snippet 占位符：剥离 `$1`/`${1:default}` 字面量，且光标定位到首个占位处
//   （VS Code 的 tab stop 导航 v1 不做，光标落位后直接输入即可）
// - documentation 渲染为 markdown（懒渲染，避免每次补全都 parse）

import type { Completion } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import type {
  CompletionItem,
  MarkupContent,
} from "vscode-languageserver-types";
import { renderMarkdown } from "../markdown/preview.ts";

/** LSP Position → 文档 offset（按行累加，自行实现避免依赖 TextDocument） */
export function positionToOffset(
  text: string,
  line: number,
  character: number,
): number {
  const lines = text.split("\n");
  // 行越界 → 文档末尾（LSP 容错语义）
  if (line >= lines.length) return text.length;
  const target = Math.max(0, line);
  let offset = 0;
  for (let i = 0; i < target; i += 1) {
    offset += lines[i].length + 1; // +1 是换行符
  }
  const lineLen = lines[target].length;
  return offset + Math.max(0, Math.min(character, lineLen));
}

/** LSP CompletionItemKind → CM6 completion type（图标用；无对应映射归为 text） */
export function lspKindToCmType(
  kind: CompletionItem["kind"],
): Completion["type"] {
  switch (kind) {
    case 2: return "method";
    case 3: return "function";
    case 4: return "class";
    case 5: return "property";
    case 6: return "variable";
    case 7: return "class";
    case 8: return "interface";
    case 9: return "namespace";
    case 10: return "property";
    case 12: return "constant";
    case 13: return "enum";
    case 14: return "keyword";
    case 15: return "text";
    case 20: return "enum";
    case 21: return "constant";
    case 22: return "type";
    case 25: return "type";
    default: return "text";
  }
}

/** documentation（string | MarkupContent）→ 纯文本（无渲染成本，用于 detail） */
export function docToText(
  doc: string | MarkupContent | undefined,
): string | undefined {
  if (typeof doc === "string") return doc;
  if (doc && typeof doc.value === "string") return doc.value;
  return undefined;
}

/**
 * documentation → CM6 info（markdown 渲染，懒执行）
 * 返回函数：仅当补全项被选中时渲染 DOM，避免每次补全全量 parse。
 */
export function docToInfo(
  doc: string | MarkupContent | undefined,
): (() => HTMLElement) | undefined {
  const text = docToText(doc);
  if (!text) return undefined;
  return () => {
    const el = document.createElement("div");
    el.className = "prism-completion-doc";
    try {
      // 补全文档可能来自项目文件或语言服务，统一走安全 Markdown
      // renderer，禁止 raw HTML 和危险链接绕过预览层防线。
      el.innerHTML = renderMarkdown(text);
    } catch {
      el.textContent = text;
    }
    return el;
  };
}

/** 找到 LSP snippet 文本中首个占位符，返回占位前后文本与默认值 */
export function findFirstSnippetPlaceholder(text: string): {
  before: string;
  after: string;
  defaultValue: string;
} | null {
  const named = text.match(/\$\{(\d+)(?::([^}]*))?\}/);
  if (named && named.index !== undefined) {
    return {
      before: text.slice(0, named.index),
      after: text.slice(named.index + named[0].length),
      defaultValue: named[2] ?? "",
    };
  }
  const plain = text.match(/\$(\d+)/);
  if (plain && plain.index !== undefined) {
    return {
      before: text.slice(0, plain.index),
      after: text.slice(plain.index + plain[0].length),
      defaultValue: "",
    };
  }
  return null;
}

/** LSP snippet 占位符剥离：`${1:default}` → default；`$1` → 空 */
export function stripSnippetPlaceholders(text: string): string {
  return text
    .replace(/\$\{(\d+):([^}]*)\}/g, "$2")
    .replace(/\$(\d+)/g, "");
}

/**
 * 创建 snippet apply：插入剥离占位符后的文本，并把光标定位到首个占位处
 * （`class="$1"` → 插入 `class=""`，光标落在引号之间，可直接输入）
 * 供语言服务与用户自定义 snippets 共用。
 */
export function createSnippetApply(
  insertText: string,
): (view: EditorView, completion: Completion, from: number, to: number) => void {
  return (view, _completion, from, to) => {
    const placeholder = findFirstSnippetPlaceholder(insertText);
    if (!placeholder) {
      view.dispatch({
        changes: { from, to, insert: stripSnippetPlaceholders(insertText) },
        userEvent: "input.complete",
      });
      return;
    }
    const insert = placeholder.before + placeholder.defaultValue + placeholder.after;
    const selPos = from + placeholder.before.length + placeholder.defaultValue.length;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: selPos },
      userEvent: "input.complete",
    });
  };
}

/**
 * 单个 LSP CompletionItem → CM6 Completion
 *
 * @param item LSP 补全项
 * @returns CM6 Completion（apply = textEdit.newText ?? insertText ?? label；
 * snippet 格式（insertTextFormat=2）剥离占位符并光标定位；补全起点由调用方在 CompletionResult.from 统一给出）
 */
export function toCmCompletion(item: CompletionItem): Completion {
  const edit = item.textEdit;
  let newText: string | undefined;
  if (edit && "newText" in edit && typeof edit.newText === "string") {
    newText = edit.newText;
  } else {
    newText = item.insertText;
  }

  const isSnippet = item.insertTextFormat === 2;
  let apply: Completion["apply"];
  if (isSnippet && typeof newText === "string") {
    apply = createSnippetApply(newText);
  } else {
    apply = newText ?? item.label;
  }

  return {
    label: item.label,
    type: lspKindToCmType(item.kind),
    detail: item.detail,
    info: docToInfo(item.documentation),
    sortText: item.sortText,
    apply,
    boost: item.preselect ? 5 : undefined,
    commitCharacters: item.commitCharacters,
  };
}

/** 批量转换 + 过滤（剔除无意义的空项） */
export function toCmCompletions(items: CompletionItem[]): Completion[] {
  const out: Completion[] = [];
  for (const item of items) {
    if (!item.label) continue;
    out.push(toCmCompletion(item));
  }
  return out;
}
