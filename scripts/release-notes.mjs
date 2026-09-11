#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 提取指定版本说明，供 GitHub Release / CI 使用。
 * 用法：
 *   node scripts/release-notes.mjs [version]
 *   version 缺省时读 package.json
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractChangelogSection(markdown, version) {
  const v = version.replace(/^v/i, "").trim();
  if (!v) return null;
  // 注意：勿用 /m 下的 `$` 作节尾锚点，会在标题行末就截断
  const startRe = new RegExp(`^## \\[${escapeRegExp(v)}\\][^\\n]*`, "m");
  const startMatch = markdown.match(startRe);
  if (!startMatch || startMatch.index === undefined) return null;
  const start = startMatch.index;
  const afterHeader = markdown.slice(start + startMatch[0].length);
  const nextIdx = afterHeader.search(/\n## \[/);
  const section =
    nextIdx === -1
      ? markdown.slice(start)
      : markdown.slice(start, start + startMatch[0].length + nextIdx);
  return section.trim();
}

function readVersion(arg) {
  if (arg) return arg.replace(/^v/i, "").trim();
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return String(pkg.version ?? "").trim();
}

const INSTALL_FOOTER = `
---

### 安装包

多平台安装包由 GitHub Actions 自动构建。

- macOS：\`.dmg\`（Apple Silicon / Intel 各一）
- Windows：\`.msi\` / \`.exe\`
- Linux：\`.deb\` / \`.AppImage\`

应用内可通过「设置 → 关于 → 检查更新」或启动时自动检查升级。
macOS 已 ad-hoc 签名；若仍提示「未验证开发者」，请右键 → 打开。首次安装若见「已损坏」，见 [多平台发布.md](https://github.com/yqstart/PrismCode/blob/master/docs/多平台发布.md#macos安装后提示已损坏无法打开)。
Windows 若 SmartScreen 提示「已保护你的电脑」，见 [多平台发布.md · Windows](https://github.com/yqstart/PrismCode/blob/master/docs/多平台发布.md#windowssmartscreen-提示已保护你的电脑)（更多信息 → 仍要运行）。
`.trim();

const version = readVersion(process.argv[2]);
if (!version) {
  console.error("无法确定版本号");
  process.exit(1);
}

const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const section = extractChangelogSection(changelog, version);
if (!section) {
  console.error(`CHANGELOG.md 中未找到版本 ${version} 的章节（## [${version}]）`);
  process.exit(1);
}

// 去掉 Keep a Changelog 标题行，Release / 应用内直接展示「新增 / 修复」
const body = section.replace(/^## \[[^\]]+\][^\n]*\n*/, "").trim();

process.stdout.write(`${body}\n\n${INSTALL_FOOTER}\n`);
