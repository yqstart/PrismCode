// ==================== 用户自定义 snippets（VS Code snippets.json 体系） ====================
// 支持源：全局 ~/.prismcode/snippets/*.json（Rust snippets_read_global）+ 项目 .vscode/*.code-snippets。
// 格式与 VS Code 一致：{ name: { prefix: string|string[], body: string|string[], description?, scope? } }。
// 占位符 $1/${1:default} 由补全 apply 做光标定位（复用 adapters 的占位逻辑）。
// 解析/过滤为纯函数（零依赖，node 直测）；加载走 Tauri invoke（动态 import 保持顶层零依赖）。

/** 取文件名（POSIX 语义，零依赖保持可直测） */
function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

export interface UserSnippet {
  /** JSON key（展示名） */
  name: string;
  /** 触发前缀 */
  prefix: string[];
  /** 展开文本（VS Code snippet 语法） */
  body: string;
  description: string | undefined;
  /** 语言 id 列表（scope 字段；空 = 全部语言） */
  scope: string[] | undefined;
}

/** 解析 VS Code snippets JSON → UserSnippet[]（纯函数；非法项跳过） */
export function parseSnippetsJson(json: string): UserSnippet[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof data !== "object" || data === null) return [];
  const out: UserSnippet[] = [];
  for (const [name, raw] of Object.entries(data as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const s = raw as Record<string, unknown>;
    const prefixRaw = s.prefix;
    const bodyRaw = s.body;
    if (typeof prefixRaw !== "string" && !Array.isArray(prefixRaw)) continue;
    if (typeof bodyRaw !== "string" && !Array.isArray(bodyRaw)) continue;
    const prefix = Array.isArray(prefixRaw) ? prefixRaw : [prefixRaw];
    const body = Array.isArray(bodyRaw) ? bodyRaw.join("\n") : bodyRaw;
    if (!prefix.length || !body) continue;
    // 过滤空前缀后再检查（`prefix: ""` 应跳过）
    const cleaned = prefix.filter((p) => typeof p === "string" && p.length > 0);
    if (!cleaned.length) continue;
    const scopeRaw = typeof s.scope === "string" ? s.scope : "";
    out.push({
      name,
      prefix: cleaned,
      body,
      description: typeof s.description === "string" ? s.description : undefined,
      scope: scopeRaw
        ? scopeRaw.split(",").map((x) => x.trim()).filter(Boolean)
        : undefined,
    });
  }
  return out;
}

/** scope 过滤：snippet 无 scope 或包含当前语言 id → true */
export function snippetMatchesScope(
  snippet: UserSnippet,
  languageId: string,
): boolean {
  if (!snippet.scope || snippet.scope.length === 0) return true;
  return snippet.scope.includes(languageId);
}

/** 文件路径 → VS Code languageId（snippet scope 匹配用） */
export function languageIdFor(filePath: string): string {
  const name = basename(filePath).toLowerCase();
  if (/\.(tsx|ts|mts|cts)$/.test(name)) return "typescript";
  if (/\.(jsx|js|mjs|cjs)$/.test(name)) return "javascript";
  if (/\.(html|htm)$/.test(name)) return "html";
  if (name.endsWith(".vue")) return "vue";
  if (name.endsWith(".css")) return "css";
  if (name.endsWith(".scss")) return "scss";
  if (name.endsWith(".less")) return "less";
  if (name.endsWith(".sass")) return "sass";
  if (name.endsWith(".json")) return "json";
  if (/\.(md|markdown)$/.test(name)) return "markdown";
  if (/\.(yaml|yml)$/.test(name)) return "yaml";
  if (name.endsWith(".xml")) return "xml";
  if (name.endsWith(".svg")) return "svg";
  return "";
}

// ==================== 加载（全局 + 项目） ====================

let globalCache: UserSnippet[] | null = null;

/** 加载全局 snippets（~/.prismcode/snippets/*.json，缓存） */
export async function loadGlobalSnippets(): Promise<UserSnippet[]> {
  if (globalCache) return globalCache;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const files = await invoke<Array<[string, string]>>("snippets_read_global");
    const all: UserSnippet[] = [];
    for (const [, content] of files) {
      all.push(...parseSnippetsJson(content));
    }
    globalCache = all;
  } catch {
    globalCache = [];
  }
  return globalCache;
}

/** 加载项目 snippets（.vscode/*.code-snippets，无缓存——项目文件可能变化） */
export async function loadProjectSnippets(root: string): Promise<UserSnippet[]> {
  try {
    const { listDir, readTextFile } = await import("@/shared/fs");
    let entries;
    try {
      entries = await listDir(root, `${root}/.vscode`);
    } catch {
      return [];
    }
    const out: UserSnippet[] = [];
    for (const e of entries) {
      if (!e.name.endsWith(".code-snippets") && !e.name.endsWith(".json")) continue;
      try {
        const content = await readTextFile(root, e.path);
        out.push(...parseSnippetsJson(content));
      } catch {
        // 单文件失败跳过
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 合并加载全部用户 snippets（全局 + 项目） */
export async function loadUserSnippets(root: string): Promise<UserSnippet[]> {
  const [global, project] = await Promise.all([
    loadGlobalSnippets(),
    root ? loadProjectSnippets(root) : Promise.resolve([]),
  ]);
  return [...global, ...project];
}
