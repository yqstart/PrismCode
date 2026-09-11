// ==================== 自定义脚本持久化 ====================
// 自定义脚本属于当前编辑器用户的本地配置，不写入项目 package.json；按工作区根路径隔离。

const CUSTOM_KEY = "prismcode.customScripts.v1";
const MAX_CUSTOM_SCRIPTS = 64;

export interface CustomScriptItem {
  name: string;
  script: string;
}

type CustomScriptsMap = Record<string, CustomScriptItem[]>;

function normalizeItems(value: unknown): CustomScriptItem[] {
  if (!Array.isArray(value)) return [];

  const names = new Set<string>();
  const items: CustomScriptItem[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as { name?: unknown; script?: unknown };
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const script = typeof record.script === "string" ? record.script.trim() : "";
    if (!name || !script || names.has(name)) continue;
    names.add(name);
    items.push({ name, script });
    if (items.length >= MAX_CUSTOM_SCRIPTS) break;
  }
  return items;
}

function readMap(): CustomScriptsMap {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};

    const out: CustomScriptsMap = {};
    for (const [root, value] of Object.entries(parsed as Record<string, unknown>)) {
      const items = normalizeItems(value);
      if (items.length) out[root] = items;
    }
    return out;
  } catch {
    return {};
  }
}

/** 读取某个工作区的自定义脚本。 */
export function loadCustomScriptsForRoot(root: string): CustomScriptItem[] {
  return readMap()[root] ?? [];
}

/** 保存某个工作区的自定义脚本。存储不可用时保留当前会话状态。 */
export function setCustomScriptsForRoot(
  root: string,
  items: CustomScriptItem[],
): void {
  const map = readMap();
  const normalized = normalizeItems(items);
  if (normalized.length) {
    map[root] = normalized;
  } else {
    delete map[root];
  }
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(map));
  } catch {
    // 存储不可用（例如隐私模式）时静默失败，当前会话仍可继续使用。
  }
}
