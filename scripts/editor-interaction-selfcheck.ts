// ==================== 编辑器交互自测 ====================
// 验证普通鼠标点击与导航、Git blame 浮层的触发边界，避免交互回归。

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const navigationSource = await readFile(
  resolve(root, "src/features/editor/navigation.ts"),
  "utf8",
);
const blameSource = await readFile(
  resolve(root, "src/features/editor/gitBlame.ts"),
  "utf8",
);

assert.doesNotMatch(
  navigationSource,
  /EditorView\.domEventHandlers\(\{\s*click\(event,\s*view\)/s,
  "普通鼠标点击不应直接触发声明跳转",
);
assert.doesNotMatch(
  blameSource,
  /hoverTooltip\(/,
  "Git blame 不应在鼠标悬停代码时自动弹出",
);
assert.match(
  blameSource,
  /click\(event,\s*view\)/,
  "Git blame 应通过显式点击触发",
);
assert.match(
  blameSource,
  /cm-lineNumbers.*cm-prism-blame/s,
  "Git blame 触发区域应限制在行号或 blame gutter",
);

console.log("编辑器交互自测通过");
