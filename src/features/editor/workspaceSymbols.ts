// ==================== 工作区级符号索引（自研简化版 LSP 基础设施） ====================
// 目标：零依赖、零进程、纯前端 LRU 缓存，支持跨文件 go-to-definition /
// find-references / rename symbol。
//
// 设计原则：
// 1. 按需懒构建：首次调用 findDefinition/findReferences 时按需拉文件
// 2. 失败容错：单文件解析失败仅 console.warn，不影响其他
// 3. LRU 上限 500 文件：超出按 Map 插入顺序淘汰
// 4. 内容 hash 失效：内容变化才重建索引（避免 mtime API 依赖）
// 5. 仅解析 TS/JS/JSX/TSX/Vue script 段，CSS/HTML/Markdown 不参与
//
// 范围（明确不做）：类型推断、hover、签名帮助、跨文件补全、服务进程

import { readTextFile, relativeToRoot } from "@/shared/fs";
import { indexDocumentSymbols, type DocumentSymbol, type SymbolKind } from "@/features/editor/documentSymbols";
import { pickBestSymbols, rankSymbolCandidates, type IndexedSymbol } from "@/features/editor/completion/symbolFilter";

/** 单文件解析出的符号表（key = 符号名） */
export type FileSymbolTable = Map<string, DocumentSymbol[]>;

/** Search Everywhere 符号搜索结果：在 DocumentSymbol 之上补充文件定位信息 */
export interface WorkspaceSymbolHit {
  name: string;
  path: string;
  line: number;
  column: number;
  kind: SymbolKind;
  /** 符号所在文件相对工作区根的路径（不在根内时回退为原始路径） */
  containerPath?: string;
}

/** 解析失败的文件（避免反复尝试） */
const PARSE_FAIL_MARKER = "__PARSE_FAIL__" as const;

/** 内容 hash（用 djb2 简单实现，足够去重） */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

/** 单文件缓存项：内容 hash + 符号表（或失败标记） */
interface FileCacheEntry {
  hash: string;
  symbols: FileSymbolTable | typeof PARSE_FAIL_MARKER;
}

/** 解析单文件：失败返回失败标记，避免反复 IO */
async function parseFile(
  root: string,
  path: string,
): Promise<FileSymbolTable | typeof PARSE_FAIL_MARKER> {
  try {
    const text = await readTextFile(root, path);
    return indexDocumentSymbols(text, path);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[workspaceSymbols] 解析失败：${path}`, err);
    return PARSE_FAIL_MARKER;
  }
}

/** 工作区符号索引（单例，全局共享） */
class WorkspaceSymbolCache {
  /** 文件 → 缓存项（LRU，最近访问在最后） */
  private fileCache = new Map<string, FileCacheEntry>();
  /** 全局符号 → 候选位置列表（跨文件聚合） */
  private globalIndex = new Map<string, Array<DocumentSymbol & { path: string }>>();
  /** 标记正在构建（避免重复 IO） */
  private inflight = new Map<string, Promise<FileSymbolTable | typeof PARSE_FAIL_MARKER>>();
  /** 单文件失效代际：阻止失效前的异步解析结果回写缓存。 */
  private fileGenerations = new Map<string, number>();
  /** LRU 上限 */
  private readonly MAX_FILES = 500;
  /** 文件大小上限（bytes），超出截断避免单文件拖死 */
  private readonly MAX_FILE_BYTES = 1_000_000;
  /** 工作区是否已全量扫描（searchSymbols 首次调用时懒构建） */
  private workspaceScanned = false;
  /** 当前缓存所属工作区根目录；切根时必须清空全部跨文件索引 */
  private currentRoot: string | null = null;
  /** 使 clear 后仍在途的旧扫描结果无法回写新缓存 */
  private generation = 0;
  /** 后台全量扫描的进行中 Promise（null = 当前没有扫描在跑） */
  private scanPromise: Promise<void> | null = null;
  /** scanPromise 所属索引代际：代际变化（切根 / 整体失效）后不复用旧扫描 */
  private scanGeneration = -1;
  /** 扫描代次：避免「旧扫描结束」误清新扫描登记的 scanPromise */
  private scanToken = 0;

  private ensureWorkspace(root: string): void {
    if (this.currentRoot === root) return;
    this.clear();
    this.currentRoot = root;
  }

  /** 清空全部缓存（工作区根变更时调用） */
  clear(): void {
    // 递增代际，使 clear 前已发出的 read/list promise 即使返回，也不能
    // 把旧工作区结果写回新索引。
    this.generation += 1;
    this.fileCache.clear();
    this.globalIndex.clear();
    this.inflight.clear();
    this.fileGenerations.clear();
    this.workspaceScanned = false;
    this.currentRoot = null;
  }

  /** 从全局聚合索引移除某个文件的全部贡献。 */
  private removeGlobalPath(path: string): void {
    for (const [name, list] of this.globalIndex.entries()) {
      const filtered = list.filter((d) => d.path !== path);
      if (filtered.length === 0) this.globalIndex.delete(name);
      else if (filtered.length !== list.length) this.globalIndex.set(name, filtered);
    }
  }

  /** 使单文件缓存失效（编辑保存后调用） */
  invalidate(path: string): void {
    this.fileGenerations.set(path, (this.fileGenerations.get(path) ?? 0) + 1);
    this.fileCache.delete(path);
    this.inflight.delete(path);
    // 即使 fileCache 已被 LRU 淘汰，也要清理可能残留的聚合索引贡献。
    this.removeGlobalPath(path);
  }

  /** 使工作区内所有文件失效（refreshFromDisk / 文件监听触发时调用） */
  invalidateAll(): void {
    this.generation += 1;
    this.fileCache.clear();
    this.globalIndex.clear();
    this.inflight.clear();
    this.fileGenerations.clear();
    this.workspaceScanned = false;
  }

  /**
   * 按前缀查询全局符号（供补全使用）
   *
   * 首次调用触发工作区全量扫描（后台进行，不阻塞本次查询）；
   * 之后为纯内存前缀过滤。大小写不敏感匹配，同符号取「最像定义」的候选。
   */
  async searchSymbols(
    root: string,
    prefix: string,
    limit = 16,
  ): Promise<Array<{ name: string; kind: SymbolKind; path: string; line: number }>> {
    if (!root || !prefix) return [];
    void this.ensureIndex(root);
    return pickBestSymbols(this.globalIndex, prefix, limit);
  }

  /**
   * 跨文件符号模糊搜索（Search Everywhere 的 Symbols 分组）。
   * 首次调用触发工作区索引的后台懒构建；索引尚未就绪时以当前内存快照立即兑现，
   * 由调用方在索引完成后重查补齐，绝不阻塞 UI。
   */
  async searchWorkspaceSymbols(
    root: string,
    query: string,
    limit = 50,
  ): Promise<WorkspaceSymbolHit[]> {
    const q = query.trim();
    if (!root || !q) return [];
    void this.ensureIndex(root);
    return rankWorkspaceSymbolHits(this.globalIndex, root, q, limit);
  }

  /**
   * 后台索引扫描的进行中 Promise；返回 null 表示当前没有扫描在跑。
   * UI 据此在索引构建完成后重查一次，避免结果长期停留在部分索引状态。
   */
  pendingIndexScan(): Promise<void> | null {
    return this.scanPromise;
  }

  /** 触发（或复用）工作区索引的后台构建，返回构建完成 Promise */
  ensureIndex(root: string): Promise<void> {
    if (!root) return Promise.resolve();
    this.ensureWorkspace(root);
    if (!this.workspaceScanned) {
      this.workspaceScanned = true;
      return this.startScan(root);
    }
    return this.scanPromise ?? Promise.resolve();
  }

  /** 启动一次后台全量扫描并记录进行中状态（仅复用同一代际的扫描） */
  private startScan(root: string): Promise<void> {
    // 工作区已切换 / 索引已整体失效时不会复用旧 Promise，否则新根永不建索引
    if (this.scanPromise && this.scanGeneration === this.generation) {
      return this.scanPromise;
    }
    const token = ++this.scanToken;
    const promise = this.scanWorkspace(root)
      .catch((error) => {
        console.warn(`[workspaceSymbols] 工作区扫描失败：${root}`, error);
      })
      .finally(() => {
        if (token === this.scanToken) this.scanPromise = null;
      });
    this.scanGeneration = this.generation;
    this.scanPromise = promise;
    return promise;
  }

  /** 后台全量构建工作区索引（仅首次 searchSymbols 触发，成功后常驻） */
  private async scanWorkspace(root: string): Promise<void> {
    const generation = this.generation;
    const candidates: string[] = [];
    await collectFiles(root, "", candidates, 4);
    if (generation !== this.generation) return;
    // 分批并行（避免一次发起过多 IPC；失败单文件容错）
    const BATCH = 12;
    for (let i = 0; i < candidates.length; i += BATCH) {
      if (generation !== this.generation) return;
      const batch = candidates.slice(i, i + BATCH);
      await Promise.allSettled(batch.map((p) => this.getFileSymbols(root, p)));
    }
  }

  /** 获取单文件符号表（自动构建） */
  async getFileSymbols(root: string, path: string, content?: string): Promise<FileSymbolTable | typeof PARSE_FAIL_MARKER | null> {
    // 调用方 searchSymbols/findDefinition/findAllReferences 已先绑定 root；
    // scanWorkspace 的旧代际不能在这里再次 ensureWorkspace，否则它在新
    // 工作区建立后返回会把新缓存清空。代际检查负责阻止旧结果回写。
    const generation = this.generation;
    // 已有缓存：用 hash 校验
    if (content !== undefined) {
      const hash = djb2(content);
      const cached = this.fileCache.get(path);
      if (cached && cached.hash === hash && cached.symbols !== PARSE_FAIL_MARKER) {
        this.touch(path);
        return cached.symbols;
      }
      // 内容变了：失效旧条目
      if (cached) this.invalidate(path);
    } else {
      const cached = this.fileCache.get(path);
      if (cached) {
        this.touch(path);
        return cached.symbols;
      }
    }

    // 去重 inflight
    const pending = this.inflight.get(path);
    if (pending) return pending;

    const fileGeneration = this.fileGenerations.get(path) ?? 0;
    const promise = (async () => {
      // 优先用传进来的 content（避免重复 readTextFile）
      let text: string;
      if (content !== undefined) {
        text = content.length > this.MAX_FILE_BYTES ? content.slice(0, this.MAX_FILE_BYTES) : content;
      } else {
        const read = await readTextFile(root, path);
        text = read.length > this.MAX_FILE_BYTES ? read.slice(0, this.MAX_FILE_BYTES) : read;
      }
      const hash = djb2(text);
      // content 已提供时直接索引，避免重复读盘；且符号表与 hash 基于同一
      // 份文本（此前 hash 基于截断的 content、符号表却基于磁盘全文，超大文件
      // 两者永不一致，缓存反复失效重建）
      const symbols =
        content !== undefined
          ? indexDocumentSymbols(text, path)
          : await parseFile(root, path);
      if (
        generation !== this.generation ||
        fileGeneration !== (this.fileGenerations.get(path) ?? 0)
      ) {
        // 工作区已切换/全量失效：结果仍可返回给旧调用方，但禁止写入当前缓存。
        // 不删除新代际可能已经登记的同路径 promise。
        return symbols;
      }
      this.fileCache.set(path, { hash, symbols });
      this.touch(path);
      this.evictFileCacheIfNeeded();
      // 重新合并前先移除该路径旧贡献，防止 LRU 淘汰/异常路径造成重复。
      this.removeGlobalPath(path);
      if (symbols !== PARSE_FAIL_MARKER) {
        for (const [name, list] of symbols.entries()) {
          const existing = this.globalIndex.get(name) ?? [];
          for (const sym of list) {
            existing.push({ ...sym, path });
          }
          this.globalIndex.set(name, existing);
        }
      }
      if (generation === this.generation) this.inflight.delete(path);
      return symbols;
    })();
    this.inflight.set(path, promise);
    return promise;
  }

  /** 跨文件查找符号定义 */
  async findDefinitionAcrossFiles(
    root: string,
    word: string,
    importerPath: string,
  ): Promise<(DocumentSymbol & { path: string }) | null> {
    this.ensureWorkspace(root);
    // 1) 看 importer 自己 import 了哪些文件，把这些文件的符号表加载进来
    const candidates = await this.loadImportChain(root, importerPath, 5);
    // 2) 在 globalIndex 查 word
    const list = this.globalIndex.get(word);
    if (!list || list.length === 0) return null;
    // 3) 优先选 candidates 集合中的（避免无关同名符号）
    const inChain = list.filter((d) => candidates.has(d.path));
    if (inChain.length > 0) {
      // 优先 function / class / interface，variable 次之
      const ranked = rankSymbolCandidates(inChain);
      return ranked[0] ?? null;
    }
    // 4) fallback：工作区任意位置第一个
    const ranked = rankSymbolCandidates(list);
    return ranked[0] ?? null;
  }

  /** 加载 importer 的 import 链（递归深度上限） */
  private async loadImportChain(
    root: string,
    importerPath: string,
    maxDepth: number,
    depth = 0,
  ): Promise<Set<string>> {
    const result = new Set<string>();
    if (depth >= maxDepth) return result;
    let content: string;
    try {
      content = await readTextFile(root, importerPath);
    } catch {
      return result;
    }
    // 复用 importReferences 里的 IMPORT_RE 抓 import spec
    const { IMPORT_RE } = await import("@/shared/importReferences");
    const re = new RegExp(IMPORT_RE.source, "g");
    let m: RegExpExecArray | null;
    const specList: string[] = [];
    while ((m = re.exec(content))) {
      const spec = m[1];
      if ((spec.startsWith(".") || spec.startsWith("@/")) && !specList.includes(spec)) specList.push(spec);
    }
    // 解析每个 spec 到绝对路径，加载其符号表
    for (const spec of specList) {
      const { resolveImportPath } = await import("@/shared/importReferences");
      const resolved = await resolveImportPath(root, importerPath, spec);
      if (resolved && !result.has(resolved)) {
        result.add(resolved);
        await this.getFileSymbols(root, resolved);
        // 递归一层
        const sub = await this.loadImportChain(root, resolved, maxDepth, depth + 1);
        for (const s of sub) result.add(s);
      }
    }
    return result;
  }

  /** 查找所有引用（反向 import 链 + 同文件内） */
  async findAllReferences(
    root: string,
    word: string,
    sourceFile: string,
    sourceContent: string,
    maxDepth = 5,
  ): Promise<Array<{ path: string; line: number; column: number }>> {
    this.ensureWorkspace(root);
    const result: Array<{ path: string; line: number; column: number }> = [];
    // 1) 同文件内的所有 word 出现
    pushOccurrences(result, sourceFile, sourceContent, word);
    // 2) 反向 import 链：哪些文件 import 了 sourceFile？
    const reverseChain = await this.findReverseImportChain(root, sourceFile, maxDepth);
    for (const importer of reverseChain) {
      try {
        const text = await readTextFile(root, importer);
        pushOccurrences(result, importer, text, word);
      } catch (err) {
        console.warn(`[workspaceSymbols] 反向引用读取失败：${importer}`, err);
      }
    }
    // 3) 也扫一次所有 import 链（symbol import 来的文件可能直接引用 word）
    const forwardChain = await this.loadImportChain(root, sourceFile, maxDepth);
    for (const target of forwardChain) {
      try {
        const text = await readTextFile(root, target);
        pushOccurrences(result, target, text, word);
      } catch {
        /* 容错 */
      }
    }
    // 去重 + 排序
    const seen = new Set<string>();
    const dedup: typeof result = [];
    for (const r of result) {
      const k = `${r.path}:${r.line}:${r.column}`;
      if (!seen.has(k)) {
        seen.add(k);
        dedup.push(r);
      }
    }
    dedup.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
    return dedup;
  }

  /** 找所有 import 了 target 的文件（反向链） */
  private async findReverseImportChain(
    root: string,
    target: string,
    maxDepth: number,
    depth = 0,
  ): Promise<Set<string>> {
    const result = new Set<string>();
    if (depth >= maxDepth) return result;
    const { IMPORT_RE } = await import("@/shared/importReferences");
    // 收集工作区所有 .ts/.js/.vue 文件（仅 .ts/.js/.vue/.tsx/.jsx）
    // 简单实现：扫工作区根的 listDir（依赖现有的 list_dir Rust 命令）
    const candidates: string[] = [];
    await collectFiles(root, "", candidates, 4);
    for (const file of candidates) {
      try {
        const text = await readTextFile(root, file);
        const re = new RegExp(IMPORT_RE.source, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          const spec = m[1];
          if (spec.startsWith(".") || spec.startsWith("@/")) {
            const { resolveImportPath } = await import("@/shared/importReferences");
            const resolved = await resolveImportPath(root, file, spec);
            if (resolved === target && !result.has(file)) {
              result.add(file);
              const sub = await this.findReverseImportChain(root, file, maxDepth, depth + 1);
              for (const s of sub) result.add(s);
            }
          }
        }
      } catch {
        /* 容错 */
      }
    }
    return result;
  }

  /** 调试：导出当前缓存大小 */
  stats(): { files: number; symbols: number; inflight: number } {
    return {
      files: this.fileCache.size,
      symbols: this.globalIndex.size,
      inflight: this.inflight.size,
    };
  }

  /** LRU 淘汰：同步移除 globalIndex 中被淘汰文件的贡献。 */
  private evictFileCacheIfNeeded(): void {
    while (this.fileCache.size > this.MAX_FILES) {
      const first = this.fileCache.keys().next().value;
      if (first === undefined) break;
      this.invalidate(first);
    }
  }

  /** LRU touch：把最近访问移到 Map 末尾 */
  private touch(key: string): void {
    const entry = this.fileCache.get(key);
    if (!entry) return;
    this.fileCache.delete(key);
    this.fileCache.set(key, entry);
  }
}

// ==================== Search Everywhere 符号搜索 ====================

/** 符号类型优先级：越接近「定义」的类型排序越靠前 */
const KIND_SCORE: Record<SymbolKind, number> = {
  function: 6,
  class: 5,
  interface: 4,
  type: 3,
  enum: 2,
  method: 1,
  variable: 0,
};

/** 同名符号最多展示的定义数（重载 / 多文件同名） */
const MAX_HITS_PER_NAME = 3;

/** 子序列模糊匹配评分：0 = 不匹配；连续命中、词边界、前缀命中加权，长名轻微降权 */
function fuzzySubsequenceScore(text: string, query: string): number {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (!lowerQuery) return 0;
  let score = 0;
  let textIndex = 0;
  let lastHit = -2;
  for (const ch of lowerQuery) {
    const hit = lowerText.indexOf(ch, textIndex);
    if (hit === -1) return 0;
    let bonus = 2;
    if (hit === lastHit + 1) bonus += 8; // 连续命中：缩写式匹配（如 "wsc" → workspaceSymbolCache）
    if (hit === 0) bonus += 6; // 名称开头
    else if (/[^a-z0-9]/.test(lowerText[hit - 1])) bonus += 4; // 词边界（分隔符后）
    else if (/[A-Z]/.test(text[hit])) bonus += 3; // camelCase 词首
    score += bonus;
    lastHit = hit;
    textIndex = hit + 1;
  }
  if (lowerText.startsWith(lowerQuery)) score += 30;
  else if (lowerText.includes(lowerQuery)) score += 15;
  return score - Math.min(8, Math.floor(text.length / 6)); // 短名优先
}

/** 在全局符号聚合表内做模糊排序，产出 Search Everywhere 结果 */
function rankWorkspaceSymbolHits(
  index: Map<string, IndexedSymbol[]>,
  root: string,
  query: string,
  limit: number,
): WorkspaceSymbolHit[] {
  const scored: Array<{ hit: WorkspaceSymbolHit; score: number }> = [];
  for (const [name, list] of index.entries()) {
    const nameScore = fuzzySubsequenceScore(name, query);
    if (nameScore <= 0) continue;
    for (const symbol of rankSymbolCandidates(list).slice(0, MAX_HITS_PER_NAME)) {
      scored.push({
        hit: {
          name,
          path: symbol.path,
          line: symbol.line,
          column: symbol.column,
          kind: symbol.kind,
          containerPath: relativeToRoot(root, symbol.path),
        },
        score: nameScore + KIND_SCORE[symbol.kind],
      });
    }
  }
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.hit.name.localeCompare(right.hit.name) ||
      left.hit.path.localeCompare(right.hit.path) ||
      left.hit.line - right.hit.line,
  );
  return scored.slice(0, Math.max(1, limit)).map((entry) => entry.hit);
}

/** 在 text 中找出所有 word 的精确出现位置（不依赖任何正则，含全词边界） */
function pushOccurrences(
  out: Array<{ path: string; line: number; column: number }>,
  path: string,
  text: string,
  word: string,
): void {
  if (!word) return;
  // 全词匹配：`\b` 等价于前后不能是 word char
  const wordRe = /[A-Za-z_$][\w$]*/;
  if (!wordRe.test(word)) return;
  const re = new RegExp(`(?<![A-Za-z_$0-9])${escapeRegex(word)}(?![A-Za-z_$0-9])`, "g");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      out.push({ path, line: i + 1, column: (m.index ?? 0) + 1 });
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 递归收集工作区文件（限定扩展名） */
async function collectFiles(
  root: string,
  dir: string,
  out: string[],
  maxDepth: number,
  depth = 0,
): Promise<void> {
  if (depth >= maxDepth) return;
  const { listDir } = await import("@/shared/fs");
  let entries: Array<{ name: string; isDir: boolean; path: string }>;
  try {
    entries = await listDir(root, dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === "target") continue;
    if (e.isDir) {
      await collectFiles(root, e.path, out, maxDepth, depth + 1);
    } else if (/\.(ts|tsx|js|jsx|vue)$/.test(e.name)) {
      out.push(e.path);
    }
  }
}

/** 全局单例 */
export const workspaceSymbols = new WorkspaceSymbolCache();
