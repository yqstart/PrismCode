// ==================== 补全最近使用记忆 ====================
// 对齐 VS Code：最近接受过的补全项在下次补全时排序靠前（boost 加成）。
// key = 语言分类 + label；localStorage 持久化（上限 500 条，淘汰最旧）。
// 纯函数部分拆出便于 node 直测。

const STORAGE_KEY = "prismcode.completion.memory.v1";
const MAX_ENTRIES = 500;

export interface MemoryEntry {
  /** 接受次数 */
  count: number;
  /** 最近接受时间戳（用于淘汰最旧） */
  t: number;
}

/** 纯函数：接受次数 → boost 加成（封顶 3，避免长期记忆压过语义项） */
export function boostFromCount(count: number): number {
  return Math.min(count, 3);
}

/** 构造记忆 key（语言分类 + 补全项 label） */
export function memoryKey(language: string, label: string): string {
  return `${language}:${label}`;
}

/** 纯函数：往 map 记录一次接受（越界时淘汰最旧条目） */
export function recordMemory(
  map: Map<string, MemoryEntry>,
  key: string,
  now = Date.now(),
): void {
  const entry = map.get(key);
  if (entry) {
    entry.count += 1;
    entry.t = now;
  } else {
    map.set(key, { count: 1, t: now });
    // 淘汰最旧：条目数超限时删除 t 最小的
    if (map.size > MAX_ENTRIES) {
      let oldestKey: string | null = null;
      let oldestT = Infinity;
      for (const [k, v] of map.entries()) {
        if (v.t < oldestT) {
          oldestT = v.t;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) map.delete(oldestKey);
    }
  }
}

/** 补全记忆（浏览器单例；localStorage 不可用时降级内存） */
class CompletionMemoryImpl {
  private map = new Map<string, MemoryEntry>();
  private loaded = false;

  /** 从 localStorage 载入（幂等；浏览器环境调用一次即可） */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw =
        typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, MemoryEntry>;
      for (const [k, v] of Object.entries(parsed)) {
        if (v && typeof v.count === "number" && typeof v.t === "number") {
          this.map.set(k, { count: v.count, t: v.t });
        }
      }
    } catch {
      // 损坏数据忽略
    }
  }

  private save(): void {
    try {
      if (typeof localStorage === "undefined") return;
      const obj: Record<string, MemoryEntry> = {};
      for (const [k, v] of this.map.entries()) obj[k] = v;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch {
      // 存储满/隐私模式：忽略
    }
  }

  /** 记录一次接受 */
  record(key: string): void {
    this.load();
    recordMemory(this.map, key);
    this.save();
  }

  /** 查询 boost 加成（0-3） */
  boost(key: string): number {
    this.load();
    const entry = this.map.get(key);
    return entry ? boostFromCount(entry.count) : 0;
  }
}

export const completionMemory = new CompletionMemoryImpl();
