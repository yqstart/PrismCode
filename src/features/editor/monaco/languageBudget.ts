// ==================== 语言服务内存预算（纯函数） ====================
// 这里决定 Monaco 的 TS/JS worker 在内存里保留多少东西：额外注入的未打开文件
// 数量与体积、常驻 model 数量、失焦多久后挂起 worker。全部与 Monaco / Vue 无关，
// node --experimental-strip-types 可直测，调用方不得再写另一套数字。

/** 注入 worker 的额外库（未打开文件）数量上限 */
export const MAX_EXTRA_LIBS = 32;

/** 单个额外库字符数上限：超过则不注入（类型检查器会为每个文件建 AST 与符号表） */
export const MAX_EXTRA_LIB_CHARS = 256 * 1024;

/** 窗口失焦多久后挂起语言服务 worker（毫秒） */
export const WORKER_SUSPEND_MS = 3000;

/** 未声明 lib 时的默认标准库：浏览器项目要 DOM，Node 项目在 tsconfig 里覆盖 */
export const DEFAULT_TS_LIBS = ["es2022", "dom"];

/** 需要 TypeScript 编译器 worker 的语言模式 */
export type LanguageWorkerMode = "typescript" | "javascript";

/** tsconfig 的 lib 字段 → worker 的标准库清单（缺失/空/非法时回落默认） */
export function libsFromTsconfig(lib: unknown): string[] {
 if (!Array.isArray(lib)) return [...DEFAULT_TS_LIBS];
 const names = lib
  .filter((item): item is string => typeof item === "string")
  .map((item) => item.trim())
  .filter((item) => item.length > 0);
 return names.length ? names : [...DEFAULT_TS_LIBS];
}

/** model 语言 → 对应的语言服务 worker；纯语法高亮的语言返回 null */
export function languageWorkerMode(languageId: string): LanguageWorkerMode | null {
 if (languageId === "typescript" || languageId === "vue") return "typescript";
 if (languageId === "javascript") return "javascript";
 return null;
}

/**
 * 最多保留两个 Monaco model：当前标签与上一个标签。
 * 更早的标签模型被释放（正文由 editor store 持有），使 worker 镜像的文件数有界。
 */
export function retainedModelPaths(
 active: string,
 previous: string,
 openPaths: readonly string[],
): string[] {
 const open = new Set(openPaths);
 const kept: string[] = [];
 if (active && open.has(active)) kept.push(active);
 if (previous && previous !== active && open.has(previous)) kept.push(previous);
 return kept;
}

export interface ExtraLibCandidate {
 path: string;
 content: string;
}

/** 额外库筛选：按输入顺序、路径去重、跳过超大文件、取满上限即停 */
export function selectExtraLibs(
 candidates: readonly ExtraLibCandidate[],
): ExtraLibCandidate[] {
 const seen = new Set<string>();
 const selected: ExtraLibCandidate[] = [];
 for (const candidate of candidates) {
  if (selected.length >= MAX_EXTRA_LIBS) break;
  if (seen.has(candidate.path)) continue;
  seen.add(candidate.path);
  if (candidate.content.length > MAX_EXTRA_LIB_CHARS) continue;
  selected.push(candidate);
 }
 return selected;
}

/**
 * 挂起期间 worker 调用返回的空结果。
 * 按方法名给出形状：诊断类必须返回数组（调用方会 concat），补全返回空候选集，
 * getLibFiles 返回空表，其余返回 undefined。
 */
export function emptyLanguageResult(method: string): unknown {
 if (method.startsWith("get") && method.endsWith("Diagnostics")) return [];
 if (method === "getCompletionsAtPosition") return { entries: [] };
 if (method === "getLibFiles") return {};
 return undefined;
}

/** 是否应挂起语言服务 worker（失焦且超过静默窗口） */
export function shouldSuspendLanguageWorkers(
 hasFocus: boolean,
 blurredForMs: number,
): boolean {
 return !hasFocus && blurredForMs >= WORKER_SUSPEND_MS;
}
