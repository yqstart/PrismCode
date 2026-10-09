#!/usr/bin/env node
// 下载 java-debug 插件 jar（Microsoft，EPL-1.0）与随包许可，校验后落到
// .artifacts/debug-adapter/<version>/。
//
// 与 JDTLS 不同，这里没有归档可解：产物就是单个 Eclipse 插件 jar（无 Main-Class，
// 由 JDTLS 通过 initializationOptions.bundles 装载，DAP 走它开出的 TCP 端口）。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const manifest = JSON.parse(
  readFileSync(join(root, "third_party/debug-adapter/manifest.json"), "utf8"),
);
const dest = join(root, ".artifacts/debug-adapter", manifest.version);
const jarPath = join(dest, manifest.jarName);
const licensePath = join(dest, "LICENSE.txt");
const stampPath = join(dest, ".prepared-sha256");

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function download(url, destPath, expected) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`下载失败 ${response.status}: ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`校验和不匹配: ${url}\n期望 ${expected}\n实际 ${actual}`);
  }
  const temporary = `${destPath}.download`;
  writeFileSync(temporary, bytes);
  rmSync(destPath, { force: true });
  renameSync(temporary, destPath);
}

const expectedStamp = `${manifest.archiveSHA256}\n${manifest.licenseSHA256}`;
if (existsSync(stampPath) && readFileSync(stampPath, "utf8") === expectedStamp) {
  // 产物与戳都在：不重复下载
  const intact =
    existsSync(jarPath) &&
    sha256File(jarPath) === manifest.archiveSHA256 &&
    existsSync(join(dest, "adapter.json"));
  if (intact) {
    console.log(dest);
    process.exit(0);
  }
}

mkdirSync(dest, { recursive: true });
await download(manifest.archiveURL, jarPath, manifest.archiveSHA256);
await download(manifest.licenseURL, licensePath, manifest.licenseSHA256);

const size = statSync(jarPath).size;
if (size !== manifest.archiveSize) {
  throw new Error(`jar 大小不符：期望 ${manifest.archiveSize}，实际 ${size}`);
}
// 插件 jar 必须带 OSGi 清单与扩展点声明，否则装进 JDTLS 也不会注册命令
const entries = execFileSync("tar", ["-tf", jarPath], { encoding: "utf8" });
for (const required of ["META-INF/MANIFEST.MF", "plugin.xml"]) {
  if (!entries.includes(required)) {
    throw new Error(`jar 缺少 ${required}，可能不是 java-debug 插件`);
  }
}

// Rust 侧按这份描述定位 jar（不猜文件名）
writeFileSync(
  join(dest, "adapter.json"),
  `${JSON.stringify({ version: manifest.version, jar: manifest.jarName }, null, 2)}\n`,
);
writeFileSync(stampPath, expectedStamp);
console.log(dest);
