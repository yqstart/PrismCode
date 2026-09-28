// ==================== 用户 Snippet 补全 ====================
// 复用既有的 VS Code snippets JSON 解析与 scope 匹配，按文件语言过滤后
// 作为补全项给出（body 以 snippet 占位符插入）。
import { monaco } from "./setup";
import {
  languageIdFor,
  loadGlobalSnippets,
  loadUserSnippets,
  snippetMatchesScope,
  type UserSnippet,
} from "@/features/editor/completion/userSnippets";

const SNIPPET_LANGUAGES = [
  "typescript",
  "javascript",
  "vue",
  "html",
  "css",
  "scss",
  "less",
  "json",
  "markdown",
  "yaml",
  "xml",
];

interface SnippetOptions {
  root: () => string | null;
}

let registered = false;

export function registerUserSnippets(options: SnippetOptions): void {
  if (registered) return;
  registered = true;

  let cache: UserSnippet[] = [];
  const loaded = Promise.resolve().then(async () => {
    const root = options.root();
    cache = root ? await loadUserSnippets(root) : await loadGlobalSnippets();
  });

  monaco.languages.registerCompletionItemProvider(SNIPPET_LANGUAGES, {
    async provideCompletionItems(model, position) {
      await loaded;
      if (!cache.length) return null;
      const filePath = model.uri.scheme === "file" ? model.uri.fsPath : model.uri.toString();
      const languageId = languageIdFor(filePath) || model.getLanguageId();
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: word.endColumn,
      };
      const suggestions: monaco.languages.CompletionItem[] = [];
      for (const snippet of cache) {
        if (!snippetMatchesScope(snippet, languageId)) continue;
        for (const prefix of snippet.prefix) {
          suggestions.push({
            label: { label: snippet.name, description: prefix },
            kind: monaco.languages.CompletionItemKind.Snippet,
            detail: snippet.description ?? "用户代码片段",
            insertText: snippet.body,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            // 让片段排在语言建议之后，避免遮挡常规补全
            sortText: `z_${prefix}`,
            range,
          });
        }
      }
      return suggestions.length ? { suggestions } : null;
    },
  });
}
