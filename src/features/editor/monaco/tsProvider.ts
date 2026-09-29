// ==================== TypeScript / JavaScript 语言服务 ====================
// Monaco 自带 TS worker（编译器 5.9.3 + 标准库内嵌，不联网），这里只负责：
// - 把项目 tsconfig.json 映射成 worker 的 compilerOptions
// - 打开诊断（语义 + 语法）
// - 让 worker 看到全部打开的 model（跨文件跳转/重命名/引用）
import type { CompilerOptions } from "monaco-editor/languages/features/typescript/register";
import { monaco, typescript } from "./setup";
import { readTextFile } from "@/shared/fs";
import { DEFAULT_TS_LIBS, libsFromTsconfig } from "./languageBudget";

/** tsconfig 是 JSONC：去注释与尾逗号后再 parse */
function parseJsonc(text: string): Record<string, unknown> | null {
 try {
  const stripped = text
   .replace(/\/\*[\s\S]*?\*\//g, "")
   .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
   .replace(/,(\s*[}\]])/g, "$1");
  const parsed = JSON.parse(stripped) as Record<string, unknown>;
  return parsed && typeof parsed === "object" ? parsed : null;
 } catch {
  return null;
 }
}

// worker 侧的 ScriptTarget 只到 ES2020（ESNext/Latest 同为 99）：
// 更新的标准一律收敛到 ESNext。
const TARGET_BY_NAME: Record<string, number> = {
 es3: typescript.ScriptTarget.ES3,
 es5: typescript.ScriptTarget.ES5,
 es6: typescript.ScriptTarget.ES2015,
 es2015: typescript.ScriptTarget.ES2015,
 es2016: typescript.ScriptTarget.ES2016,
 es2017: typescript.ScriptTarget.ES2017,
 es2018: typescript.ScriptTarget.ES2018,
 es2019: typescript.ScriptTarget.ES2019,
 es2020: typescript.ScriptTarget.ES2020,
 es2021: typescript.ScriptTarget.ESNext,
 es2022: typescript.ScriptTarget.ESNext,
 esnext: typescript.ScriptTarget.ESNext,
 latest: typescript.ScriptTarget.Latest,
};

// ModuleKind 同样只有 AMD/CommonJS/ES2015/ESNext/None/System/UMD：
// node16/nodenext/preserve 统一按 ESNext 处理。
const MODULE_BY_NAME: Record<string, number> = {
 none: typescript.ModuleKind.None,
 commonjs: typescript.ModuleKind.CommonJS,
 amd: typescript.ModuleKind.AMD,
 umd: typescript.ModuleKind.UMD,
 system: typescript.ModuleKind.System,
 es6: typescript.ModuleKind.ES2015,
 es2015: typescript.ModuleKind.ES2015,
 esnext: typescript.ModuleKind.ESNext,
 node16: typescript.ModuleKind.ESNext,
 nodenext: typescript.ModuleKind.ESNext,
 preserve: typescript.ModuleKind.ESNext,
};

const JSX_BY_NAME: Record<string, number> = {
 preserve: typescript.JsxEmit.Preserve,
 react: typescript.JsxEmit.React,
 "react-jsx": typescript.JsxEmit.ReactJSX,
 "react-jsxdev": typescript.JsxEmit.ReactJSXDev,
 "react-native": typescript.JsxEmit.ReactNative,
 none: typescript.JsxEmit.None,
};

/** 默认值对齐现代前端项目（vite/vue 脚手架）；项目 tsconfig 存在时逐字段覆盖 */
function baseCompilerOptions(): CompilerOptions {
 return {
  target: typescript.ScriptTarget.Latest,
  lib: [...DEFAULT_TS_LIBS],
  module: typescript.ModuleKind.ESNext,
  moduleResolution: typescript.ModuleResolutionKind.NodeJs,
  jsx: typescript.JsxEmit.Preserve,
  allowNonTsExtensions: true,
  allowJs: true,
  checkJs: false,
  strict: true,
  esModuleInterop: true,
  skipLibCheck: true,
  resolveJsonModule: true,
  isolatedModules: true,
  experimentalDecorators: true,
  allowSyntheticDefaultImports: true,
  noEmit: true,
 };
}

/** 把 tsconfig 的 compilerOptions 映射为 worker 认识的形式 */
export function compilerOptionsFromTsconfig(
 raw: Record<string, unknown> | null,
): CompilerOptions {
 const options: Record<string, unknown> = baseCompilerOptions();
 const source = (raw?.compilerOptions ?? null) as Record<string, unknown> | null;
 if (!source) return options as CompilerOptions;

 const target = typeof source.target === "string" ? TARGET_BY_NAME[source.target.toLowerCase()] : undefined;
 if (target !== undefined) options.target = target;
 const module = typeof source.module === "string" ? MODULE_BY_NAME[source.module.toLowerCase()] : undefined;
 if (module !== undefined) options.module = module;
 const jsx = typeof source.jsx === "string" ? JSX_BY_NAME[source.jsx.toLowerCase()] : undefined;
 if (jsx !== undefined) options.jsx = jsx;

 // moduleResolution：node/node10 → NodeJs；bundler/node16/nodenext → NodeJs（worker 仅支持 Classic/NodeJs）
 if (typeof source.moduleResolution === "string") {
  const value = source.moduleResolution.toLowerCase();
  options.moduleResolution =
   value === "classic"
    ? typescript.ModuleResolutionKind.Classic
    : typescript.ModuleResolutionKind.NodeJs;
 }

 for (const flag of [
  "strict",
  "allowJs",
  "checkJs",
  "esModuleInterop",
  "skipLibCheck",
  "resolveJsonModule",
  "isolatedModules",
  "experimentalDecorators",
  "allowSyntheticDefaultImports",
  "noImplicitAny",
  "strictNullChecks",
  "useDefineForClassFields",
 ]) {
  if (typeof source[flag] === "boolean") options[flag] = source[flag];
 }

 if (source.paths && typeof source.paths === "object") {
  options.paths = source.paths;
 }
 if (typeof source.baseUrl === "string") {
  options.baseUrl = source.baseUrl;
 }
 if (Array.isArray(source.types)) {
  options.types = source.types;
 }
 // 标准库：项目声明 lib 时以项目为准（Node 项目写 ["es2022"] 即不再加载 DOM），
 // 缺失或为空时回落默认，不再依赖 worker 内部的 lib.es6.d.ts 回落链
 options.lib = libsFromTsconfig(source.lib);
 return options as CompilerOptions;
}

let configuredRoot: string | null = null;

/** 读取项目 tsconfig.json（不存在返回 null，调用方退回默认选项） */
export async function readTsconfig(root: string): Promise<Record<string, unknown> | null> {
 for (const name of ["tsconfig.json", "jsconfig.json"]) {
  try {
   const text = await readTextFile(root, `${root}/${name}`);
   const parsed = parseJsonc(text);
   if (parsed) return parsed;
  } catch {
   // 文件不存在或无权限：继续尝试下一个
  }
 }
 return null;
}

/**
 * 语言服务选项：诊断范围 + 同步策略 + 格式化开关。
 * 幂等：选项已是目标值时不再 setXxx——每次 set 都会触发 onDidChange（重启 worker）。
 */
function ensureLanguageServiceSetup(): void {
 for (const defaults of [
  typescript.typescriptDefaults,
  typescript.javascriptDefaults,
 ]) {
  if (defaults.getEagerModelSync()) defaults.setEagerModelSync(false);
  const diagnostics = defaults.getDiagnosticsOptions();
  if (
   diagnostics.onlyVisible !== true ||
   diagnostics.noSemanticValidation === true ||
   diagnostics.noSyntaxValidation === true
  ) {
   // 只校验贴在编辑器上的 model：worker 里的程序不再随打开过的文件无界增长
   defaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    onlyVisible: true,
   });
  }
  const mode = defaults.modeConfiguration;
  if (mode.documentRangeFormattingEdits || mode.onTypeFormattingEdits) {
   // 关闭 worker 侧格式化：格式化统一走 Prettier（formatProvider）
   defaults.setModeConfiguration({
    ...mode,
    documentRangeFormattingEdits: false,
    onTypeFormattingEdits: false,
   });
  }
 }
}

/** 按工作区配置 TS/JS worker。root 变化时重新配置（幂等）。 */
export async function configureTypeScript(root: string | null): Promise<void> {
 ensureLanguageServiceSetup();
 if (root === configuredRoot) return;
 configuredRoot = root;

 // 换项目（含从项目切到无项目）：先清掉上一个项目的额外库，避免跨项目残留
 replaceExtraLibs([]);

 const compilerOptions = root
  ? compilerOptionsFromTsconfig(await readTsconfig(root))
  : baseCompilerOptions();

 typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
 typescript.javascriptDefaults.setCompilerOptions(compilerOptions);
}

/**
 * 强制语言服务重新校验当前 model（挂起恢复后用）。
 * setDiagnosticsOptions 会触发 Monaco 的 onDidChange：先停掉 worker，
 * 再按 onlyVisible 重新检查贴在编辑器上的 model。
 */
export function pokeTypeScriptDiagnostics(): void {
 typescript.typescriptDefaults.setDiagnosticsOptions({
  ...typescript.typescriptDefaults.getDiagnosticsOptions(),
 });
 typescript.javascriptDefaults.setDiagnosticsOptions({
  ...typescript.javascriptDefaults.getDiagnosticsOptions(),
 });
}

/** 额外库集合签名：路径与内容长度都没变时不重复 setExtraLibs */
let extraLibsSignature = "";

/**
 * 整体替换注入 worker 的额外库（未打开文件）。
 * 一次调用放入全部文件，空数组即清空；不要逐个 addExtraLib——
 * 每次增删都会让每个已同步 model 重新做语义检查。
 */
export function replaceExtraLibs(
 files: readonly { path: string; content: string }[],
): void {
 const signature = files
  .map((file) => `${file.path}\u0000${file.content.length}`)
  .join("\u0001");
 if (signature === extraLibsSignature) return;
 extraLibsSignature = signature;

 const libs = files.map((file) => ({
  content: file.content,
  filePath: monaco.Uri.file(file.path).toString(),
 }));
 typescript.typescriptDefaults.setExtraLibs(libs);
 typescript.javascriptDefaults.setExtraLibs(libs);
}
