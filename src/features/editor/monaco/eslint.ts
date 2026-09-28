// ==================== 项目 ESLint 诊断 ====================
// 对 js/ts/vue 文件在「停止输入 1.5s」与「保存后」调用项目本地 ESLint，
// 结果写回 model marker（owner: eslint）。项目未装 ESLint 时静默停用。
import { monaco } from "./setup";
import { djb2 } from "@/features/editor/completion/docCache";
import {
  ESLINT_NOT_AVAILABLE,
  lintWithEslint,
  type EslintMessage,
} from "@/shared/toolingApi";
import { relativeToRoot } from "@/shared/fs";

const ESLINT_OWNER = "eslint";
const LINT_LANGUAGES = new Set(["typescript", "javascript", "vue"]);
const DEBOUNCE_MS = 1500;
/** 结果缓存：同一文件同一内容不重复调用（LRU，最多 32 条） */
const CACHE_LIMIT = 32;
/** 单文件内容超过该长度时跳过（ESLint 冷启动代价高） */
const MAX_LINT_LENGTH = 512 * 1024;

/** ESLint 消息 → Monaco marker（纯函数，便于直测） */
export function eslintMarkersFromMessages(
  messages: EslintMessage[],
): monaco.editor.IMarkerData[] {
  return messages.map((message) => ({
    severity:
      message.severity >= 2 ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
    message: message.rule_id ? `${message.message} [${message.rule_id}]` : message.message,
    startLineNumber: message.line,
    startColumn: message.column,
    endLineNumber: Math.max(message.end_line, message.line),
    endColumn: Math.max(message.end_column, message.column + 1),
    source: message.rule_id ?? undefined,
  }));
}

export interface EslintOptions {
  root: () => string | null;
  enabled: () => boolean;
  /** 项目未检测到 ESLint 时通知一次 */
  onUnavailable?: () => void;
}

export interface EslintController {
  /** 保存后立即检查（跳过防抖） */
  lintNow(model: monaco.editor.ITextModel): void;
}

let controller: EslintController | null = null;

export function installEslint(options: EslintOptions): EslintController {
  if (controller) return controller;

  const cache = new Map<string, monaco.editor.IMarkerData[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const subscriptions = new Map<string, monaco.IDisposable>();
  /** 运行中禁止并发重复请求 */
  const inFlight = new Set<string>();
  let unavailable = false;

  const cacheKey = (path: string, content: string) => `${path}\u0000${djb2(content)}`;

  const remember = (key: string, markers: monaco.editor.IMarkerData[]) => {
    cache.set(key, markers);
    if (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  };

  const lint = async (model: monaco.editor.ITextModel) => {
    if (unavailable || !options.enabled()) return;
    const root = options.root();
    if (!root) return;
    if (!LINT_LANGUAGES.has(model.getLanguageId())) return;
    const path = model.uri.scheme === "file" ? model.uri.fsPath : "";
    if (!path) return;
    const content = model.getValue();
    if (content.length > MAX_LINT_LENGTH) return;

    const key = cacheKey(path, content);
    const cached = cache.get(key);
    if (cached) {
      monaco.editor.setModelMarkers(model, ESLINT_OWNER, cached);
      return;
    }
    if (inFlight.has(key)) return;
    inFlight.add(key);

    try {
      const messages = await lintWithEslint(root, relativeToRoot(root, path), content);
      const markers = eslintMarkersFromMessages(messages);
      remember(key, markers);
      if (!model.isDisposed()) {
        monaco.editor.setModelMarkers(model, ESLINT_OWNER, markers);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(ESLINT_NOT_AVAILABLE)) {
        // 项目未安装 ESLint：停用并通知一次，避免每次输入都失败
        unavailable = true;
        options.onUnavailable?.();
      }
    } finally {
      inFlight.delete(key);
    }
  };

  const schedule = (model: monaco.editor.ITextModel) => {
    const key = model.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void lint(model);
      }, DEBOUNCE_MS),
    );
  };

  const watch = (model: monaco.editor.ITextModel) => {
    const key = model.uri.toString();
    if (subscriptions.has(key)) return;
    subscriptions.set(
      key,
      model.onDidChangeContent(() => {
        if (LINT_LANGUAGES.has(model.getLanguageId())) schedule(model);
      }),
    );
  };

  for (const model of monaco.editor.getModels()) watch(model);
  monaco.editor.onDidCreateModel((model) => {
    watch(model);
    // 打开即检查一次（文件可能已有历史问题）
    if (LINT_LANGUAGES.has(model.getLanguageId())) schedule(model);
  });
  monaco.editor.onWillDisposeModel((model) => {
    const key = model.uri.toString();
    subscriptions.get(key)?.dispose();
    subscriptions.delete(key);
    clearTimeout(timers.get(key));
    timers.delete(key);
    cache.clear();
  });

  controller = {
    lintNow(model) {
      if (!LINT_LANGUAGES.has(model.getLanguageId()) || model.isDisposed()) return;
      clearTimeout(timers.get(model.uri.toString()));
      void lint(model);
    },
  };
  return controller;
}
