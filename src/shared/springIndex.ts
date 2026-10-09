// ==================== Spring 索引的前端纯逻辑 ====================
// 只做数据形状与文本推断，不 import monaco/vue，node --experimental-strip-types 可直测。
// 字段与 Rust 命令 `spring_index` 的出参一一对应（camelCase）。

export interface SpringProperty {
  name: string;
  /** 元数据里的默认值；没有默认值时为 null */
  defaultValue: string | null;
  /** 来源：`project` 或提供元数据的 jar 文件名 */
  source: string;
}

export interface SpringValue {
  path: string;
  name: string;
  value: string;
}

export interface SpringBean {
  name: string;
  type: string;
  path: string;
  line: number;
}

export interface SpringInjection {
  path: string;
  line: number;
  bean: string;
}

export interface SpringEndpoint {
  path: string;
  /** HTTP 方法，如 GET/POST */
  method: string;
  route: string;
  /** 映射注解所在行（1 起） */
  line: number;
}

export interface SpringDiagnostic {
  path: string;
  line: number;
  message: string;
}

export interface SpringIndex {
  properties: SpringProperty[];
  values: SpringValue[];
  beans: SpringBean[];
  injections: SpringInjection[];
  endpoints: SpringEndpoint[];
  diagnostics: SpringDiagnostic[];
}

/** 空索引：空项目（无 Spring 依赖/注解）与失败回退共用同一形状 */
export function emptySpringIndex(): SpringIndex {
  return {
    properties: [],
    values: [],
    beans: [],
    injections: [],
    endpoints: [],
    diagnostics: [],
  };
}

/** 供 provider 生成 marker 的最小字段：坐标与文案由 provider 补 |
 * （path 为工作区相对路径，line 为 1 起行号） */
export interface SpringMarkerInput {
  path: string;
  line: number;
  message: string;
}

export function springMarkerInputs(index: SpringIndex): SpringMarkerInput[] {
  return index.diagnostics.map((item) => ({
    path: item.path,
    line: item.line,
    message: item.message,
  }));
}

export interface SpringCompletionItem {
  name: string;
  detail: string;
}

/** 当前行已经写好的键名（properties 按 `=`/`:`、yml 按 `:` 切分；注释与空行返回空串） */
function writtenKeyOf(lineText: string, path: string): string {
  const trimmed = lineText.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) return "";
  const cut = /\.ya?ml$/i.test(path) ? trimmed.indexOf(":") : trimmed.search(/[=:]/);
  const key = (cut >= 0 ? trimmed.slice(0, cut) : trimmed).trim();
  return key.replace(/^["']|["']$/g, "");
}

/**
 * 配置键候选：元数据 keys 在前，项目已有值（values）补漏，按名字去重；
 * 当前行已写完整键名时同名候选不再出现（避免补全自己）。
 * detail 用默认值或来源，项目值用声明文件路径。
 */
export function completionItems(
  index: SpringIndex,
  lineText: string,
  path: string,
): SpringCompletionItem[] {
  const writtenKey = writtenKeyOf(lineText, path);
  // 写好的键先占位：properties 与 values 两侧都要过滤，避免从 values 重新补回来
  const seen = new Set<string>(writtenKey ? [writtenKey] : []);
  const items: SpringCompletionItem[] = [];
  for (const property of index.properties) {
    if (seen.has(property.name)) continue;
    seen.add(property.name);
    items.push({
      name: property.name,
      detail: property.defaultValue ? property.defaultValue : property.source,
    });
  }
  for (const value of index.values) {
    if (seen.has(value.name)) continue;
    seen.add(value.name);
    items.push({ name: value.name, detail: value.path });
  }
  return items;
}

const SPRING_CONFIG_RE = /(?:^|[\\/])(application|bootstrap)[^\\/]*\.(properties|ya?ml)$/i;

/** `application`/`bootstrap` 开头的 properties/yml 配置文件名（不检查文件是否真的存在） */
export function isSpringConfigPath(path: string): boolean {
  return SPRING_CONFIG_RE.test(path);
}

/** 端点标签（markdown）正文：标题 + `METHOD  /route  path line`，按 path、line 排序 */
export function formatEndpointList(endpoints: readonly SpringEndpoint[]): string {
  if (!endpoints.length) return "未找到 Spring 端点";
  const sorted = [...endpoints].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.method !== b.method) return a.method < b.method ? -1 : 1;
    return a.route < b.route ? -1 : a.route > b.route ? 1 : 0;
  });
  const lines = [`# Spring 端点（${sorted.length}）`];
  for (const endpoint of sorted) {
    lines.push(`${endpoint.method}  ${endpoint.route}  ${endpoint.path}:${endpoint.line}`);
  }
  return lines.join("\n");
}
