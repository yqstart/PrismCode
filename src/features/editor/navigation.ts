import { EditorView, ViewPlugin, Decoration, type DecorationSet } from "@codemirror/view";
import type { Extension, Text } from "@codemirror/state";
import {
  IMPORT_RE,
  PATH_RE,
  TEMPLATE_BIND_RE,
  CLASS_ATTR_RE,
  resolveImportCandidate,
  resolveImportPath,
} from "@/shared/importReferences";
import {
  findSymbolDefinition,
  indexDocumentSymbols,
  wordAt,
} from "@/features/editor/documentSymbols";
import {
  ensureTypeScriptProgram,
  openedContent,
  tsService,
} from "@/features/editor/typeService";
import {
  createVueScriptContext,
  getVueScriptBlocks,
  isInVueScript,
} from "@/features/editor/vueScript";
import { readTextFile } from "@/shared/fs";

export interface NavTarget {
  path: string;
  line: number;
  column: number;
  kind: "import" | "symbol";
}

export interface NavigationSource {
  /** 编辑器中可识别的声明导航源文本范围。 */
  from: number;
  to: number;
  word: string;
  kind: "import" | "symbol" | "component" | "style";
}

interface ImportedBinding {
  localName: string;
  importedName: string;
  spec: string;
  typeOnly: boolean;
  declarationFrom: number;
  declarationTo: number;
}

export interface VueComponentHit {
  tagName: string;
  from: number;
  to: number;
}

const IMPORT_DECL_RE = /\bimport\s+([\s\S]*?)\s+from\s*(["'])([^"']+)\2/g;
const TEMPLATE_BOUNDARY_RE = /<\/?template\b[^>]*>/gi;
const TEMPLATE_TAG_RE = /<([A-Za-z][\w.-]*)\b/g;
const STYLE_FILE_RE = /\.(?:css|scss|sass|less)$/i;
const BUILTIN_TEMPLATE_TAGS = new Set([
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "audio",
  "b",
  "base",
  "blockquote",
  "body",
  "br",
  "button",
  "canvas",
  "caption",
  "code",
  "col",
  "colgroup",
  "data",
  "datalist",
  "dd",
  "del",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "em",
  "embed",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "i",
  "iframe",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "link",
  "main",
  "map",
  "mark",
  "menu",
  "meta",
  "meter",
  "nav",
  "noscript",
  "object",
  "ol",
  "optgroup",
  "option",
  "output",
  "p",
  "picture",
  "pre",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "script",
  "search",
  "section",
  "select",
  "slot",
  "small",
  "source",
  "span",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "title",
  "tr",
  "track",
  "u",
  "ul",
  "var",
  "video",
  "wbr",
  // Vue 内置组件不属于当前工作区文件。
  "component",
  "keep-alive",
  "teleport",
  "transition",
  "transition-group",
  "suspense",
]);

function normalizeComponentName(name: string): string {
  return name.replace(/[._-]/g, "").toLowerCase();
}

function isComponentTag(tagName: string): boolean {
  return !BUILTIN_TEMPLATE_TAGS.has(tagName.toLowerCase());
}

function parseImportedBindings(text: string, baseOffset = 0): ImportedBinding[] {
  const bindings: ImportedBinding[] = [];
  IMPORT_DECL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_DECL_RE.exec(text))) {
    const rawClause = match[1]?.trim() ?? "";
    const spec = match[3] ?? "";
    // `import type` 只提供类型，不可能在 template 中成为运行时组件。
    if (!rawClause || /^type(?:\s|\{)/.test(rawClause)) continue;
    const clause = rawClause.replace(/^type\s+/, "").trim();
    const declarationFrom = baseOffset + match.index;
    const declarationTo = declarationFrom + match[0].length;
    const add = (localName: string, importedName: string, typeOnly = false): void => {
      if (!localName) return;
      bindings.push({
        localName,
        importedName,
        spec,
        typeOnly,
        declarationFrom,
        declarationTo,
      });
    };

    const named = clause.match(/\{([\s\S]*?)\}/)?.[1];
    if (named) {
      for (const item of named.split(",")) {
        const clean = item.replace(/\/\*[\s\S]*?\*\//g, "").trim();
        if (!clean) continue;
        const typeOnly = /^type\s+/.test(clean);
        const bindingText = clean.replace(/^type\s+/, "");
        const parsedBinding = bindingText.match(
          /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/,
        );
        if (parsedBinding) {
          add(parsedBinding[2] ?? parsedBinding[1], parsedBinding[1], typeOnly);
        }
      }
    }

    const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespace?.[1]) add(namespace[1], "*");

    const defaultName = clause.split(",", 1)[0]?.trim() ?? "";
    if (/^[A-Za-z_$][\w$]*$/.test(defaultName)) add(defaultName, "default");
  }
  return bindings;
}

function parseAsyncComponentBindings(text: string, baseOffset = 0): ImportedBinding[] {
  const bindings: ImportedBinding[] = [];
  const re =
    /\b(?:const|let|var)\s+([A-Z][\w$]*)\s*=\s*defineAsyncComponent\s*\(\s*\(\s*\)\s*=>\s*import\s*\(\s*(["'])([^"']+)\2/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const localName = match[1];
    const spec = match[3];
    if (!localName || !isLocalImportSpec(spec)) continue;
    bindings.push({
      localName,
      importedName: "default",
      spec,
      typeOnly: false,
      declarationFrom: baseOffset + match.index,
      declarationTo: baseOffset + match.index + match[0].length,
    });
  }
  return bindings;
}

function importedBindingsForDocument(doc: string, filePath: string): ImportedBinding[] {
  const blocks = /.vue$/i.test(filePath) ? getVueScriptBlocks(doc) : [];
  const sources = blocks.length ? blocks : [{ start: 0, end: doc.length }];
  return sources.flatMap((block) => {
    const text = doc.slice(block.start, block.end);
    return [
      ...parseImportedBindings(text, block.start),
      ...parseAsyncComponentBindings(text, block.start),
    ];
  });
}

function importedReferenceAtPos(
  doc: string,
  pos: number,
  bindings = importedBindingsForDocument(doc, ""),
): ImportedBinding | null {
  const hit = wordAt(doc, pos);
  if (!hit || pos < hit.from || pos > hit.to) return null;
  return (
    bindings.find(
      (binding) =>
        isLocalImportSpec(binding.spec) && binding.localName === hit.word,
    ) ?? null
  );
}

function componentImportForTag(
  doc: string,
  filePath: string,
  tagName: string,
  bindings = importedBindingsForDocument(doc, filePath),
): ImportedBinding | null {
  if (!/\.vue$/i.test(filePath) || !isComponentTag(tagName)) return null;
  const normalized = normalizeComponentName(tagName);
  return (
    bindings.find(
      (binding) =>
        isLocalImportSpec(binding.spec) &&
        !binding.typeOnly &&
        binding.importedName !== "*" &&
        normalizeComponentName(binding.localName) === normalized,
    ) ?? null
  );
}

function componentHitOnLine(
  lineText: string,
  lineStart: number,
  pos: number,
): VueComponentHit | null {
  TEMPLATE_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TEMPLATE_TAG_RE.exec(lineText))) {
    const tagName = match[1];
    if (!tagName || !isComponentTag(tagName)) continue;
    const from = lineStart + match.index + 1;
    const to = from + tagName.length;
    if (pos >= from && pos <= to) return { tagName, from, to };
  }
  return null;
}

export function findVueComponentAtPos(doc: string, pos: number): VueComponentHit | null {
  const ranges: Array<{ from: number; to: number }> = [];
  TEMPLATE_BOUNDARY_RE.lastIndex = 0;
  let depth = 0;
  let contentStart = -1;
  let boundary: RegExpExecArray | null;
  while ((boundary = TEMPLATE_BOUNDARY_RE.exec(doc))) {
    const token = boundary[0];
    const closing = /^<\//.test(token);
    const selfClosing = /\/\s*>$/.test(token);
    if (!closing && !selfClosing) {
      if (depth === 0) contentStart = boundary.index + token.length;
      depth += 1;
      continue;
    }
    if (!closing || depth === 0) continue;
    depth -= 1;
    if (depth === 0 && contentStart >= 0) {
      ranges.push({ from: contentStart, to: boundary.index });
      contentStart = -1;
    }
  }

  for (const range of ranges) {
    const content = doc.slice(range.from, range.to);
    const hit = componentHitOnLine(content, range.from, pos);
    if (hit) return hit;
  }
  return null;
}

/** 是否为本地模块 spec（相对路径或 `@/` 路径别名），可参与磁盘跳转 */
function isLocalImportSpec(spec: string | null | undefined): spec is string {
  return !!spec && (spec.startsWith(".") || spec.startsWith("@/"));
}

function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
  const safe = Math.max(0, Math.min(text.length, offset));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < safe; i += 1) {
    if (text[i] === "\n") {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: safe - lineStart + 1 };
}

async function findTypeScriptDefinition(
  doc: string,
  pos: number,
  root: string,
  currentFile: string,
): Promise<NavTarget | null> {
  const hit = wordAt(doc, pos);
  if (!hit || pos < hit.from || pos > hit.to) return null;
  const isVue = /\.vue$/i.test(currentFile);
  const inVueScript = isVue && isInVueScript(doc, pos);
  if (isVue && !inVueScript) return null;
  const virtual = inVueScript ? createVueScriptContext(currentFile, doc) : null;
  const serviceFile = virtual?.fileName ?? currentFile;
  const serviceText = virtual?.text ?? doc;
  if (!(await ensureTypeScriptProgram(root, serviceFile, serviceText))) return null;
  const definitions = tsService.definitionsAt(serviceFile, pos);
  for (const definition of definitions) {
    const path = definition.fileName === serviceFile ? currentFile : definition.fileName;
    const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const normalizedPath = path.replace(/\\/g, "/").toLowerCase();
    if (!(normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`))) continue;
    let targetText = path === currentFile ? doc : null;
    if (targetText === null) {
      try {
        targetText = await readTextFile(root, path);
      } catch {
        continue;
      }
    }
    const location = offsetToLineColumn(targetText, definition.textSpan.start);
    return { path, line: location.line, column: location.column, kind: "symbol" };
  }
  return null;
}

function findImportSpecAtPos(doc: string, pos: number): string | null {
  for (const re of [IMPORT_RE, PATH_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(doc))) {
      const spec = match[1];
      const specOffset = match[0].lastIndexOf(spec);
      if (specOffset < 0) continue;
      const start = match.index + specOffset;
      const end = start + spec.length;
      if (pos >= start && pos <= end) return spec;
    }
  }
  return null;
}

function collectLocalImportSpecs(doc: string): string[] {
  const specs: string[] = [];
  for (const source of [IMPORT_RE, PATH_RE]) {
    const re = new RegExp(source.source, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(doc))) {
      const spec = match[1];
      if (isLocalImportSpec(spec) && !specs.includes(spec)) specs.push(spec);
    }
  }
  return specs;
}

async function readWorkspaceText(root: string, path: string): Promise<string | null> {
  try {
    return (await openedContent(path)) ?? (await readTextFile(root, path));
  } catch {
    return null;
  }
}

function defaultExportOffset(text: string): number | null {
  const match = /\bexport\s+default\b/.exec(text);
  return match?.index ?? null;
}

function componentEntryOffset(text: string): number {
  const template = /<template\b/i.exec(text);
  if (template) return template.index + template[0].indexOf("template");

  const script = /<script\b/i.exec(text);
  if (script) return script.index + script[0].indexOf("script");

  return /\S/.exec(text)?.index ?? 0;
}

async function findVueComponentDefinition(
  doc: string,
  pos: number,
  root: string,
  currentFile: string,
): Promise<NavTarget | null> {
  const hit = findVueComponentAtPos(doc, pos);
  if (!hit) return null;
  const binding = componentImportForTag(doc, currentFile, hit.tagName);
  if (!binding) return null;

  const resolved = await resolveImportPath(root, currentFile, binding.spec);
  if (!resolved) return null;
  const text = await readWorkspaceText(root, resolved);
  if (text === null) return null;

  if (/\.vue$/i.test(resolved)) {
    const location = offsetToLineColumn(text, componentEntryOffset(text));
    return { path: resolved, line: location.line, column: location.column, kind: "symbol" };
  }

  const importedName = binding.importedName;
  const definition =
    (importedName !== "default" && indexDocumentSymbols(text, resolved).get(importedName)?.[0]) ??
    (importedName === "default"
      ? (() => {
          const offset = defaultExportOffset(text);
          if (offset === null) return null;
          const location = offsetToLineColumn(text, offset);
          return { line: location.line, column: location.column };
        })()
      : null);
  if (!definition) return null;
  return {
    path: resolved,
    line: definition.line,
    column: definition.column,
    kind: "symbol",
  };
}

/**
 * 光标位于本地 ES import 绑定时，返回它在源模块中的导出名。
 * 这条路径不需要先启动完整 TypeScript 程序，因此首次 ⌘B 也能即时跳转；
 * 别名 `import { source as local }` 会正确映射回 `source`。
 */
export function findImportedBindingAtPos(
  doc: string,
  pos: number,
): { spec: string; importedName: string } | null {
  const hit = wordAt(doc, pos);
  if (!hit || pos < hit.from || pos > hit.to) return null;
  const filePath = /<template\b/i.test(doc) ? ".vue" : "";
  const bindings = importedBindingsForDocument(doc, filePath);
  const binding = bindings.find(
    (item) =>
      isLocalImportSpec(item.spec) &&
      (item.localName === hit.word || item.importedName === hit.word) &&
      hit.from >= item.declarationFrom &&
      hit.to <= item.declarationTo,
  );
  return binding
    ? { spec: binding.spec, importedName: binding.importedName }
    : null;
}

async function findDirectImportedDefinition(
  doc: string,
  pos: number,
  root: string,
  currentFile: string,
): Promise<NavTarget | null> {
  const binding = findImportedBindingAtPos(doc, pos);
  if (!binding) return null;
  const resolved = await resolveImportPath(root, currentFile, binding.spec);
  if (!resolved) return null;
  if (binding.importedName === "*") {
    return { path: resolved, line: 1, column: 1, kind: "symbol" };
  }
  const text = await readWorkspaceText(root, resolved);
  if (text === null) return null;
  const definition = indexDocumentSymbols(text, resolved).get(binding.importedName)?.[0];
  if (definition) {
    return {
      path: resolved,
      line: definition.line,
      column: definition.column,
      kind: "symbol",
    };
  }

  // `export default function () {}` / `export default class {}` 没有可供
  // 轻量索引命名的符号，仍然把用户带到 default 声明处。
  if (binding.importedName === "default") {
    const offset = defaultExportOffset(text);
    if (offset !== null) {
      const location = offsetToLineColumn(text, offset);
      return { path: resolved, line: location.line, column: location.column, kind: "symbol" };
    }
  }
  return null;
}

/**
 * 行级 import spec 探测：import/require/from 及路径引用都是单行结构，
 * 装饰计算只扫光标所在行，避免每次光标移动对全文档跑正则。
 * 返回 spec 及其精确区间（供直接画下划线，省去二次定位）。
 */
function findImportSpecOnLine(
  lineText: string,
  lineStart: number,
  pos: number,
): { spec: string; from: number; to: number } | null {
  for (const re of [IMPORT_RE, PATH_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lineText))) {
      const spec = m[1];
      const specOffset = m[0].lastIndexOf(spec);
      if (specOffset < 0) continue;
      const start = lineStart + m.index + specOffset;
      const end = start + spec.length;
      if (pos < start || pos > end) continue;
      return {
        spec,
        from: start,
        to: end,
      };
    }
  }
  return null;
}

/**
 * Vue 模板绑定：把光标位置 `@click="foo"` / `v-on:click="foo"` / `{{ foo }}`
 * 解析为对标识符 `foo` 的引用，返回 word 区间。供 go-to-definition 跨段查找。
 */
function findTemplateBindAtPos(
  doc: string,
  pos: number,
): { word: string; from: number; to: number } | null {
  TEMPLATE_BIND_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEMPLATE_BIND_RE.exec(doc))) {
    const name = m[1];
    if (!name) continue;
    // 找的是 m[1] 在 m[0] 内的偏移
    const nameOffset = m[0].indexOf(name);
    if (nameOffset < 0) continue;
    const from = m.index + nameOffset;
    const to = from + name.length;
    if (pos >= from && pos <= to) {
      return { word: name, from, to };
    }
  }
  return null;
}

/** 行级模板绑定探测（装饰热路径用）：`@click="foo"` / `{{ foo }}` 为单行结构 */
function findTemplateBindOnLine(
  lineText: string,
  lineStart: number,
  pos: number,
): { word: string; from: number; to: number } | null {
  TEMPLATE_BIND_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEMPLATE_BIND_RE.exec(lineText))) {
    const name = m[1];
    if (!name) continue;
    const nameOffset = m[0].indexOf(name);
    if (nameOffset < 0) continue;
    const from = lineStart + m.index + nameOffset;
    const to = from + name.length;
    if (pos >= from && pos <= to) {
      return { word: name, from, to };
    }
  }
  return null;
}

function isDynamicClassAttribute(source: string, matchStart: number): boolean {
  return (
    source[matchStart - 1] === ":" ||
    source.slice(Math.max(0, matchStart - 8), matchStart).endsWith("v-bind:")
  );
}

function classTokenAt(
  value: string,
  valueStart: number,
  pos: number,
  dynamic: boolean,
): { word: string; from: number; to: number } | null {
  const patterns = dynamic
    ? [
        // `:class="['card']"`：字符串字面量是确定的 class 名。
        /(['"])([A-Za-z_][\w-]*)\1/g,
        // `:class="{ card: active }"`：对象 key 是确定的 class 名。
        /(?:^|[,{]\s*)(?:['"])?([A-Za-z_][\w-]*)(?:['"])?\s*:/g,
      ]
    : [/([A-Za-z_][\w-]*)/g];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value))) {
      const word = match[dynamic && match[2] ? 2 : 1];
      if (!word) continue;
      const wordOffset = match[0].lastIndexOf(word);
      if (wordOffset < 0) continue;
      const from = valueStart + match.index + wordOffset;
      const to = from + word.length;
      if (pos >= from && pos <= to) return { word, from, to };
    }
  }
  return null;
}

/**
 * HTML/Vue class 属性：`class="foo bar"` 中光标所在的那个 class 名。
 * 支持含连字符的 class（如 `my-class`），返回精确区间供 go-to-definition。
 */
function findClassAttrAtPos(
  doc: string,
  pos: number,
): { word: string; from: number; to: number } | null {
  CLASS_ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLASS_ATTR_RE.exec(doc))) {
    const fullMatch = m[0];
    const valueStart = m.index + fullMatch.indexOf(m[1]);
    const valueEnd = valueStart + m[1].length;
    if (pos < valueStart || pos > valueEnd) continue;
    const value = m[1];
    const dynamic = isDynamicClassAttribute(doc, m.index);
    const hit = classTokenAt(value, valueStart, pos, dynamic);
    if (hit) return hit;
  }
  return null;
}

/** 行级 class 属性探测（装饰热路径用，class 属性为单行结构） */
function findClassAttrOnLine(
  lineText: string,
  lineStart: number,
  pos: number,
): { word: string; from: number; to: number } | null {
  CLASS_ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLASS_ATTR_RE.exec(lineText))) {
    const valueStart = lineStart + m.index + m[0].indexOf(m[1]);
    const valueEnd = valueStart + m[1].length;
    if (pos < valueStart || pos > valueEnd) continue;
    const dynamic = isDynamicClassAttribute(lineText, m.index);
    const hit = classTokenAt(m[1], valueStart, pos, dynamic);
    if (hit) return hit;
  }
  return null;
}

function findImportSpecRangeAtPos(
  doc: string,
  pos: number,
): { spec: string; from: number; to: number } | null {
  for (const re of [IMPORT_RE, PATH_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(doc))) {
      const spec = match[1];
      const specOffset = match[0].lastIndexOf(spec);
      if (specOffset < 0) continue;
      const from = match.index + specOffset;
      const to = from + spec.length;
      if (pos >= from && pos <= to) return { spec, from, to };
    }
  }
  return null;
}

function classDefinitionAt(
  doc: string,
  filePath: string,
  className: string,
): { line: number; column: number } | null {
  const definition = indexDocumentSymbols(doc, filePath).get(className)?.[0];
  return definition ? { line: definition.line, column: definition.column } : null;
}

function hasStyleImportCandidate(doc: string, root: string | null, currentFile: string): boolean {
  if (!root) return false;
  return collectLocalImportSpecs(doc).some((spec) => {
    if (STYLE_FILE_RE.test(spec)) return true;
    const candidate = resolveImportCandidate(root, currentFile, spec);
    return Boolean(candidate && STYLE_FILE_RE.test(candidate));
  });
}

async function findStyleDefinition(
  doc: string,
  pos: number,
  root: string,
  currentFile: string,
): Promise<NavTarget | null> {
  const hit = findClassAttrAtPos(doc, pos);
  if (!hit) return null;

  const local = classDefinitionAt(doc, currentFile, hit.word);
  if (local) {
    return { path: currentFile, line: local.line, column: local.column, kind: "symbol" };
  }

  for (const spec of collectLocalImportSpecs(doc)) {
    const resolved = await resolveImportPath(root, currentFile, spec);
    if (!resolved || !STYLE_FILE_RE.test(resolved)) continue;
    const text = await readWorkspaceText(root, resolved);
    if (text === null) continue;
    const definition = classDefinitionAt(text, resolved, hit.word);
    if (definition) {
      return {
        path: resolved,
        line: definition.line,
        column: definition.column,
        kind: "symbol",
      };
    }
  }
  return null;
}

/** 取光标处的 word：优先 class 属性，再模板绑定，最后 documentSymbols.wordAt */
function wordAtOrTemplateBind(
  doc: string,
  pos: number,
): { word: string; from: number; to: number } | null {
  const classHit = findClassAttrAtPos(doc, pos);
  if (classHit && pos >= classHit.from && pos <= classHit.to) return classHit;
  const w = wordAt(doc, pos);
  if (w && pos >= w.from && pos <= w.to) return w;
  return findTemplateBindAtPos(doc, pos);
}

/**
 * Prism Code 的可点击源判定：先处理路径、组件和样式，再处理脚本/模板符号。
 * 这是同步的轻量判断，只负责画出当前光标下的链接；真正跳转仍由异步解析完成。
 */
export function findNavigationSourceAtPos(
  doc: string,
  pos: number,
  workspaceRoot: string | null,
  currentFile: string,
): NavigationSource | null {
  const importHit = findImportSpecRangeAtPos(doc, pos);
  if (importHit && isLocalImportSpec(importHit.spec)) {
    const resolved = resolveImportCandidate(workspaceRoot, currentFile, importHit.spec);
    if (resolved) {
      return { ...importHit, word: importHit.spec, kind: "import" };
    }
  }

  const bindings = importedBindingsForDocument(doc, currentFile);
  const componentHit = findVueComponentAtPos(doc, pos);
  if (componentHit && componentImportForTag(doc, currentFile, componentHit.tagName, bindings)) {
    return { ...componentHit, word: componentHit.tagName, kind: "component" };
  }

  const classHit = findClassAttrAtPos(doc, pos);
  if (classHit) {
    const localDefinition = classDefinitionAt(doc, currentFile, classHit.word);
    if (localDefinition || hasStyleImportCandidate(doc, workspaceRoot, currentFile)) {
      return { ...classHit, kind: "style" };
    }
  }

  const imported = importedReferenceAtPos(doc, pos, bindings);
  if (imported) {
    const hit = wordAt(doc, pos);
    if (hit) return { ...hit, kind: "symbol" };
  }

  const hit = wordAt(doc, pos);
  if (hit && indexDocumentSymbols(doc, currentFile).get(hit.word)?.length) {
    return { ...hit, kind: "symbol" };
  }

  const bindHit = findTemplateBindAtPos(doc, pos);
  if (bindHit) {
    const hasLocalSymbol = indexDocumentSymbols(doc, currentFile).get(bindHit.word)?.length;
    const hasImportedSymbol = bindings.some(
      (binding) => isLocalImportSpec(binding.spec) && binding.localName === bindHit.word,
    );
    if (hasLocalSymbol || hasImportedSymbol) return { ...bindHit, kind: "symbol" };
  }
  return null;
}

/** 同步：仅用于下划线提示 */
export function findTargetAtPos(
  doc: string,
  pos: number,
  workspaceRoot: string | null,
  currentFile: string,
): NavTarget | null {
  const spec = findImportSpecAtPos(doc, pos);
  if (isLocalImportSpec(spec)) {
    const resolved = resolveImportCandidate(workspaceRoot, currentFile, spec);
    if (resolved) {
      return { path: resolved, line: 1, column: 1, kind: "import" };
    }
  }

  // Vue 模板中的组件引用：同步阶段只能确定目标文件，打开后的异步阶段
  // 会把落点细化到目标 SFC 的 `<template>` 或 `<script>` 标签。
  const componentHit = findVueComponentAtPos(doc, pos);
  if (componentHit && workspaceRoot) {
    const binding = componentImportForTag(doc, currentFile, componentHit.tagName);
    if (binding) {
      const resolved = resolveImportCandidate(workspaceRoot, currentFile, binding.spec);
      if (resolved) return { path: resolved, line: 1, column: 1, kind: "symbol" };
    }
  }

  // class 属性里的 class 名（如 class="foo"）-> 直接查 CSS class 定义。
  // 优先于 findSymbolDefinition，因为 wordAt 不支持含 `-` 的 class 名。
  const classHit = findClassAttrAtPos(doc, pos);
  if (classHit && pos >= classHit.from && pos <= classHit.to) {
    const idx = indexDocumentSymbols(doc, currentFile);
    const defs = idx.get(classHit.word);
    if (defs?.length) {
      return { path: currentFile, line: defs[0].line, column: defs[0].column, kind: "symbol" };
    }
  }

  const sym = findSymbolDefinition(doc, pos, currentFile);
  if (sym) {
    return {
      path: currentFile,
      line: sym.line,
      column: sym.column,
      kind: "symbol",
    };
  }

  // 模板段内的标识符（@click="foo" / v-on:click / {{ foo }}），
  // 走与符号同样的下划线提示：找到 word 区间就提示。同步阶段不跨文件。
  const bindHit = findTemplateBindAtPos(doc, pos);
  if (bindHit) {
    return {
      path: currentFile,
      line: 1,
      column: 1,
      kind: "symbol",
    };
  }
  return null;
}

/** 异步：实际跳转（磁盘存在性校验 + 扩展名解析 + 跨文件符号） */
export async function findTargetAtPosAsync(
  doc: string,
  pos: number,
  workspaceRoot: string | null,
  currentFile: string,
): Promise<NavTarget | null> {
  const spec = findImportSpecAtPos(doc, pos);
  if (isLocalImportSpec(spec) && workspaceRoot) {
    const resolved = await resolveImportPath(workspaceRoot, currentFile, spec);
    if (resolved) {
      return { path: resolved, line: 1, column: 1, kind: "import" };
    }
  }

  // 组件引用不交给 TypeScript 处理：template 并不在 TS 虚拟文件中，
  // 这里按 Vue import 约定解析 PascalCase/kebab-case 组件名。
  if (workspaceRoot) {
    try {
      const component = await findVueComponentDefinition(
        doc,
        pos,
        workspaceRoot,
        currentFile,
      );
      if (component) return component;
    } catch {
      // 组件文件刚被移动/删除时继续走脚本和轻量符号路径。
    }
  }

  // 直接 import 绑定优先走轻量、确定性的目标文件索引。首次按 ⌘B 时无需
  // 等待 5MB TypeScript 运行时和整条 import 闭包加载，失败再进入语义路径。
  if (workspaceRoot) {
    try {
      const direct = await findDirectImportedDefinition(
        doc,
        pos,
        workspaceRoot,
        currentFile,
      );
      if (direct) return direct;
    } catch {
      // 文件刚被移动/删除时继续尝试 TypeScript 与工作区索引降级路径。
    }
  }

  // JS/TS/Vue script 优先走真实 TypeScript definition；失败后再走正则符号索引。
  if (workspaceRoot) {
    try {
      const semantic = await findTypeScriptDefinition(
        doc,
        pos,
        workspaceRoot,
        currentFile,
      );
      if (semantic) return semantic;
    } catch {
      // 类型服务懒加载/解析失败时继续使用轻量路径和符号索引。
    }
  }

  // class 属性里的 class 名 -> 直接查 CSS class 定义（含 Vue <style> 段）
  const classHit = findClassAttrAtPos(doc, pos);
  if (classHit && pos >= classHit.from && pos <= classHit.to) {
    const idx = indexDocumentSymbols(doc, currentFile);
    const defs = idx.get(classHit.word);
    if (defs?.length) {
      return { path: currentFile, line: defs[0].line, column: defs[0].column, kind: "symbol" };
    }
  }

  // Vue/HTML class 也支持外置 CSS/SCSS/Less/Sass；当前文件没有定义时，
  // 沿本文件的样式 import 查找精确选择器。
  if (workspaceRoot) {
    try {
      const style = await findStyleDefinition(doc, pos, workspaceRoot, currentFile);
      if (style) return style;
    } catch {
      // 样式文件不可读时继续使用其余导航策略。
    }
  }

  const sym = findSymbolDefinition(doc, pos, currentFile);
  if (sym) {
    return {
      path: currentFile,
      line: sym.line,
      column: sym.column,
      kind: "symbol",
    };
  }

  // 当前文件未命中定义时，跨 import 链查找（同样适用于模板段标识符）
  if (workspaceRoot) {
    const hit = wordAtOrTemplateBind(doc, pos);
    if (hit && pos >= hit.from && pos <= hit.to) {
      const { workspaceSymbols } = await import("@/features/editor/workspaceSymbols");
      const cross = await workspaceSymbols.findDefinitionAcrossFiles(
        workspaceRoot,
        hit.word,
        currentFile,
      );
      if (cross) {
        return { path: cross.path, line: cross.line, column: cross.column, kind: "symbol" };
      }
    }
  }

  return null;
}

export interface NavigationHandlers {
  onNavigate: (path: string, line: number, column: number) => void;
  /** 返回成功时返回 true；没有历史时返回 false，让原生编辑命令继续处理。 */
  onGoBack: () => boolean;
  onGoForward: () => boolean;
  workspaceRoot: () => string | null;
  currentFile: () => string;
}

function canAttemptNavigation(doc: string, pos: number): boolean {
  return Boolean(
    findImportSpecAtPos(doc, pos) ||
      findClassAttrAtPos(doc, pos) ||
      wordAtOrTemplateBind(doc, pos),
  );
}

const linkMark = Decoration.mark({ class: "cm-nav-link" });

/**
 * 计算导航下划线装饰（输入/光标热路径）。
 * 只扫光标所在行（import/class/模板绑定均为单行结构），符号判定走
 * 记忆化的全文档索引；纯光标移动时 doc 字符串引用不变，索引 O(1) 命中。
 */
function computeLinkDecorations(
  view: EditorView,
  handlers: NavigationHandlers,
  docText: string,
  importedBindings: ImportedBinding[],
): DecorationSet {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const specHit = findImportSpecOnLine(line.text, line.from, pos);
  const classHit = findClassAttrOnLine(line.text, line.from, pos);
  const componentHit = /.vue$/i.test(handlers.currentFile())
    ? componentHitOnLine(line.text, line.from, pos)
    : null;
  const hit = wordAt(docText, pos);
  const onWord = !!hit && pos >= hit.from && pos <= hit.to;
  const onClass = !!classHit && pos >= classHit.from && pos <= classHit.to;
  // 光标不在 import 路径 / 标识符 / class 名上：直接不画，跳过索引查询
  if (!specHit && !onWord && !onClass && !componentHit) return Decoration.none;

  // import 路径：同步解析（不查磁盘），命中才画
  if (specHit && isLocalImportSpec(specHit.spec)) {
    const resolved = resolveImportCandidate(
      handlers.workspaceRoot(),
      handlers.currentFile(),
      specHit.spec,
    );
    if (resolved) {
      return Decoration.set([linkMark.range(specHit.from, specHit.to)]);
    }
  }

  const doc = docText;
  const file = handlers.currentFile();
  const index = indexDocumentSymbols(doc, file);

  // Vue 组件引用：PascalCase 和 kebab-case 统一按 import 绑定匹配。
  if (componentHit && componentImportForTag(doc, file, componentHit.tagName, importedBindings)) {
    return Decoration.set([linkMark.range(componentHit.from, componentHit.to)]);
  }

  // class 属性里的 class 名优先用 classHit 区间（支持含 `-` 的 class 名）
  if (
    onClass &&
    (index.get(classHit.word)?.length ||
      hasStyleImportCandidate(doc, handlers.workspaceRoot(), file))
  ) {
    return Decoration.set([linkMark.range(classHit.from, classHit.to)]);
  }

  // 普通标识符：符号索引命中或模板段绑定引用（@click / {{ }}）命中则画
  if (onWord) {
    if (importedReferenceAtPos(doc, pos, importedBindings)) {
      return Decoration.set([linkMark.range(hit.from, hit.to)]);
    }
    if (index.get(hit.word)?.length) {
      return Decoration.set([linkMark.range(hit.from, hit.to)]);
    }
    const bindHit = findTemplateBindOnLine(line.text, line.from, pos);
    if (bindHit && (index.get(bindHit.word)?.length || importedBindings.some(
      (binding) => isLocalImportSpec(binding.spec) && binding.localName === bindHit.word,
    ))) {
      return Decoration.set([linkMark.range(bindHit.from, bindHit.to)]);
    }
  }
  return Decoration.none;
}

async function navigateFromView(
  view: EditorView,
  handlers: NavigationHandlers,
  pos: number,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  const sourceText = view.state.doc.toString();
  const sourceFile = handlers.currentFile();
  const target = await findTargetAtPosAsync(
    sourceText,
    pos,
    handlers.workspaceRoot(),
    sourceFile,
  );
  // 异步解析期间用户可能已经输入、切换标签或再次点击了另一个目标。
  if (!isCurrent() || sourceText !== view.state.doc.toString() || sourceFile !== handlers.currentFile()) {
    return false;
  }
  if (!target) return false;
  handlers.onNavigate(target.path, target.line, target.column);
  return true;
}

export function createNavigationExtension(handlers: NavigationHandlers): Extension {
  const linkPlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      // doc 字符串按 Text 引用缓存：纯光标移动（selectionSet 无 docChanged）
      // 时 update.state.doc 是同一 Text 实例，直接复用字符串，跳过 toString
      private lastDocText: Text;
      private lastDocString: string;
      private importedBindings: ImportedBinding[];

      constructor(view: EditorView) {
        this.lastDocText = view.state.doc;
        this.lastDocString = view.state.doc.toString();
        this.importedBindings = importedBindingsForDocument(
          this.lastDocString,
          handlers.currentFile(),
        );
        this.decorations = computeLinkDecorations(
          view,
          handlers,
          this.lastDocString,
          this.importedBindings,
        );
      }

      update(update: import("@codemirror/view").ViewUpdate) {
        if (!update.selectionSet && !update.docChanged) return;
        if (update.state.doc !== this.lastDocText) {
          this.lastDocText = update.state.doc;
          this.lastDocString = update.state.doc.toString();
          this.importedBindings = importedBindingsForDocument(
            this.lastDocString,
            handlers.currentFile(),
          );
        }
        this.decorations = computeLinkDecorations(
          update.view,
          handlers,
          this.lastDocString,
          this.importedBindings,
        );
      }
    },
    { decorations: (v) => v.decorations },
  );

  return [
    linkPlugin,
    EditorView.baseTheme({
      ".cm-nav-link": {
        textDecoration: "underline",
        textUnderlineOffset: "2px",
        cursor: "default",
        color: "var(--accent)",
      },
    }),
  ];
}

export function goToDefinitionKeymap(handlers: NavigationHandlers) {
  const run = (view: EditorView) => {
    const pos = view.state.selection.main.head;
    if (!canAttemptNavigation(view.state.doc.toString(), pos)) return false;
    void navigateFromView(view, handlers, pos);
    return true;
  };
  return [
    {
      key: "Mod-b",
      run,
    },
    {
      key: "Mod-Enter",
      run,
    },
    {
      key: "F12",
      run,
    },
  ];
}

export function goBackKeymap(handlers: NavigationHandlers) {
  return {
    key: "Mod-[",
    run() {
      return handlers.onGoBack();
    },
  };
}

export function goForwardKeymap(handlers: NavigationHandlers) {
  return {
    key: "Mod-]",
    run() {
      return handlers.onGoForward();
    },
  };
}
