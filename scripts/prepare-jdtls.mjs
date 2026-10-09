#!/usr/bin/env node
// 下载并校验 JDTLS 与 Lombok，解压到 .artifacts/jdtls/<version>/。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { arch, platform } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, "third_party/jdtls/manifest.json"), "utf8"));
const dest = join(root, ".artifacts/jdtls", manifest.version);
const downloadDir = join(root, ".artifacts/downloads");
const archiveName = "jdt-language-server.tar.gz";
const archivePath = join(downloadDir, archiveName);
const lombokPath = join(dest, "lombok/lombok.jar");
const stampPath = join(dest, ".prepared-sha256");

function configDirName() {
  if (platform() === "darwin") return arch() === "arm64" ? "config_mac_arm" : "config_mac";
  if (platform() === "linux") return "config_linux";
  if (platform() === "win32") return "config_win";
  throw new Error(`不支持的平台：${platform()} ${arch()}`);
}

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
      if (!response.ok || !response.body) {
        throw new Error(`下载失败 ${response.status} ${url}`);
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath));
      const actual = await sha256File(destPath);
      if (actual !== expected) {
        throw new Error(`SHA-256 不一致：期望 ${expected}，实际 ${actual}`);
      }
      return;
    } catch (error) {
      lastError = error;
      console.error(`第 ${attempt} 次下载失败：${error instanceof Error ? error.message : error}`);
    }
  }
  throw lastError;
}

function hoistIfWrapped(dir) {
  const entries = readdirSync(dir).filter((name) => name !== ".prepared-sha256");
  if (entries.length !== 1) return;
  const only = join(dir, entries[0]);
  if (!statSync(only).isDirectory() || !existsSync(join(only, "plugins"))) return;
  for (const name of readdirSync(only)) {
    renameSync(join(only, name), join(dir, name));
  }
  rmSync(only, { recursive: true, force: true });
}

const expectedStamp = `${manifest.archiveSHA256}\n${manifest.lombokSHA256}`;
if (existsSync(stampPath) && readFileSync(stampPath, "utf8") === expectedStamp) {
  console.log(dest);
  process.exit(0);
}

await download(manifest.archiveURL, archivePath, manifest.archiveSHA256);
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
execFileSync("tar", ["-xzf", archivePath, "-C", dest], { stdio: "inherit" });
hoistIfWrapped(dest);
mkdirSync(dirname(lombokPath), { recursive: true });
await download(manifest.lombokURL, lombokPath, manifest.lombokSHA256);

const configName = configDirName();
const missing = [];
if (!existsSync(join(dest, "plugins"))) missing.push("plugins/");
if (!existsSync(join(dest, configName))) missing.push(configName);
if (!existsSync(lombokPath)) missing.push("lombok/lombok.jar");
if (missing.length) {
  throw new Error(`JDTLS 产物不完整：${missing.join("、")}`);
}
const launchers = readdirSync(join(dest, "plugins")).filter((name) =>
  /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(name),
);
if (!launchers.length) throw new Error("未找到 org.eclipse.equinox.launcher_*.jar");

writeStamp(dest, stampPath, expectedStamp);
console.log(dest);

function writeStamp(dir, path, contents) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, contents);
}
