// ==================== MD 预览查找自测 ====================
// 覆盖 previewFind 纯函数（大小写/正则/全词/非法正则/空查询/零宽/上限）
// 与 EditorArea 接线（去 key 防闪屏、回顶、⌘F 路由、mark 包裹）
// 与 preview.ts link 渲染器（tokens 直渲防栈溢出）与渲染失败回退编辑态。

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildPreviewFindRegExp,
  findPreviewMatches,
} from "../src/features/editor/markdown/previewFind.ts";
import { renderMarkdown } from "../src/features/editor/markdown/preview.ts";

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

// link 渲染器必须用 tokens 直渲（this.parser.parseInline(tokens)），
// 禁止回炉重走 inline 词法器（marked.parseInline(text)）：
// 未闭合输入（[a](http://x / 裸 URL / autolink / email）会触发
// tokenizer ↔ renderer 互递归栈溢出，预览 computed 抛错整区白屏。
const preview = await readFile(
  resolve(root, "src/features/editor/markdown/preview.ts"),
  "utf8",
);
assert.doesNotMatch(preview, /const content = marked\.parseInline\(/);
assert.match(preview, /this\.parser\.parseInline\(tokens/);
// 渲染失败回退编辑态：computed 内消化异常并记失败路径，模板分支互补
assert.match(area, /mdRenderFailed/);
assert.match(area, /!mdRenderFailed/);
// 曾栈溢出的输入全部可渲染（回归核心：裸 URL / autolink / email / 未闭合链接）
assert.doesNotThrow(() => renderMarkdown("[abc](http://x"));
assert.doesNotThrow(() => renderMarkdown("裸URL http://example.com 测试"));
assert.doesNotThrow(() => renderMarkdown("<http://example.com>"));
assert.doesNotThrow(() => renderMarkdown("email test@example.com"));
assert.doesNotThrow(() => renderMarkdown("# 标题\n\n[坏](http://x\n\n正文"));
// 安全防线不退化：危险协议仍降级 span，xss 载荷仍转义
assert.match(renderMarkdown("[a](javascript:alert(1))"), /<span/);
assert.doesNotMatch(renderMarkdown("[a](javascript:alert(1))"), /<a\s+href/);
// raw HTML 文本经转义后无可执行标签（尖括号已转义，仅文本形态残留属性名）
assert.doesNotMatch(
  renderMarkdown("[<img src=x onerror=alert(1)>](https://x)"),
  /<img|<script/i,
);
// 正常链接仍可用：target=_blank + noopener
assert.match(
  renderMarkdown("[x](https://example.com)"),
  /<a href="https:\/\/example\.com"[^>]*target="_blank"/,
);
assert.match(
  renderMarkdown("[*em* **b**](https://x)"),
  /<em>em<\/em> <strong>b<\/strong>/,
);

console.log("MD 预览查找自测通过");
