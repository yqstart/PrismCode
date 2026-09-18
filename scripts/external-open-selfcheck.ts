import assert from "node:assert/strict";
import {
  parentDirectory,
  planExternalOpen,
  removeBootFiles,
  saveBootFiles,
  takeBootFiles,
} from "../src/shared/externalOpenRoute.ts";
import { fileScopeRoot } from "../src/shared/fileScope.ts";
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

// 已在工作区的文件留在本窗口；工作区外文件走 light 窗口，不按父目录建项目窗口。
{
  const plan = planExternalOpen(
    [file("/work/demo/src/a.ts"), file("/tmp/other/b.ts"), file("/tmp/other/c.ts:9")],
    "/work/demo",
  );
  assert.deepEqual(
    plan.inCurrentFiles.map((item) => item.path),
    ["/work/demo/src/a.ts"],
  );
  assert.deepEqual(
    plan.lightFiles.map((item) => item.path),
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
  assert.deepEqual(plan.lightFiles, []);
}

// 无工作区（欢迎页 / light 窗口）：文件就地打开，不再为其新开项目窗口；
// 目录在有文件时全部新开，只有目录时首个留给本窗口。
{
  const plan = planExternalOpen(
    [file("/a/x.ts"), file("/b/y.ts"), dir("/c"), dir("/d")],
    null,
  );
  assert.deepEqual(
    plan.inCurrentFiles.map((item) => item.path),
    ["/a/x.ts", "/b/y.ts"],
  );
  assert.deepEqual(plan.lightFiles, []);
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

// 读写作用域：项目窗口用工作区根；light 模式用文件所在目录（后端要求目标在 root 内）。
{
  assert.equal(fileScopeRoot("/work/demo", "/work/demo/src/a.ts"), "/work/demo");
  assert.equal(fileScopeRoot(null, "/Users/me/notes/todo.md"), "/Users/me/notes");
  assert.equal(fileScopeRoot("  ", "/tmp/other/b.ts"), "/tmp/other");
  assert.equal(fileScopeRoot(null, "/a.ts"), "/");
  assert.equal(fileScopeRoot(null, "a.ts"), null);
  assert.equal(fileScopeRoot(null, "   "), null);
  assert.equal(fileScopeRoot(undefined, ""), null);
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
