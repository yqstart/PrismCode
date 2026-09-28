// ==================== Emmet 缩写展开 ====================
// 复用既有匹配/缩进逻辑（completion/emmet.ts），在 Monaco 里以补全项形式给出
// 展开结果；接受补全即插入（snippet 占位符可直接跳转）。
import { monaco } from "./setup";
import {
  emmetSyntax,
  indentExpanded,
  matchEmmetAbbreviation,
} from "@/features/editor/completion/emmet";

const EMMET_LANGUAGES = ["html", "vue", "css", "scss", "less"];

let expandPromise: Promise<{ default: (abbr: string, config: object) => string }> | null = null;

function ensureExpander(): Promise<{ default: (abbr: string, config: object) => string }> {
  expandPromise ??= import("emmet");
  expandPromise.catch(() => {
    expandPromise = null;
  });
  return expandPromise;
}

let registered = false;

export function registerEmmetProvider(): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider(EMMET_LANGUAGES, {
    triggerCharacters: [">", "+", "^", "*", "#", ".", "[", "]", "(", ")"],
    async provideCompletionItems(model, position) {
      const lineContent = model.getLineContent(position.lineNumber);
      const beforeCursor = lineContent.slice(0, position.column - 1);
      const abbr = matchEmmetAbbreviation(beforeCursor);
      if (!abbr) return null;

      let expand: (abbr: string, config: object) => string;
      try {
        expand = (await ensureExpander()).default;
      } catch {
        return null;
      }

      const filePath = model.uri.scheme === "file" ? model.uri.fsPath : model.uri.toString();
      let expanded: string;
      try {
        expanded = expand(abbr, { syntax: emmetSyntax(filePath, beforeCursor) });
      } catch {
        return null;
      }
      if (!expanded || expanded === abbr) return null;

      const baseIndent = lineContent.match(/^\s*/)?.[0] ?? "";
      const insertText = indentExpanded(expanded, baseIndent);
      return {
        suggestions: [
          {
            label: `emmet: ${abbr}`,
            kind: monaco.languages.CompletionItemKind.Snippet,
            detail: "Emmet 缩写展开",
            documentation: { value: ["```html", insertText, "```"].join("\n") },
            insertText,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            // 置顶：与内置标签/属性建议相比更贴近用户刚敲下的缩写
            sortText: "0",
            range: {
              startLineNumber: position.lineNumber,
              startColumn: position.column - abbr.length,
              endLineNumber: position.lineNumber,
              endColumn: position.column,
            },
          },
        ],
      };
    },
  });
}
