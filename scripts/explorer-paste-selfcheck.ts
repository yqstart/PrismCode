import assert from "node:assert/strict";
import fs from "node:fs";
import { nextCopyName } from "../src/shared/fs.ts";

// 内部粘贴（pasteInto）与外部粘贴（pasteExternal）共用的 -copyN 命名规则。
// 规则变更必须两条链路同时生效，锁死在此：有点无扩展名、有扩展名、多重扩展名。
assert.equal(nextCopyName("a.ts", 1), "a-copy1.ts");
assert.equal(nextCopyName("a.ts", 2), "a-copy2.ts");
assert.equal(nextCopyName("archive.tar.gz", 1), "archive.tar-copy1.gz");
assert.equal(nextCopyName("Makefile", 1), "Makefile-copy1");
assert.equal(nextCopyName("dir", 3), "dir-copy3");

// store 导出 pasteExternal（静态检查：pinia store 不在 node 直测，扫源码保证接线）。
const storeSrc = fs.readFileSync("src/stores/workspace.ts", "utf8");
assert.match(storeSrc, /async function pasteExternal\(parent: string\)/);
assert.match(storeSrc, /pasteExternal,/);

// 面板接线：快捷键分支 + 共用落点/入口 + 右键菜单改走统一入口。
const panel = fs.readFileSync("src/features/explorer/ExplorerPanel.vue", "utf8");
assert.match(panel, /function resolvePasteParent\(\)/);
assert.match(panel, /async function pasteAtParent\(parent: string\)/);
assert.match(panel, /function copyOrCutSelected\(mode: "copy" \| "cut"\)/);
assert.match(panel, /await pasteAtParent\(parent\)/);

console.log("资源管理器粘贴自测通过");
