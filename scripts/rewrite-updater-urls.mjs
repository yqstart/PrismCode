#!/usr/bin/env node
/**
 * 改写 Release 资产 latest.json 中的下载 URL 为国内加速镜像直链。
 *
 * 背景：tauri-action 生成的 latest.json，资产 url 指向
 *   https://api.github.com/repos/<repo>/releases/assets/<id>
 * 该 API 端点匿名访问受限流 / 风控（403），中国大陆网络下应用内更新常因此失败。
 * 本脚本把 url 改写为 ghfast.top 镜像直链：
 *   https://ghfast.top/https://github.com/<repo>/releases/download/<tag>/<文件名>
 *
 * 用法（需 GITHUB_TOKEN，CI 自动注入；本机调试用 gh auth token）：
 *   node scripts/rewrite-updater-urls.mjs <tag>          # tag 形如 v0.13.3
 *   node scripts/rewrite-updater-urls.mjs <tag> --dry-run # 只打印改写结果，不动 Release
 * 流程：拉资产列表 → 下载 latest.json → 改写 url → 删除旧资产 → 上传新资产
 */
import { env } from "node:process";

const tag = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!tag) {
  console.error("用法: node scripts/rewrite-updater-urls.mjs <tag>（如 v0.13.3）[--dry-run]");
  process.exit(1);
}

const repo = env.GITHUB_REPOSITORY || "yqstart/PrismCode";
const token = env.GITHUB_TOKEN;
if (!token) {
  console.error("缺少 GITHUB_TOKEN 环境变量");
  process.exit(1);
}

/** GitHub 下载加速镜像前缀 */
const MIRROR_BASE = "https://ghfast.top/https://github.com";

const API = "https://api.github.com";
const headers = {
  Authorization: `Bearer ${token}`,
  "User-Agent": "PrismCode-release",
  Accept: "application/vnd.github+json",
};

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, { headers, ...opts });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} ${path}: ${detail.slice(0, 200)}`);
  }
  return res;
}

// 1. 按 tag 拿 release，再列资产：拿 latest.json 的 id 与全部 id → 文件名映射
const release = await (await api(`/repos/${repo}/releases/tags/${tag}`)).json();
const assets = await (await api(`/repos/${repo}/releases/${release.id}/assets`)).json();
const idToName = new Map(assets.map((a) => [a.id, a.name]));
const latestAsset = assets.find((a) => a.name === "latest.json");
if (!latestAsset) {
  console.error(`Release ${tag} 没有 latest.json 资产，先检查 tauri-action 是否 uploadUpdaterJson: true`);
  process.exit(1);
}

// 2. 下载最新 latest.json 并改写 url
const manifest = await (
  await api(`/repos/${repo}/releases/assets/${latestAsset.id}`, {
    headers: { ...headers, Accept: "application/octet-stream" },
  })
).json();

let rewritten = 0;
for (const [platform, entry] of Object.entries(manifest.platforms ?? {})) {
  const match = entry.url?.match(/\/assets\/(\d+)$/);
  const id = match ? Number(match[1]) : null;
  const name = id != null ? idToName.get(id) : null;
  if (!name) {
    console.warn(`跳过 ${platform}: 找不到资产映射（${entry.url}）`);
    continue;
  }
  entry.url = `${MIRROR_BASE}/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
  rewritten += 1;
}
console.log(`改写 ${rewritten}/${Object.keys(manifest.platforms ?? {}).length} 个平台的资产 url`);
if (dryRun) {
  for (const [platform, entry] of Object.entries(manifest.platforms ?? {})) {
    console.log(`  ${platform}: ${entry.url}`);
  }
  console.log("dry-run 完成，未改动 Release");
  process.exit(0);
}

// 3. 删除旧 latest.json，重新上传改写版（同名资产不能直接覆盖）
await api(`/repos/${repo}/releases/assets/${latestAsset.id}`, { method: "DELETE" });
const body = JSON.stringify(manifest, null, 2);
const upload = await fetch(
  `${API.replace("api.", "uploads.")}/repos/${repo}/releases/${release.id}/assets?name=latest.json`,
  {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body,
  },
);
if (!upload.ok) {
  throw new Error(`上传 latest.json 失败: ${upload.status}`);
}
console.log(`已上传改写后的 latest.json（${body.length} 字节）`);
