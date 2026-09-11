// ==================== macOS 目录授权书签自测 ====================
// 验证书签的恢复、持久化和失效清理逻辑；通过 mock Tauri IPC 运行，不依赖 macOS UI。

import {
  resolveBookmark,
  saveBookmark,
} from "../src/shared/securityScoped.ts";

type Stored = Map<string, string>;
type InvokeCall = { command: string; args: Record<string, unknown> };

const stored: Stored = new Map();
const calls: InvokeCall[] = [];
let rejectResolve = false;

(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
  clear: () => stored.clear(),
  key: (index: number) => [...stored.keys()][index] ?? null,
  get length() {
    return stored.size;
  },
} as Storage;

(globalThis as typeof globalThis & {
  window: {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
    };
  };
}).window = {
  __TAURI_INTERNALS__: {
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "resolve_security_scoped_bookmarks") {
        if (rejectResolve) throw new Error("bookmark 已失效");
        return true;
      }
      if (command === "create_security_scoped_bookmarks") return "bookmark-v2";
      throw new Error(`未知命令: ${command}`);
    },
  },
};

let failed = 0;
function assert(name: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}`, detail ?? "");
  }
}

const storeKey = "prismcode.securityScopedBookmarks.v1";
const root = "/workspace/demo";
const staleRoot = "/workspace/stale";
stored.set(storeKey, JSON.stringify({ [root]: "bookmark-v1" }));

assert("已有书签可恢复目录授权", await resolveBookmark(root));
assert(
  "恢复调用携带正确路径和书签",
  calls[0]?.command === "resolve_security_scoped_bookmarks" &&
    calls[0]?.args.path === root &&
    calls[0]?.args.bookmark === "bookmark-v1",
  calls[0],
);

const callsBeforeMissing = calls.length;
assert("没有书签时不调用 IPC", !(await resolveBookmark("/workspace/new")) && calls.length === callsBeforeMissing);

await saveBookmark(root);
const saved = JSON.parse(stored.get(storeKey) ?? "{}") as Record<string, string>;
assert("新书签写回本地存储", saved[root] === "bookmark-v2", saved);

stored.set(storeKey, JSON.stringify({ [staleRoot]: "bookmark-stale" }));
rejectResolve = true;
assert("失效书签恢复失败", !(await resolveBookmark(staleRoot)));
const afterCleanup = JSON.parse(stored.get(storeKey) ?? "{}") as Record<string, string>;
assert("失效书签自动清理", !(staleRoot in afterCleanup), afterCleanup);

console.log(`\n通过 ${6 - failed}，失败 ${failed}`);
if (failed > 0) process.exit(1);
