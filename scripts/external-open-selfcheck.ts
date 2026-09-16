import assert from "node:assert/strict";
import {
  parentDirectory,
  planExternalOpen,
  removeBootFiles,
  saveBootFiles,
  takeBootFiles,
} from "../src/shared/externalOpenRoute.ts";
import type { ExternalOpenTarget } from "../src/shared/externalOpen.ts";

function file(path: string, line?: number): ExternalOpenTarget {
  return { path, line, column: line === undefined ? undefined : 1, isDir: false };
}
function dir(path: string): ExternalOpenTarget {
  return { path, isDir: true };
}

type Stored = Map<string, string>;
const stored: Stored = new Map();
(globalThis as typeof globalThis & {
  localStorage: Storage;
}).localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
  clear: () => stored.clear(),
  key: (index: number) => [...stored.keys()][index] ?? null,
  get length() {
    return stored.size;
  },
} as Storage;

// 已在工作区的文件留在本窗口，工作区外的文件按父目录分组开新窗口。
{
  const plan = planExternalOpen(
    [file("/work/demo/src/a.ts"), file("/tmp/other/b.ts"), file("/tmp/other/c.ts:9")],
    "/work/demo",
  );
  assert.deepEqual(
    plan.inCurrentFiles.map((item) => item.path),
    ["/work/demo/src/a.ts"],
  );
  assert.equal(plan.newWindowGroups.length, 1);
  assert.equal(plan.newWindowGroups[0]?.folder, "/tmp/other");
  assert.deepEqual(
    (plan.newWindowGroups[0]?.targets ?? []).map((item) => item.path),
    ["/tmp/other/b.ts", "/tmp/other/c.ts:9"],
  );
}

// 重复外部打开同一目录不再打扰当前窗口（之前会整窗切换过去）。
{
  const plan = planExternalOpen([dir("/work/demo")], "/work/demo");
  assert.deepEqual(plan.inCurrentDirs, []);
  assert.deepEqual(plan.newWindowDirs, []);
}

// 不同目录打开新窗口；工作区内的多文件继续在本窗口叠加。
{
  const plan = planExternalOpen(
    [dir("/work/other"), file("/work/demo/a.ts"), file("/work/demo/b.ts")],
    "/work/demo",
  );
  assert.deepEqual(
    plan.newWindowDirs.map((item) => item.path),
    ["/work/other"],
  );
  assert.deepEqual(
    plan.inCurrentFiles.map((item) => item.path),
    ["/work/demo/a.ts", "/work/demo/b.ts"],
  );
}

// 无工作区时首个文件组留给本窗口，其余分组新开；多目录首个留本窗口。
{
  const plan = planExternalOpen(
    [file("/a/x.ts"), file("/b/y.ts"), dir("/c"), dir("/d")],
    null,
  );
  assert.deepEqual(
    plan.inCurrentFiles.map((item) => item.path),
    ["/a/x.ts"],
  );
  assert.equal(plan.newWindowGroups.length, 1);
  assert.equal(plan.newWindowGroups[0]?.folder, "/b");
  assert.deepEqual(
    plan.inCurrentDirs.map((item) => item.path),
    [],
  );
  assert.deepEqual(
    plan.newWindowDirs.map((item) => item.path),
    ["/c", "/d"],
  );
}

{
  const onlyDirs = planExternalOpen([dir("/c"), dir("/d")], null);
  assert.deepEqual(
    onlyDirs.inCurrentDirs.map((item) => item.path),
    ["/c"],
  );
  assert.deepEqual(
    onlyDirs.newWindowDirs.map((item) => item.path),
    ["/d"],
  );
}

// 根目录文件的父目录为 `/`，与 AppShell 原逻辑一致。
assert.equal(parentDirectory("/a.ts"), "/");

// 目标路径前后空白会被清洗，便于调用方直接使用。
{
  const plan = planExternalOpen([file("  /work/demo/a.ts  ")], "/work/demo");
  assert.deepEqual(
    plan.inCurrentFiles.map((item) => item.path),
    ["/work/demo/a.ts"],
  );
}

// 新窗口文件透传随窗口 ID 写入、一次性取走。
{
  const payload = [file("/tmp/other/b.ts", 9)];
  saveBootFiles("window-x", payload);
  assert.deepEqual(takeBootFiles("window-x"), payload);
  assert.deepEqual(takeBootFiles("window-x"), []);
}

{
  saveBootFiles("window-y", [file("/tmp/other/b.ts")]);
  removeBootFiles("window-y");
  assert.deepEqual(takeBootFiles("window-y"), []);
}

console.log("外部打开路由自测通过");
