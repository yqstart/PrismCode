import {
  clearMainWindowRoot,
  getWindowSessionId,
  loadMainWindowRoot,
  saveMainWindowRoot,
} from "../src/shared/windowSession.ts";
import {
  loadEditorSession,
  saveEditorSession,
} from "../src/shared/editorSession.ts";
import {
  loadTerminalSession,
  saveTerminalSession,
} from "../src/shared/terminalSession.ts";

type Stored = Map<string, string>;
const stored: Stored = new Map();
const locationStub = { search: "?windowId=window-a" };
(globalThis as typeof globalThis & {
  localStorage: Storage;
  window: { location: { search: string } };
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
(globalThis as typeof globalThis & {
  window: { location: { search: string } };
}).window = { location: locationStub };

let failed = 0;
let total = 0;
function assert(name: string, condition: boolean, detail?: unknown): void {
  total += 1;
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}`, detail ?? "");
  }
}

const windowSessionsKey = "prismcode.window-sessions.v1";
const root = "/workspace/demo";
const fileA = "/workspace/demo/src/a.ts";
const fileB = "/workspace/demo/src/b.ts";

assert("从 URL 读取稳定窗口 ID", getWindowSessionId() === "window-a");

saveMainWindowRoot(root);
assert(
  "动态窗口不写主窗口锚点",
  loadMainWindowRoot() === null,
  loadMainWindowRoot(),
);

locationStub.search = "";
saveMainWindowRoot(root);
assert("主窗口工作区可读写", loadMainWindowRoot() === root, loadMainWindowRoot());
saveMainWindowRoot("/workspace/other");
assert(
  "重新打开工作区会覆盖旧锚点",
  loadMainWindowRoot() === "/workspace/other",
  loadMainWindowRoot(),
);

stored.set(
  windowSessionsKey,
  JSON.stringify([
    { id: "window-b", root: "/workspace/b", updatedAt: 1 },
    { id: "main", root: "/workspace/legacy", updatedAt: 2 },
  ]),
);
assert(
  "兼容旧版多窗口索引，只取 main 记录",
  loadMainWindowRoot() === "/workspace/legacy",
  loadMainWindowRoot(),
);
saveMainWindowRoot(root);
assert(
  "写入后只保留主窗口一条记录",
  (JSON.parse(stored.get(windowSessionsKey) ?? "[]") as unknown[]).length === 1,
  stored.get(windowSessionsKey),
);

clearMainWindowRoot();
assert("主窗口关闭后清除锚点", loadMainWindowRoot() === null);

saveMainWindowRoot(root);
locationStub.search = "?windowId=window-a";
clearMainWindowRoot();
assert(
  "动态窗口关闭不清除主窗口锚点",
  loadMainWindowRoot() === root,
  loadMainWindowRoot(),
);

saveEditorSession(root, {
  tabs: [
    {
      path: fileA,
      cursor: { line: 3, column: 2 },
      pinned: true,
    },
  ],
  activePath: fileA,
}, "window-a");
saveEditorSession(root, {
  tabs: [
    {
      path: fileB,
      cursor: { line: 8, column: 1 },
      pinned: false,
    },
  ],
  activePath: fileB,
}, "window-b");
assert(
  "同一工作区的编辑器会话按窗口隔离",
  loadEditorSession(root, "window-a")?.activePath === fileA &&
  loadEditorSession(root, "window-b")?.activePath === fileB,
);

saveTerminalSession(
  root,
  {
    localTerminals: [{ id: "local-1", title: "终端 1", cwd: root }],
    activeLocalId: "local-1",
    open: true,
    dormant: false,
  },
  "window-a",
);
saveTerminalSession(
  root,
  {
    localTerminals: [
      { id: "local-1", title: "终端 1", cwd: "/workspace/other" },
      { id: "local-2", title: "终端 2", cwd: "/workspace/other" },
    ],
    activeLocalId: "local-2",
    open: false,
    dormant: true,
  },
  "window-b",
);
assert(
  "终端标签和展开状态按窗口隔离",
  loadTerminalSession(root, "window-a")?.localTerminals.length === 1 &&
  loadTerminalSession(root, "window-a")?.open === true &&
  loadTerminalSession(root, "window-b")?.localTerminals.length === 2 &&
  loadTerminalSession(root, "window-b")?.activeLocalId === "local-2" &&
  loadTerminalSession(root, "window-b")?.dormant === true,
);

console.log(`\n通过 ${total - failed}，失败 ${failed}`);
if (failed > 0) process.exit(1);
