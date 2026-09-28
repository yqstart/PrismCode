// ==================== 项目 Prettier 配置探测 ====================
// 内置 standalone 无法执行 .js/.toml 配置，只读取 JSON 可解析的形式：
// .prettierrc / .prettierrc.json / .prettierrc.yaml / .prettierrc.yml / package.json#prettier。
// 零配置原则：找不到配置就全默认；解析失败（如 YAML 风格 .prettierrc）则跳过。

import type { BuiltinPrettierConfig } from "./prettierRuntime";
import { joinPath, readTextFile, pathExists } from "@/shared/fs";
import { prettierConfigSearchDirs } from "./prettierConfigPath";

/** 按官方优先级候选；JSON.parse 失败的文件自动跳过 */
const CONFIG_FILES = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yaml",
  ".prettierrc.yml",
];

/** standalone 无法加载项目插件，剔除 plugins 字段避免报错 */
const DROP_KEYS = new Set(["plugins"]);

function pickConfig(raw: unknown): BuiltinPrettierConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!DROP_KEYS.has(k) && v !== undefined) out[k] = v;
  }
  return out as BuiltinPrettierConfig;
}

/**
 * 读取离当前文件最近的 JSON 形式 prettier 配置；无配置返回 null。
 * 配置探测属于「锦上添花」，任何失败（IPC 异常、权限、目录不可读）
 * 都退回全默认配置，不能阻断内置格式化。
 */
export async function loadProjectPrettierConfig(
  root: string,
  absPath: string,
): Promise<BuiltinPrettierConfig | null> {
  try {
    return await searchProjectPrettierConfig(root, absPath);
  } catch {
    return null;
  }
}

async function searchProjectPrettierConfig(
  root: string,
  absPath: string,
): Promise<BuiltinPrettierConfig | null> {
  for (const directory of prettierConfigSearchDirs(root, absPath)) {
    for (const name of CONFIG_FILES) {
      const rel = directory === "." ? name : joinPath(directory, name);
      if (!(await pathExists(root, rel))) continue;
      try {
        const parsed = JSON.parse(await readTextFile(root, rel)) as unknown;
        const config = pickConfig(parsed);
        if (config) return config;
      } catch {
        // 非 JSON 形式（YAML 等）→ 交给项目本地 prettier 处理，内置跳过
      }
    }
    try {
      const packagePath = directory === "." ? "package.json" : joinPath(directory, "package.json");
      if (await pathExists(root, packagePath)) {
        const pkg = JSON.parse(await readTextFile(root, packagePath)) as {
          prettier?: unknown;
        };
        const config = pickConfig(pkg.prettier);
        if (config) return config;
      }
    } catch {
      // package.json 解析失败 → 忽略并继续向上查找
    }
  }
  return null;
}
