// ==================== 终端顶栏勾选脚本持久化 ====================
// 按项目（工作区根路径）记录「展示到终端顶栏」的 package.json scripts 勾选集合。
// 独立 localStorage key（仿 recentFolders 模式），不污染 AppSettings 全局结构。

const PINNED_KEY = "prismcode.pinnedScripts.v1";

type PinnedMap = Record<string, string[]>;

function readMap(): PinnedMap {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    // 逐值校验：损坏/旧版本数据（值非字符串数组）过滤掉，
    // 否则 pinnedScripts computed 调用 includes 会抛 TypeError
    const out: PinnedMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value) && value.every((x) => typeof x === "string")) {
        out[key] = value as string[];
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** 某项目的勾选脚本名数组（不存在返回空数组） */
export function loadPinnedForRoot(root: string): string[] {
  return readMap()[root] ?? [];
}

/** 写入某项目的勾选集合并落盘 */
export function setPinnedForRoot(root: string, names: string[]): void {
  const map = readMap();
  if (names.length > 0) {
    map[root] = [...new Set(names)];
  } else {
    delete map[root];
  }
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(map));
  } catch {
    // 存储不可用（隐私模式等）时静默失败，勾选仅本次会话生效
  }
}
