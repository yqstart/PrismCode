#!/usr/bin/env node
// 下载当前平台的 Temurin 21 JDK，并用其 jlink 生成 .artifacts/jre。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { arch, platform } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, "third_party/jre/manifest.json"), "utf8"));
const platformId =
  platform() === "darwin"
    ? arch() === "arm64"
      ? "darwin-arm64"
      : "darwin-x64"
    : platform() === "win32"
      ? "windows-x64"
      : platform() === "linux"
        ? "linux-x64"
        : "";
const spec = manifest.platforms[platformId];
if (!spec) throw new Error(`manifest 没有当前平台 ${platform()} ${arch()}`);

const downloadDir = join(root, ".artifacts/downloads/jdk");
const archivePath = join(downloadDir, spec.archiveURL.split("/").pop());
const extractDir = join(downloadDir, "extract");
const output = join(root, ".artifacts/jre");
const modules = [
  "java.se",
  "jdk.attach",
  "jdk.compiler",
  "jdk.javadoc",
  "jdk.jartool",
  "jdk.unsupported",
  "jdk.zipfs",
  "jdk.httpserver",
  "jdk.management",
  "jdk.management.agent",
  "jdk.crypto.ec",
  "jdk.localedata",
  "jdk.jdwp.agent",
  // JDI：java-debug 插件（调试适配器）依赖 com.sun.jdi.*，java.se 不含任何 jdk.* 模块
  "jdk.jdi",
].join(",");

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

async function download(url, destPath, expected) {
  mkdirSync(dirname(destPath), { recursive: true });
  if (existsSync(destPath) && (await sha256File(destPath)) === expected) {
    console.log(`缓存命中 ${destPath}`);
    return;
  }
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok || !response.body) throw new Error(`下载失败 ${response.status} ${url}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath));
      const actual = await sha256File(destPath);
      if (actual !== expected) throw new Error(`SHA-256 不一致：期望 ${expected}，实际 ${actual}`);
      return;
    } catch (error) {
      lastError = error;
      console.error(`第 ${attempt} 次下载失败：${error instanceof Error ? error.message : error}`);
    }
  }
  throw lastError;
}

function isMachO(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(4);
    if (readSync(fd, buf, 0, 4, 0) < 4) return false;
    const le = buf.readUInt32LE(0);
    const be = buf.readUInt32BE(0);
    return le === 0xfeedface || le === 0xfeedfacf || be === 0xcafebabe || be === 0xbebafeca;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function findJdkHome(dir, depth = 0) {
  const jlinkName = platform() === "win32" ? "jlink.exe" : "jlink";
  const candidates = [
    join(dir, "bin", jlinkName),
    join(dir, "Contents", "Home", "bin", jlinkName),
    join(dir, spec.extractRoot, "bin", jlinkName),
    join(dir, spec.extractRoot, "Contents", "Home", "bin", jlinkName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return dirname(dirname(candidate));
  }
  if (depth > 2) return null;
  for (const name of readdirSync(dir)) {
    const child = join(dir, name);
    if (!statSync(child).isDirectory()) continue;
    const found = findJdkHome(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function codesignTree(dir) {
  if (platform() !== "darwin") return;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const info = statSync(path);
      if (info.isDirectory()) stack.push(path);
      else if (info.isFile() && isMachO(path)) {
        execFileSync("codesign", ["--force", "--sign", "-", path], { stdio: "inherit" });
      }
    }
  }
}

await download(spec.archiveURL, archivePath, spec.archiveSHA256);
rmSync(extractDir, { recursive: true, force: true });
mkdirSync(extractDir, { recursive: true });
execFileSync("tar", ["-xf", archivePath, "-C", extractDir], { stdio: "inherit" });
const jdkHome = findJdkHome(extractDir);
if (!jdkHome) throw new Error(`解压后未找到 jlink（记录的根目录名：${spec.extractRoot}）`);
const jlink = join(jdkHome, "bin", platform() === "win32" ? "jlink.exe" : "jlink");

rmSync(output, { recursive: true, force: true });
const baseArgs = [
  `--add-modules=${modules}`,
  "--strip-debug",
  "--no-header-files",
  "--no-man-pages",
  "--output",
  output,
];
try {
  execFileSync(jlink, ["--compress=zip-6", ...baseArgs], { stdio: "inherit" });
} catch {
  rmSync(output, { recursive: true, force: true });
  try {
    execFileSync(jlink, ["--compress=2", ...baseArgs], { stdio: "inherit" });
  } catch (error) {
    console.error("jlink 失败，改用完整 Temurin JDK 作为 .artifacts/jre");
    rmSync(output, { recursive: true, force: true });
    execFileSync("cp", ["-R", jdkHome, output], { stdio: "inherit" });
    if (error instanceof Error) console.error(error.message);
  }
}
codesignTree(output);
execFileSync("du", ["-sh", output], { stdio: "inherit" });
const javaBin = join(output, "bin", platform() === "win32" ? "java.exe" : "java");
console.log(javaBin);
