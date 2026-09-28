// ==================== JSON / .env 诊断与 .env 语言 ====================
// 这两类文件不需要语言服务：JSON 用 JSON.parse 定位语法错误，
// .env 只查重复键。markers owner 分别是 prism-json / prism-env。
import { monaco } from "./setup";

const JSON_OWNER = "prism-json";
const ENV_OWNER = "prism-env";

/** JSON.parse 只给字符偏移，转成行列 marker */
function jsonMarkers(model: monaco.editor.ITextModel): monaco.editor.IMarkerData[] {
  const text = model.getValue();
  if (!text.trim()) return [];
  try {
    JSON.parse(text);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : "JSON 解析错误";
    const match = message.match(/position (\d+)/i);
    const offset = Math.max(0, Math.min(match ? Number(match[1]) : 0, text.length));
    const start = model.getPositionAt(offset);
    const end = model.getPositionAt(Math.min(text.length, offset + 1));
    return [
      {
        severity: monaco.MarkerSeverity.Error,
        message,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      },
    ];
  }
}

const ENV_KEY_RE = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=/;

/** .env：重复键报错（后者覆盖前者是常见事故） */
function envMarkers(model: monaco.editor.ITextModel): monaco.editor.IMarkerData[] {
  const markers: monaco.editor.IMarkerData[] = [];
  const seen = new Map<string, number>();
  const lineCount = model.getLineCount();
  for (let line = 1; line <= lineCount; line += 1) {
    const text = model.getLineContent(line);
    const match = text.match(ENV_KEY_RE);
    if (!match) continue;
    const key = match[1];
    const column = text.indexOf(key) + 1;
    if (seen.has(key)) {
      markers.push({
        severity: monaco.MarkerSeverity.Error,
        message: `重复的环境变量 ${key}（第 ${seen.get(key)} 行已定义）`,
        startLineNumber: line,
        startColumn: column,
        endLineNumber: line,
        endColumn: column + key.length,
      });
    } else {
      seen.set(key, line);
    }
  }
  return markers;
}

const envLanguage: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".env",
  tokenizer: {
    root: [
      [/^\s*#.*$/, "comment"],
      [/^\s*(?:export)(?=\s)/, "keyword"],
      [/^\s*[A-Za-z_][\w.]*(?=\s*=)/, "key"],
      [/=/, "delimiter"],
      [/"([^"\\]|\\.)*"/, "string"],
      [/'([^'\\]|\\.)*'/, "string"],
      [/\$\{[^}]*\}|\$[A-Za-z_][\w]*/, "variable"],
      [/\S+/, "string"],
    ],
  },
};

let registered = false;

export function registerJsonEnvProviders(): void {
  if (registered) return;
  registered = true;

  monaco.languages.register({
    id: "env",
    extensions: [".env"],
    aliases: ["Env", "env"],
  });
  monaco.languages.setMonarchTokensProvider("env", envLanguage);
  monaco.languages.setLanguageConfiguration("env", {
    comments: { lineComment: "#" },
  });

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const contentSubs = new Map<string, monaco.IDisposable>();

  const isTarget = (model: monaco.editor.ITextModel) => {
    const languageId = model.getLanguageId();
    return languageId === "json" || languageId === "env";
  };

  const refresh = (model: monaco.editor.ITextModel) => {
    if (model.getLanguageId() === "json") {
      monaco.editor.setModelMarkers(model, JSON_OWNER, jsonMarkers(model));
      return;
    }
    if (model.getLanguageId() === "env") {
      monaco.editor.setModelMarkers(model, ENV_OWNER, envMarkers(model));
    }
  };

  const schedule = (model: monaco.editor.ITextModel) => {
    const key = model.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        refresh(model);
      }, 300),
    );
  };

  // Monaco 没有全局的 model 内容事件：创建时按 model 订阅
  const watch = (model: monaco.editor.ITextModel) => {
    const key = model.uri.toString();
    if (contentSubs.has(key)) return;
    contentSubs.set(
      key,
      model.onDidChangeContent(() => {
        if (isTarget(model)) schedule(model);
      }),
    );
    if (isTarget(model)) refresh(model);
  };

  monaco.editor.onDidCreateModel(watch);
  monaco.editor.onDidChangeModelLanguage((event) => {
    watch(event.model);
    if (isTarget(event.model)) refresh(event.model);
  });
  monaco.editor.onWillDisposeModel((model) => {
    const key = model.uri.toString();
    contentSubs.get(key)?.dispose();
    contentSubs.delete(key);
    clearTimeout(timers.get(key));
    timers.delete(key);
  });
}
