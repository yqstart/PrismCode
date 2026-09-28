// ==================== 同步 Material Icon Theme 图标到 public ====================
// 图标不经过 Rollup 模块图：1250 个 SVG 作为 glob 模块会让 Vite 构建内存飙升
// （CI 的 macOS runner 上会直接 V8 堆溢出），改为构建前复制到 public/icon-theme/，
// 运行时按 id 拼 URL 访问。增量复制，已存在且大小一致的文件跳过。
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules/material-icon-theme/icons");
const target = join(root, "public/icon-theme");

if (!existsSync(source)) {
  console.error("[icon-assets] 未找到 material-icon-theme，先执行 pnpm install");
  process.exit(1);
}

await mkdir(target, { recursive: true });

const entries = await readdir(source);
let copied = 0;
let skipped = 0;

for (const name of entries) {
  if (!name.endsWith(".svg")) continue;
  const from = join(source, name);
  const to = join(target, name);
  try {
    const [sourceStat, targetStat] = await Promise.all([
      stat(from),
      stat(to).catch(() => null),
    ]);
    if (targetStat && targetStat.size === sourceStat.size && targetStat.mtimeMs >= sourceStat.mtimeMs) {
      skipped += 1;
      continue;
    }
    await cp(from, to);
    copied += 1;
  } catch (error) {
    console.error(`[icon-assets] 复制 ${name} 失败: ${error.message}`);
    process.exit(1);
  }
}

console.log(`[icon-assets] 图标资源就绪：新增/更新 ${copied}，复用 ${skipped}`);
