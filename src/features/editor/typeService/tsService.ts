// ==================== 浏览器内嵌 TypeScript 语言服务（完整类型系统） ====================
// 与 tsserver 同引擎（typescript 编译器 API），跑在 WebView 内，无进程、无 node。
//
// 架构：
// - typescript 包动态 import（拆独立 chunk，首次 JS/TS 补全才加载）
// - 文件内容源注入（浏览器：已打开 tabs + 磁盘读取；node 直测：内存 map）
// - 程序 = 已打开文件 + 显式 ensureFile 的 import 链（按需，不扫描全项目）
// - 补全/签名帮助走 LanguageService（增量编译，只重编变化文件）
//
// 范围：类型感知成员补全、真自动导入（sourceDisplay）、签名帮助、
// hover、定义/引用、语义诊断和跨文件符号重命名。

import type ts from "typescript";

export type TsModule = typeof import("typescript");

/** 转义正则特殊字符（自动导入去重判断用） */
function escapeRegExp(s: string): string {
 return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 是否已导入该符号（自动导入去重；纯函数可直测） */
export function isAlreadyImported(docText: string, name: string): boolean {
 return new RegExp(`import[^;]*\\b${escapeRegExp(name)}\\b`).test(docText);
}

/** 自动导入插入点：第一个 import 语句行尾，否则文件开头（纯函数可直测） */
export function autoImportInsertPos(docText: string): number {
 const importLine = docText.match(/^import[^\n]*\n/m);
 return importLine ? (importLine.index ?? 0) + importLine[0].length : 0;
}

export interface FileContentSource {
 /** 已打开文件内容（undefined → 回退磁盘；可异步） */
 openedContent(path: string): Promise<string | undefined> | string | undefined;
 /** 磁盘读取（异步） */
 readDisk(path: string): Promise<string | null>;
}

/** 类型服务补全项（ts.CompletionEntry 精简映射，供适配层使用） */
export interface TsCompletionEntry {
 name: string;
 kind: string;
 kindModifiers: string;
 sortText: string;
 insertText: string | undefined;
 isSnippet: boolean;
 /** 自动导入来源模块（如 './utils'），无则非导入项 */
 sourceDisplay: string | undefined;
 /** 替换范围（offset/length） */
 replacement: { start: number; length: number } | undefined;
 labelDetails: string | undefined;
}

/** 签名帮助（ts.SignatureHelpItems 精简映射） */
export interface TsSignatureHelp {
 signatures: Array<{
  label: string;
  documentation: string;
  parameters: Array<{ label: string; documentation: string }>;
 }>;
 /** 当前激活参数索引（-1 表示无） */
 activeParameter: number;
 /** 签名帮助范围（offset/length，光标在此范围内持续显示） */
 applicableSpan: { start: number; length: number };
}

export interface TsTextSpan {
 start: number;
 length: number;
}

export interface TsDefinitionLocation {
 fileName: string;
 textSpan: TsTextSpan;
 kind: string;
 name: string;
 containerName: string;
}

export interface TsReferenceLocation {
 fileName: string;
 textSpan: TsTextSpan;
 isDefinition: boolean;
}

export interface TsQuickInfo {
 kind: string;
 kindModifiers: string;
 textSpan: TsTextSpan;
 displayString: string;
 documentation: string;
}

export interface TsDiagnostic {
 fileName: string;
 start: number;
 length: number;
 message: string;
 severity: "error" | "warning" | "info";
 code: number;
}

/** 浏览器单例（由 typeService 入口管理） */
export class TsLanguageService {
 private ts: TsModule | null = null;
 private service: ts.LanguageService | null = null;
 private root = "";
 private source: FileContentSource | null = null;
 private fileContents = new Map<string, string>();
 private fileVersions = new Map<string, number>();
 private scriptNames: string[] = [];
 /** 内嵌标准库（浏览器无磁盘 typescript/lib，用 ?raw 打包注入；node 直测不传走默认） */
 private libFiles = new Map<string, string>();

 get ready(): boolean {
  return this.service !== null;
 }

 get currentRoot(): string {
  return this.root;
 }

 /**
  * 初始化（加载 typescript 模块后调用；同模块同 root 重复调用幂等）
  *
  * @param libFiles 内嵌标准库（路径 → 内容，如 lib.es2022.d.ts）
  */
 init(
  tsMod: TsModule,
  root: string,
  source: FileContentSource,
  libFiles: Array<{ path: string; content: string }> = [],
 ): void {
  if (this.service && this.ts === tsMod && this.root === root) return;
  this.ts = tsMod;
  this.root = root;
  this.source = source;
  this.libFiles = new Map(libFiles.map((l) => [l.path, l.content]));
  // 切换 root/模块时重置程序（文件内容按需重建）
  this.fileContents.clear();
  this.fileVersions.clear();
  this.scriptNames = [];

  const host: ts.LanguageServiceHost = {
   getScriptFileNames: () => [...this.scriptNames],
   getScriptVersion: (f) => String(this.fileVersions.get(f) ?? 0),
   getScriptSnapshot: (f) => {
    const text = this.fileContents.get(f) ?? this.libFiles.get(f);
    return text === undefined ? undefined : tsMod.ScriptSnapshot.fromString(text);
   },
   getCurrentDirectory: () => root,
   getCompilationSettings: () => ({
    allowJs: true,
    jsx: tsMod.JsxEmit.Preserve,
    target: tsMod.ScriptTarget.ES2022,
    module: tsMod.ModuleKind.ESNext,
    moduleResolution: tsMod.ModuleResolutionKind.Bundler,
    paths: { "@/*": ["src/*"] },
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    skipLibCheck: true,
   }),
   getDefaultLibFileName: (o) => tsMod.getDefaultLibFilePath(o),
   fileExists: (f) => this.fileContents.has(f) || this.libFiles.has(f),
   readFile: (f) => this.fileContents.get(f) ?? this.libFiles.get(f),
   directoryExists: () => true,
   getDirectories: () => [],
  };
  this.service = tsMod.createLanguageService(host);
 }

 /** 注册/更新文件（已打开 tab 内容同步；版本号递增触发增量重编） */
 setFile(path: string, content: string): void {
  if (!this.service) return;
  // 内容引用未变（同一份字符串，如未编辑的 tab）：不 bump 版本。
  // 版本变更会把该文件标记为脏，下次补全查询触发 TS 增量重编；
  // 之前每次激活把全部打开 tab 都 setFile 一遍 → 整组重编，输入卡顿主因
  if (this.fileContents.get(path) === content) return;
  this.fileContents.set(path, content);
  this.fileVersions.set(path, (this.fileVersions.get(path) ?? 0) + 1);
  if (!this.scriptNames.includes(path)) this.scriptNames.push(path);
 }

 /** 从程序中移除文件 */
 removeFile(path: string): void {
  this.fileContents.delete(path);
  this.fileVersions.delete(path);
  const idx = this.scriptNames.indexOf(path);
  if (idx >= 0) this.scriptNames.splice(idx, 1);
 }

 /** 确保文件在程序中（内存已开 → 直接注册；否则查已打开 tab / 磁盘） */
 async ensureFile(path: string): Promise<void> {
  if (!this.service) return;
  if (this.fileContents.has(path)) return;
  const opened = await this.source?.openedContent(path);
  if (opened !== undefined) {
   this.setFile(path, opened);
   return;
  }
  const disk = await this.source?.readDisk(path);
  if (disk !== null && disk !== undefined) this.setFile(path, disk);
 }

 /**
  * 补全查询（同步，TS 引擎内部增量编译）
  *
  * @param fileName 文件绝对路径（须已在程序中）
  * @param pos 光标 offset
  */
 completionsAt(fileName: string, pos: number): TsCompletionEntry[] {
  const service = this.service;
  const tsMod = this.ts;
  if (!service || !tsMod) return [];
  const result = service.getCompletionsAtPosition(fileName, pos, {
   includeCompletionsForModuleExports: true,
   includeCompletionsWithInsertText: true,
   includeCompletionsWithSnippetText: true,
  });
  if (!result) return [];
  return result.entries.map((e) => ({
   name: e.name,
   kind: e.kind,
   kindModifiers: e.kindModifiers ?? "",
   sortText: e.sortText,
   insertText: e.insertText,
   isSnippet: Boolean(e.isSnippet),
   sourceDisplay: e.sourceDisplay?.[0]?.text,
   replacement: e.replacementSpan
    ? { start: e.replacementSpan.start, length: e.replacementSpan.length }
    : undefined,
   labelDetails: e.labelDetails?.detail,
  }));
 }

 /** 补全项详情（文档；仅在 info 渲染时按需查询） */
 completionDetails(
  fileName: string,
  pos: number,
  name: string,
 ): { documentation: string; detail: string } | null {
  const service = this.service;
  if (!service) return null;
  const details = service.getCompletionEntryDetails(fileName, pos, name, {}, undefined, undefined, undefined);
  if (!details) return null;
  return {
   documentation: details.documentation
    ? typeof details.documentation === "string"
     ? details.documentation
     : details.documentation.map((p) => p.text).join("")
    : "",
   detail: details.displayParts?.map((p) => p.text).join("") ?? "",
  };
 }

 /** 签名帮助（光标在函数调用括号内时返回；否则 null） */
 signatureHelpAt(fileName: string, pos: number): TsSignatureHelp | null {
  const service = this.service;
  if (!service) return null;
  const items = service.getSignatureHelpItems(fileName, pos, {});
  if (!items) return null;
  return {
   signatures: items.items.map((item) => ({
    label: item.prefixDisplayParts
     .map((p) => p.text)
     .join("")
     .concat(
      ...item.parameters.map((p, i) =>
       i === 0
        ? `(${p.displayParts.map((q) => q.text).join("")}`
        : `, ${p.displayParts.map((q) => q.text).join("")}`,
      ),
     )
     .concat(item.separatorDisplayParts.map((p) => p.text).join(""))
     .concat(")"),
    documentation: item.documentation
     ? typeof item.documentation === "string"
      ? item.documentation
      : item.documentation.map((p) => p.text).join("")
     : "",
    parameters: item.parameters.map((p) => ({
     label: p.displayParts.map((q) => q.text).join(""),
     documentation: p.documentation
      ? typeof p.documentation === "string"
       ? p.documentation
       : p.documentation.map((q) => q.text).join("")
      : "",
    })),
   })),
   activeParameter: items.argumentIndex,
   applicableSpan: {
    start: items.applicableSpan.start,
    length: items.applicableSpan.length,
   },
  };
 }

 /** 悬浮信息：返回 TS 的真实类型签名和文档。 */
 quickInfoAt(fileName: string, pos: number): TsQuickInfo | null {
  const service = this.service;
  const tsMod = this.ts;
  if (!service || !tsMod) return null;
  const info = service.getQuickInfoAtPosition(fileName, pos);
  if (!info) return null;
  const display = info.displayParts?.map((part) => part.text).join("") ?? "";
  const documentation = info.documentation
   ? typeof info.documentation === "string"
    ? info.documentation
    : info.documentation.map((part) => part.text).join("")
   : "";
  return {
   kind: info.kind,
   kindModifiers: info.kindModifiers ?? "",
   textSpan: { start: info.textSpan.start, length: info.textSpan.length },
   displayString: display,
   documentation,
  };
 }

 /** 跳转定义：使用 TypeScript 的解析结果，保留跨文件定位能力。 */
 definitionsAt(fileName: string, pos: number): TsDefinitionLocation[] {
  const service = this.service;
  if (!service) return [];
  return (service.getDefinitionAtPosition(fileName, pos) ?? []).map((item) => ({
   fileName: item.fileName,
   textSpan: { start: item.textSpan.start, length: item.textSpan.length },
   kind: item.kind,
   name: item.name,
   containerName: item.containerName ?? "",
  }));
 }

 /** 引用位置：TS 返回引用集合；definition 单独标记，供 UI/重命名区分。 */
 referencesAt(fileName: string, pos: number): TsReferenceLocation[] {
  const service = this.service;
  if (!service) return [];
  const references = service.getReferencesAtPosition(fileName, pos) ?? [];
  const definitions = service.getDefinitionAtPosition(fileName, pos) ?? [];
  const definitionKeys = new Set(
   definitions.map((item) => `${item.fileName}:${item.textSpan.start}:${item.textSpan.length}`),
  );
  const out: TsReferenceLocation[] = [];
  for (const definition of definitions) {
   out.push({
    fileName: definition.fileName,
    textSpan: {
     start: definition.textSpan.start,
     length: definition.textSpan.length,
    },
    isDefinition: true,
   });
  }
  for (const reference of references) {
   out.push({
    fileName: reference.fileName,
    textSpan: {
     start: reference.textSpan.start,
     length: reference.textSpan.length,
    },
    isDefinition: definitionKeys.has(
     `${reference.fileName}:${reference.textSpan.start}:${reference.textSpan.length}`,
    ),
   });
  }
  const seen = new Set<string>();
  return out.filter((item) => {
   const key = `${item.fileName}:${item.textSpan.start}:${item.textSpan.length}`;
   if (seen.has(key)) return false;
   seen.add(key);
   return true;
  });
 }

 /** 重命名位置：findRenameLocations 会把定义和所有引用一次性返回。 */
 renameLocationsAt(
  fileName: string,
  pos: number,
  findInStrings = false,
  findInComments = false,
 ): TsReferenceLocation[] {
  const service = this.service;
  if (!service) return [];
  return (service.findRenameLocations(fileName, pos, findInStrings, findInComments) ?? []).map(
   (item) => ({
    fileName: item.fileName,
    textSpan: { start: item.textSpan.start, length: item.textSpan.length },
    isDefinition: item.fileName === fileName && item.textSpan.start === pos,
   }),
  );
 }

 /** 当前文件语义诊断；UI 可按需把结果映射成 CodeMirror Diagnostic。 */
 diagnosticsFor(fileName: string): TsDiagnostic[] {
  const service = this.service;
  const tsMod = this.ts;
  if (!service || !tsMod) return [];
  const all = [
   ...service.getSyntacticDiagnostics(fileName),
   ...service.getSemanticDiagnostics(fileName),
  ];
  const seen = new Set<string>();
  const result: TsDiagnostic[] = [];
  for (const diagnostic of all) {
   const start = diagnostic.start ?? 0;
   const length = diagnostic.length ?? 1;
   const key = `${start}:${length}:${diagnostic.code}`;
   if (seen.has(key)) continue;
   seen.add(key);
   const severity =
    diagnostic.category === tsMod.DiagnosticCategory.Error
     ? "error"
     : diagnostic.category === tsMod.DiagnosticCategory.Warning
      ? "warning"
      : "info";
   result.push({
    fileName,
    start,
    length,
    message: tsMod.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    severity,
    code: diagnostic.code,
   });
  }
  return result;
 }

 /**
  * 释放 LanguageService 与程序状态（查找引用结束后调用）。
  * 动态 import 的 typescript 模块本身保留，下次 ensureTypeService 会重新 init，
  * 避免第二套编译器（含 DOM 标准库与检查器缓存）常驻内存。
  */
 release(): void {
  this.service?.dispose();
  this.service = null;
  this.fileContents.clear();
  this.fileVersions.clear();
  this.scriptNames = [];
  this.libFiles.clear();
  this.root = "";
 }
}
