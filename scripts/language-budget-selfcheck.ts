// ==================== 语言服务内存预算自测 ====================
// （node --experimental-strip-types scripts/language-budget-selfcheck.ts）
// 覆盖 languageBudget.ts 的全部纯函数：标准库回落、语言→worker 映射、
// 保留 model 集合、额外库筛选（数量/体积/去重）、挂起判定、挂起期间空结果形状。
import assert from "node:assert/strict";
import {
  DEFAULT_TS_LIBS,
  MAX_EXTRA_LIBS,
  MAX_EXTRA_LIB_CHARS,
  WORKER_SUSPEND_MS,
  emptyLanguageResult,
  languageWorkerMode,
  libsFromTsconfig,
  retainedModelPaths,
  selectExtraLibs,
  shouldSuspendLanguageWorkers,
} from "../src/features/editor/monaco/languageBudget.ts";

// 1. tsconfig 的 lib 映射
assert.deepEqual(libsFromTsconfig(undefined), ["es2022", "dom"], "未声明 lib 时用默认标准库");
assert.deepEqual(libsFromTsconfig(null), [...DEFAULT_TS_LIBS]);
assert.deepEqual(libsFromTsconfig(["es2022"]), ["es2022"], "Node 项目声明后不再加载 DOM");
assert.deepEqual(libsFromTsconfig([]), [...DEFAULT_TS_LIBS], "空数组回落默认");
assert.deepEqual(
  libsFromTsconfig(["  es2023  ", "", 42]),
  ["es2023"],
  "去空白并滤掉非字符串与空串",
);
assert.deepEqual(libsFromTsconfig("es2022"), [...DEFAULT_TS_LIBS], "非数组回落默认");

// 2. 语言 → worker
assert.equal(languageWorkerMode("typescript"), "typescript");
assert.equal(languageWorkerMode("vue"), "typescript", "vue 的 script 段走 TS worker");
assert.equal(languageWorkerMode("javascript"), "javascript");
assert.equal(languageWorkerMode("markdown"), null);
assert.equal(languageWorkerMode("plaintext"), null);

// 3. 保留 model：当前 + 上一个（且都还开着）
const open = ["/a.ts", "/b.ts", "/c.ts"];
assert.deepEqual(retainedModelPaths("/c.ts", "/b.ts", open), ["/c.ts", "/b.ts"]);
assert.deepEqual(retainedModelPaths("/c.ts", "/c.ts", open), ["/c.ts"], "上一个与当前相同时不重复");
assert.deepEqual(retainedModelPaths("/c.ts", "", open), ["/c.ts"]);
assert.deepEqual(
  retainedModelPaths("/c.ts", "/closed.ts", open),
  ["/c.ts"],
  "上一个标签已关闭时不再保留",
);
assert.deepEqual(retainedModelPaths("", "", open), []);

// 4. 额外库筛选
const candidate = (path: string, size = 10) => ({ path, content: "x".repeat(size) });
const many = Array.from({ length: MAX_EXTRA_LIBS + 5 }, (_, index) => candidate(`/f${index}.ts`));
assert.equal(selectExtraLibs(many).length, MAX_EXTRA_LIBS, "超过上限的部分被丢掉");
assert.deepEqual(
  selectExtraLibs(many).map((item) => item.path),
  many.slice(0, MAX_EXTRA_LIBS).map((item) => item.path),
  "按输入顺序取前 N 个",
);
assert.deepEqual(
  selectExtraLibs([candidate("/dup.ts"), candidate("/dup.ts")]).map((item) => item.path),
  ["/dup.ts"],
  "同一路径只保留第一次",
);
assert.deepEqual(
  selectExtraLibs([
    candidate("/big.ts", MAX_EXTRA_LIB_CHARS + 1),
    candidate("/small.ts"),
  ]).map((item) => item.path),
  ["/small.ts"],
  "超过单文件体积上限的跳过",
);
assert.equal(
  selectExtraLibs([candidate("/edge.ts", MAX_EXTRA_LIB_CHARS)]).length,
  1,
  "恰好等于体积上限的文件保留",
);

// 5. 挂起判定
assert.equal(shouldSuspendLanguageWorkers(false, WORKER_SUSPEND_MS - 1), false);
assert.equal(shouldSuspendLanguageWorkers(false, WORKER_SUSPEND_MS), true);
assert.equal(shouldSuspendLanguageWorkers(true, WORKER_SUSPEND_MS * 10), false);

// 6. 挂起期间的空结果形状（调用方会 concat / 迭代，形状不对会抛错）
assert.deepEqual(emptyLanguageResult("getSemanticDiagnostics"), []);
assert.deepEqual(emptyLanguageResult("getSyntacticDiagnostics"), []);
assert.deepEqual(emptyLanguageResult("getSuggestionDiagnostics"), []);
assert.deepEqual(emptyLanguageResult("getCompletionsAtPosition"), { entries: [] });
assert.deepEqual(emptyLanguageResult("getLibFiles"), {});
assert.equal(emptyLanguageResult("getQuickInfoAtPosition"), undefined);

console.log("✅ 语言服务内存预算自测通过");
