// ==================== 冲突块解析与解决自测 ====================
import assert from "node:assert/strict";
import { createServer } from "vite";
import { resolve } from "node:path";

const root = process.cwd();
const server = await createServer({
  configFile: false,
  root,
  logLevel: "error",
  appType: "custom",
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
});

try {
  const { parseConflictBlocks, conflictResolutionText } = (await server.ssrLoadModule(
    "/src/features/git/conflictBlocks.ts",
  )) as {
    parseConflictBlocks: (text: string) => Array<{
      startLine: number;
      separatorLine: number;
      endLine: number;
      baseStartLine: number | null;
      ours: string;
      theirs: string;
      base: string | null;
    }>;
    conflictResolutionText: (
      block: {
        startLine: number;
        separatorLine: number;
        endLine: number;
        baseStartLine: number | null;
        ours: string;
        theirs: string;
        base: string | null;
      },
      choice: "ours" | "theirs" | "both",
    ) => string;
  };

  // 1. 标准冲突块
  const simple = [
    "const keep = 1;",
    "<<<<<<< HEAD",
    "const value = 'ours';",
    "=======",
    "const value = 'theirs';",
    ">>>>>>> feature/x",
    "const tail = 2;",
  ].join("\n");
  const simpleBlocks = parseConflictBlocks(simple);
  assert.equal(simpleBlocks.length, 1, "应解析出一个冲突块");
  assert.deepEqual(
    {
      startLine: simpleBlocks[0]!.startLine,
      separatorLine: simpleBlocks[0]!.separatorLine,
      endLine: simpleBlocks[0]!.endLine,
    },
    { startLine: 2, separatorLine: 4, endLine: 6 },
    "冲突块行号应指向标记行",
  );
  assert.equal(simpleBlocks[0]!.ours, "const value = 'ours';");
  assert.equal(simpleBlocks[0]!.theirs, "const value = 'theirs';");
  assert.equal(simpleBlocks[0]!.base, null, "两栏冲突没有 base 段");

  // 2. diff3 风格（含 base）
  const diff3 = [
    "<<<<<<< HEAD",
    "ours line",
    "||||||| merged common ancestors",
    "base line",
    "=======",
    "theirs line",
    ">>>>>>> other",
  ].join("\n");
  const diff3Blocks = parseConflictBlocks(diff3);
  assert.equal(diff3Blocks.length, 1);
  assert.equal(diff3Blocks[0]!.base, "base line");
  assert.equal(diff3Blocks[0]!.baseStartLine, 3);

  // 3. 多块 + 未闭合块
  const multi = [
    "<<<<<<< HEAD",
    "a",
    "=======",
    "b",
    ">>>>>>> x",
    "",
    "<<<<<<< HEAD",
    "unclosed",
  ].join("\n");
  const multiBlocks = parseConflictBlocks(multi);
  assert.equal(multiBlocks.length, 1, "未闭合的冲突块必须跳过");

  // 4. 三种采用结果
  const block = simpleBlocks[0]!;
  assert.equal(conflictResolutionText(block, "ours"), "const value = 'ours';");
  assert.equal(conflictResolutionText(block, "theirs"), "const value = 'theirs';");
  assert.equal(
    conflictResolutionText(block, "both"),
    "const value = 'ours';\nconst value = 'theirs';",
    "保留两者应按 ours 在上、theirs 在下拼接",
  );

  // 5. 单侧为空时不产生多余空行
  const emptyTheirs = parseConflictBlocks(
    ["<<<<<<< HEAD", "only ours", "=======", ">>>>>>> x"].join("\n"),
  )[0]!;
  assert.equal(conflictResolutionText(emptyTheirs, "both"), "only ours");

  console.log("✅ 冲突块解析自测通过");
} finally {
  await server.close();
}
