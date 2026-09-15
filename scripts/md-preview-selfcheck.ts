// ==================== MD 预览查找自测 ====================
// 覆盖 previewFind 纯函数（大小写/正则/全词/非法正则/空查询/零宽/上限）
// 与 EditorArea 接线（去 key 防闪屏、回顶、⌘F 路由、mark 包裹）。

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildPreviewFindRegExp,
  findPreviewMatches,
} from "../src/features/editor/markdown/previewFind.ts";

const OPTS = { caseSensitive: false, regexp: false, wholeWord: false };

// 纯文本默认不区分大小写
assert.equal(findPreviewMatches("Hello hello HELLO", "hello", OPTS).length, 3);
// 区分大小写
assert.deepEqual(findPreviewMatches("Hello hello", "hello", {
  ...OPTS,
  caseSensitive: true,
}), [{ from: 6, to: 11 }]);
// 非正则下元字符按字面匹配
assert.deepEqual(findPreviewMatches("a.b aab", "a.b", OPTS), [{ from: 0, to: 3 }]);
// 正则模式
assert.equal(
  findPreviewMatches("aab abb", "a+b", { ...OPTS, regexp: true }).length,
  2,
);
// 非法正则吞掉为空
assert.deepEqual(findPreviewMatches("abc", "(", { ...OPTS, regexp: true }), []);
assert.equal(buildPreviewFindRegExp("(", { ...OPTS, regexp: true }), null);
// 空查询无结果
assert.deepEqual(findPreviewMatches("abc", "   ", OPTS), []);
assert.equal(buildPreviewFindRegExp("   ", OPTS), null);
// 全词匹配：hello 内的 he 不算
assert.deepEqual(findPreviewMatches("he hello he", "he", {
  ...OPTS,
  wholeWord: true,
}), [{ from: 0, to: 2 }, { from: 9, to: 11 }]);
// 零宽匹配不收录
assert.deepEqual(findPreviewMatches("abc", "^", { ...OPTS, regexp: true }), []);
// 上限 cap
assert.equal(findPreviewMatches("a a a a a", "a", OPTS, 2).length, 2);

const root = process.cwd();
const area = await readFile(resolve(root, "src/app/EditorArea.vue"), "utf8");
// 闪屏：预览容器去 key 复用，切文件只换 v-html，不触发 canvas 离场/进场动画
assert.doesNotMatch(area, /:key="`md-/);
// 切文件后回到顶部（容器复用后 scrollTop 不再自动重置，需手动回顶）
assert.match(area, /mdPreviewRef\.value\.scrollTop = 0/);
// ⌘F 信号路由：预览态走 openMdFind，其余态放行给 CodeMirror
assert.match(area, /watch\(findRequest[\s\S]*?openMdFind\(\)/);
// 预览 DOM 包裹 mark 高亮，查询编译走共享语义
assert.match(area, /buildPreviewFindRegExp\(/);
assert.match(area, /mark\.md-find-match/);
// 浮层可见性只在 MD 预览态
assert.match(area, /mdFindVisible/);
// 查找浮层与模式切换同为 .canvas 浮层，不进全屏叠放（否则 inset:0 撑满画布）
assert.match(area, /\.canvas > :not\(\.md-mode-toggle\):not\(\.md-find-panel\)/);
// 浮层隐藏恢复（SSH/GitLog 切回）时 DOM 重建，需重打高亮
assert.match(area, /watch\(mdFindVisible/);

console.log("MD 预览查找自测通过");
