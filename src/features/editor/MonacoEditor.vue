<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { monaco } from "@/features/editor/monaco/setup";
import { languageForContent, largeFileOptions } from "@/features/editor/monaco/largeFile";
import {
  flashJumpTarget,
  installGitBlame,
  installGitChanges,
  type GitBlameController,
} from "@/features/editor/monaco/decorations";
import { registerMonacoThemes } from "@/features/editor/monacoTheme";
import {
  configureTypeScript,
  pokeTypeScriptDiagnostics,
} from "@/features/editor/monaco/tsProvider";
import { registerFormatProviders } from "@/features/editor/monaco/formatProvider";
import { registerHtmlCssProviders } from "@/features/editor/monaco/htmlCssProvider";
import { registerEmmetProvider } from "@/features/editor/monaco/emmetProvider";
import { registerVueLanguage } from "@/features/editor/monaco/vueProvider";
import { registerJsonEnvProviders } from "@/features/editor/monaco/jsonEnvProvider";
import {
  installExtraLibs,
  refreshActiveExtraLibs,
} from "@/features/editor/monaco/extraLibs";
import {
  WORKER_SUSPEND_MS,
  languageWorkerMode,
  retainedModelPaths,
  shouldSuspendLanguageWorkers,
} from "@/features/editor/monaco/languageBudget";
import {
  setLanguageWorkersSuspended,
  stopLanguageWorkersExcept,
} from "@/features/editor/monaco/tsWorkerManager";
import { registerUserSnippets } from "@/features/editor/monaco/snippetsProvider";
import { applyKeymapPreset, registerOwnCommands } from "@/features/editor/monaco/actions";
import { installEslint } from "@/features/editor/monaco/eslint";
import { installConflictResolver } from "@/features/editor/monaco/conflictResolver";
import {
  trackSymbolChain,
  type BreadcrumbController,
  type SymbolCrumb,
} from "@/features/editor/monaco/breadcrumbs";
import {
  installVueScriptDiagnostics,
  refreshVueDiagnostics,
  registerVueScriptCompletions,
} from "@/features/editor/monaco/vueScriptService";
import { getEditorFontFamily } from "@/features/editor/fonts";
import { relativeToRoot } from "@/shared/fs";
import { useEditorStore } from "@/stores/editor";
import { useGitStore } from "@/stores/git";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import { useI18n } from "@/i18n";

// 语言注册必须先于 createModel 执行（模块导入即注册，幂等）
registerVueLanguage();

const props = defineProps<{
  path: string;
  content: string;
}>();

const host = ref<HTMLDivElement | null>(null);
const { t } = useI18n();
const editorStore = useEditorStore();
const settings = useSettingsStore();
const workspace = useWorkspaceStore();
const git = useGitStore();
const { theme, editor: editorPrefs } = storeToRefs(settings);
const { openAt, blameVisible } = storeToRefs(editorStore);

let codeEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let currentPath = "";
/** 上一个标签路径：语言服务只保留当前 + 上一个文件的 model */
let previousRetainedPath = "";
/** 失焦挂起计时器：窗口离开焦点满 WORKER_SUSPEND_MS 后释放语言服务 worker */
let suspendTimer: ReturnType<typeof setTimeout> | undefined;
let blurredAt = 0;
/** 本窗口是否因失焦挂起过语言服务（聚焦时只有真挂起过才需要重启） */
let languageWorkersSuspended = false;
let applyingExternal = false;
let resizeObserver: ResizeObserver | null = null;
let measureRaf: number | null = null;
let measureTimer: ReturnType<typeof setTimeout> | null = null;
let cursorRaf: number | null = null;
let pendingCursorPath = "";
let pendingCursorLine = 1;
let pendingCursorColumn = 1;
let disposeGitChanges: (() => void) | null = null;
let blameController: GitBlameController | null = null;
let contentSub: monaco.IDisposable | null = null;
let cursorSub: monaco.IDisposable | null = null;
let keymapController: { dispose(): void } | null = null;
let ownCommands: { dispose(): void } | null = null;
let eslintController: ReturnType<typeof installEslint> | null = null;
let breadcrumbController: BreadcrumbController | null = null;

/** 光标所在符号链（Monaco 无内置面包屑，自研 DOM 条） */
const crumbs = ref<SymbolCrumb[]>([]);

const themeName = computed(() => theme.value);
const fontFamily = computed(() => getEditorFontFamily(editorPrefs.value.fontFamily));

/** path → model；关闭标签时由 pruneModels 回收 */
const modelCache = new Map<string, monaco.editor.ITextModel>();
/** path → 视图状态（滚动/光标/折叠） */
const viewStateCache = new Map<string, monaco.editor.ICodeEditorViewState | null>();

const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: false,
  detectIndentation: false,
  glyphMargin: false,
  lineDecorationsWidth: 12,
  scrollBeyondLastLine: true,
  padding: { top: 6, bottom: 200 },
  renderWhitespace: "selection",
  renderLineHighlight: "line",
  smoothScrolling: true,
  cursorBlinking: "smooth",
  cursorSmoothCaretAnimation: "on",
  mouseWheelZoom: false,
  multiCursorModifier: "alt",
  fontLigatures: false,
  guides: { indentation: true, bracketPairs: true, highlightActiveIndentation: true },
  bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: true },
  inlayHints: { enabled: "off" },
  wordBasedSuggestions: "currentDocument",
  suggest: { showWords: true, preview: true },
  quickSuggestions: { other: true, comments: false, strings: true },
  tabCompletion: "on",
  linkedEditing: true,
  formatOnPaste: false,
  formatOnType: false,
  'semanticHighlighting.enabled': true,
  largeFileOptimizations: true,
  unusualLineTerminators: "prompt",
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
  overviewRulerBorder: false,
  hideCursorInOverviewRuler: true,
  fixedOverflowWidgets: true,
};

/** 相对行号：当前行显示绝对值，其余显示与当前行的距离 */
function lineNumbersOption(): monaco.editor.IEditorOptions["lineNumbers"] {
  if (!editorPrefs.value.lineNumbers) return "off";
  if (!editorPrefs.value.relativeLineNumbers) return "on";
  return (lineNumber: number) => {
    const current = codeEditor?.getPosition()?.lineNumber;
    if (!current || lineNumber === current) return String(lineNumber);
    return String(Math.abs(lineNumber - current));
  };
}

function prefsOptions(): monaco.editor.IEditorOptions {
  return {
    fontSize: editorPrefs.value.fontSize,
    fontFamily: fontFamily.value,
    lineNumbers: lineNumbersOption(),
    wordWrap: editorPrefs.value.wordWrap ? "on" : "off",
    stickyScroll: { enabled: editorPrefs.value.stickyScroll, maxLineCount: 5 },
    minimap: { enabled: editorPrefs.value.minimap, renderCharacters: false, maxColumn: 100 },
    rulers: editorPrefs.value.rulers,
  };
}

/** 光标写入节流：同一帧内合并为一次 store 写入（状态栏行/列允许 16ms 延迟） */
function emitCursor(): void {
  if (!codeEditor) return;
  const position = codeEditor.getPosition();
  if (!position) return;
  // 捕获触发时刻的路径：帧末回调执行时可能已切换标签
  pendingCursorPath = currentPath;
  pendingCursorLine = position.lineNumber;
  pendingCursorColumn = position.column;
  if (cursorRaf !== null) return;
  cursorRaf = requestAnimationFrame(() => {
    cursorRaf = null;
    editorStore.setCursor(pendingCursorPath, pendingCursorLine, pendingCursorColumn);
  });
}

/** 编辑器可能在 Transition、终端面板或窗口恢复尚未完成布局时创建：
 *  容器为 0 高度时 Monaco 不会自行恢复，用 ResizeObserver + rAF + 定时器兜底。 */
function scheduleMeasure(): void {
  if (measureRaf !== null) return;
  measureRaf = requestAnimationFrame(() => {
    measureRaf = null;
    codeEditor?.layout();
  });
  if (measureTimer !== null) clearTimeout(measureTimer);
  measureTimer = setTimeout(() => {
    measureTimer = null;
    codeEditor?.layout();
  }, 120);
}

function ensureModel(path: string, content: string): monaco.editor.ITextModel {
  const cached = modelCache.get(path);
  if (cached) return cached;
  const model = monaco.editor.createModel(
    content,
    languageForContent(path, content),
    monaco.Uri.file(path),
  );
  modelCache.set(path, model);
  return model;
}

/**
 * 缩进必须写在 model attach 到编辑器**之后**：attach 之前 updateOptions
 * 会被 Monaco 用默认值（tabSize 4）重置，表现为设置里的缩进不生效。
 */
function applyIndentOptions(): void {
  for (const model of modelCache.values()) {
    model.updateOptions({ tabSize: editorPrefs.value.tabSize, insertSpaces: true });
  }
}

function disposeGitDecorations(): void {
  disposeGitChanges?.();
  disposeGitChanges = null;
  blameController?.dispose();
  blameController = null;
}

function attachGitDecorations(path: string): void {
  disposeGitDecorations();
  if (!codeEditor) return;
  const root = workspace.rootPath;
  if (!root) return;
  const relPath = relativeToRoot(root, path);
  disposeGitChanges = installGitChanges(codeEditor, {
    root,
    relPath,
    openDiff: () => {
      void git.showDiff(relPath, false);
    },
  });
  blameController = installGitBlame(codeEditor, {
    root,
    relPath,
    visible: blameVisible.value,
  });
}

/**
 * 语言服务只保留有限文件的 model：当前标签 + 上一个标签。
 * 其余标签的模型释放（正文由 editor store 持有，需要时按 store 内容重建），
 * 否则 worker 里的类型程序会随打开过的每个文件持续变大。
 */
function pruneModels(): void {
  const openPaths = editorStore.tabs.map((tab) => tab.path);
  const kept = new Set(retainedModelPaths(currentPath, previousRetainedPath, openPaths));
  const open = new Set(openPaths);
  for (const [path, model] of modelCache) {
    if (kept.has(path)) continue;
    // 未写回 store 的编辑先同步，模型释放后重新打开仍能恢复
    const tab = editorStore.tabs.find((item) => item.path === path);
    if (tab && !model.isDisposed() && model.getValue() !== tab.content) {
      editorStore.setContent(path, model.getValue());
    }
    // 视图状态只在标签已关闭时丢弃；仍打开但被换出的标签保留滚动/折叠/光标
    if (!open.has(path)) viewStateCache.delete(path);
    modelCache.delete(path);
    model.dispose();
  }
}

function switchDocument(path: string, content: string): void {
  if (!codeEditor) return;
  if (currentPath && codeEditor.getModel()) {
    viewStateCache.set(currentPath, codeEditor.saveViewState());
  }
  previousRetainedPath = currentPath;
  currentPath = path;
  pruneModels();

  const model = ensureModel(path, content);
  if (model.getValue() !== content) {
    applyingExternal = true;
    model.setValue(content);
    applyingExternal = false;
  }
  codeEditor.setModel(model);
  applyIndentOptions();
  codeEditor.updateOptions(largeFileOptions(model.getValue()));
  const viewState = viewStateCache.get(path);
  if (viewState) codeEditor.restoreViewState(viewState);
  // 同一时刻只留当前语言需要的编译器（TS↔JS 切换时停掉另一套），
  // 并把额外库换成这个文件的直接 import
  stopLanguageWorkersExcept(languageWorkerMode(model.getLanguageId()));
  void refreshActiveExtraLibs(model);
  attachGitDecorations(path);
  emitCursor();
  scheduleMeasure();
}

function jumpToCrumb(crumb: SymbolCrumb): void {
  const model = codeEditor?.getModel();
  if (!model || !codeEditor) return;
  const position = model.getPositionAt(crumb.offset);
  codeEditor.setPosition(position);
  codeEditor.revealPositionInCenter(position);
  codeEditor.focus();
}

function scrollTo(line: number, column: number): void {
  const target = codeEditor;
  const model = target?.getModel();
  if (!target || !model) return;
  const lineNumber = Math.max(1, Math.min(line, model.getLineCount()));
  const maxColumn = model.getLineMaxColumn(lineNumber);
  const position = {
    lineNumber,
    column: Math.max(1, Math.min(column, maxColumn)),
  };
  target.setPosition(position);
  target.revealPositionInCenter(position);
  const word = model.getWordAtPosition(position);
  flashJumpTarget(target, {
    from: model.getOffsetAt(
      word ? { lineNumber, column: word.startColumn } : position,
    ),
    to: model.getOffsetAt(
      word
        ? { lineNumber, column: word.startColumn + word.word.length }
        : { lineNumber, column: Math.min(position.column + 1, maxColumn) },
    ),
  });
  target.focus();
  emitCursor();
}

/** ⌘/Ctrl + 滚轮调字号：上推调小、下推调大（与迁移前一致） */
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 24;
const WHEEL_STEP_DELTA = 100;
let fontWheelAcc = 0;

function onWheel(event: WheelEvent): void {
  if (!host.value) return;
  if (!(event.metaKey || event.ctrlKey)) return;
  event.preventDefault();
  event.stopPropagation();
  const delta =
    event.deltaMode === 1 ? event.deltaY * 40 : event.deltaMode === 2 ? event.deltaY * 100 : event.deltaY;
  fontWheelAcc += delta / WHEEL_STEP_DELTA;
  const steps = Math.trunc(fontWheelAcc);
  if (steps === 0) return;
  fontWheelAcc -= steps;
  const current = settings.editor.fontSize;
  const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, current + steps));
  if (next !== current) settings.patchEditor({ fontSize: next });
}

function createEditor(): void {
  if (!host.value) return;
  registerMonacoThemes();
  const model = ensureModel(props.path, props.content);
  currentPath = props.path;
  codeEditor = monaco.editor.create(host.value, {
    ...EDITOR_OPTIONS,
    ...prefsOptions(),
    model,
    theme: themeName.value,
  });
  contentSub = codeEditor.onDidChangeModelContent(() => {
    if (!codeEditor || applyingExternal) return;
    const active = codeEditor.getModel();
    if (!active) return;
    editorStore.setContent(currentPath, active.getValue());
    // 保存动作会把 dirty 清掉，这里以「内容写回后是否仍脏」判断保存时机
    if (!editorStore.isDirty(currentPath)) eslintController?.lintNow(active);
  });
  cursorSub = codeEditor.onDidChangeCursorPosition(() => {
    emitCursor();
  });
  codeEditor.onDidFocusEditorText(() => {
    void git.scheduleRefresh();
  });
  applyIndentOptions();
  codeEditor.updateOptions(largeFileOptions(model.getValue()));
  ownCommands = registerOwnCommands(codeEditor, {
    onToggleWordWrap: () => {
      settings.patchEditor({ wordWrap: !settings.editor.wordWrap });
    },
  });
  keymapController = applyKeymapPreset(editorPrefs.value.keymap);
  attachGitDecorations(props.path);
  breadcrumbController ??= trackSymbolChain(codeEditor, (chain) => {
    crumbs.value = chain;
  });
  void refreshActiveExtraLibs(model);
  emitCursor();
  scheduleMeasure();
}

function handleWindowRestore(): void {
  if (document.hidden) return;
  scheduleMeasure();
}

/**
 * 窗口失焦：满 WORKER_SUSPEND_MS 后释放语言服务 worker（TypeScript 编译器
 * 每个窗口一份，后台窗口不该常驻）。期间焦点回来则取消挂起。
 */
function handleWindowBlur(): void {
  blurredAt = Date.now();
  clearTimeout(suspendTimer);
  suspendTimer = setTimeout(() => {
    suspendTimer = undefined;
    if (!shouldSuspendLanguageWorkers(document.hasFocus(), Date.now() - blurredAt)) return;
    languageWorkersSuspended = true;
    setLanguageWorkersSuspended(true);
  }, WORKER_SUSPEND_MS);
}

/** 窗口重新聚焦：只有真的挂起过才重启语言服务（避免每次聚焦都重建编译器） */
function handleWindowFocus(): void {
  clearTimeout(suspendTimer);
  suspendTimer = undefined;
  if (languageWorkersSuspended) {
    languageWorkersSuspended = false;
    setLanguageWorkersSuspended(false);
    const model = codeEditor?.getModel() ?? null;
    stopLanguageWorkersExcept(languageWorkerMode(model?.getLanguageId() ?? ""));
    // 挂起期间 worker 已销毁：重新校验当前 model，额外库保持原样（无需重读盘）
    pokeTypeScriptDiagnostics();
    if (model) void refreshVueDiagnostics(model);
  }
  scheduleMeasure();
}

onMounted(() => {
  void configureTypeScript(workspace.rootPath);
  registerHtmlCssProviders();
  registerEmmetProvider();
  registerJsonEnvProviders();
  installConflictResolver();
  installVueScriptDiagnostics();
  registerVueScriptCompletions();
  installExtraLibs({
    root: () => workspace.rootPath,
    activeModel: () => codeEditor?.getModel() ?? null,
  });
  registerUserSnippets({ root: () => workspace.rootPath });
  eslintController = installEslint({
    root: () => workspace.rootPath,
    enabled: () => settings.editor.eslintEnabled,
    onUnavailable: () => {
      workspace.showNotice("未检测到项目 ESLint，已停用 ESLint 校验", 3200);
    },
  });
  registerFormatProviders({
    root: () => workspace.rootPath,
    enabled: () => settings.editor.prettierEnabled,
    onError: (message) => workspace.showNotice(message, 3200),
  });
  createEditor();
  if (host.value) {
    host.value.addEventListener("wheel", onWheel, { capture: true, passive: false });
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => scheduleMeasure());
      resizeObserver.observe(host.value);
    }
  }
  void git.scheduleRefresh();
  window.addEventListener("focus", handleWindowRestore);
  document.addEventListener("visibilitychange", handleWindowRestore);
  window.addEventListener("blur", handleWindowBlur);
  window.addEventListener("focus", handleWindowFocus);
});

onBeforeUnmount(() => {
  window.removeEventListener("focus", handleWindowRestore);
  document.removeEventListener("visibilitychange", handleWindowRestore);
  window.removeEventListener("blur", handleWindowBlur);
  window.removeEventListener("focus", handleWindowFocus);
  clearTimeout(suspendTimer);
  suspendTimer = undefined;
  host.value?.removeEventListener("wheel", onWheel, { capture: true });
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (measureRaf !== null) {
    cancelAnimationFrame(measureRaf);
    measureRaf = null;
  }
  if (measureTimer !== null) {
    clearTimeout(measureTimer);
    measureTimer = null;
  }
  if (cursorRaf !== null) {
    cancelAnimationFrame(cursorRaf);
    cursorRaf = null;
  }
  disposeGitDecorations();
  breadcrumbController?.dispose();
  breadcrumbController = null;
  keymapController?.dispose();
  keymapController = null;
  ownCommands?.dispose();
  ownCommands = null;
  contentSub?.dispose();
  cursorSub?.dispose();
  contentSub = null;
  cursorSub = null;
  codeEditor?.dispose();
  codeEditor = null;
  for (const model of modelCache.values()) model.dispose();
  modelCache.clear();
  viewStateCache.clear();
});

watch(
  () => props.path,
  (path) => {
    switchDocument(path, props.content);
    void git.scheduleRefresh();
  },
);

watch(
  () => props.content,
  (next) => {
    const model = codeEditor?.getModel();
    if (!model) return;
    // 只有外部修改（syncFromDisk / formatDocument / renameSymbol 等）
    // 才标记 pendingExternalUpdate，用户输入不触发回环。
    if (!editorStore.consumeExternalUpdate(props.path)) return;
    if (next === model.getValue()) return;

    // 保留光标：按行号 + 列号重定位（格式化会改变行数，绝对 offset 会错位）
    const position = codeEditor?.getPosition();
    const selection = codeEditor?.getSelection();
    applyingExternal = true;
    try {
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text: next }],
        () => null,
      );
    } finally {
      applyingExternal = false;
    }
    if (position && codeEditor) {
      const lineNumber = Math.min(position.lineNumber, model.getLineCount());
      const column = Math.min(position.column, model.getLineMaxColumn(lineNumber));
      codeEditor.setPosition({ lineNumber, column });
      if (selection) {
        const anchorLine = Math.min(selection.selectionStartLineNumber, model.getLineCount());
        const anchorColumn = Math.min(
          selection.selectionStartColumn,
          model.getLineMaxColumn(anchorLine),
        );
        const nextSelection = new monaco.Selection(
          anchorLine,
          anchorColumn,
          lineNumber,
          column,
        );
        codeEditor.setSelection(nextSelection);
      }
    }
  },
);

watch(openAt, (target) => {
  if (!target || target.path !== props.path) return;
  scrollTo(target.line, target.column);
});

watch(themeName, (name) => {
  if (!name) return;
  monaco.editor.setTheme(name);
});

watch(
  () => [
    editorPrefs.value.fontSize,
    editorPrefs.value.fontFamily,
    editorPrefs.value.lineNumbers,
    editorPrefs.value.wordWrap,
    editorPrefs.value.tabSize,
    editorPrefs.value.stickyScroll,
    editorPrefs.value.minimap,
    editorPrefs.value.relativeLineNumbers,
    JSON.stringify(editorPrefs.value.rulers),
  ],
  () => {
    codeEditor?.updateOptions(prefsOptions());
    applyIndentOptions();
    scheduleMeasure();
  },
);

watch(blameVisible, (visible) => {
  blameController?.setVisible(visible);
});

watch(
  () => editorPrefs.value.keymap,
  (preset) => {
    keymapController?.dispose();
    keymapController = applyKeymapPreset(preset);
  },
);

watch(
  () => workspace.rootPath,
  async (root) => {
    await configureTypeScript(root);
    // 换项目后当前文件的 import 集合变了，重新注入额外库
    await refreshActiveExtraLibs(codeEditor?.getModel() ?? null);
    attachGitDecorations(currentPath);
  },
);

defineExpose({ scrollTo });
</script>

<template>
  <div class="editor-shell">
    <nav v-if="crumbs.length" class="breadcrumbs" :aria-label="t('editor.breadcrumbs')">
      <template v-for="(crumb, index) in crumbs" :key="`${index}-${crumb.offset}`">
        <span v-if="index > 0" class="separator">›</span>
        <button type="button" class="crumb" :title="crumb.name" @click="jumpToCrumb(crumb)">
          {{ crumb.name }}
        </button>
      </template>
    </nav>
    <div ref="host" class="monaco-host" />
  </div>
</template>

<style scoped>
.editor-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.monaco-host {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

/* ==================== 面包屑 ==================== */
.breadcrumbs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-panel);
  font-size: 11px;
  flex-shrink: 0;
  overflow: hidden;
  white-space: nowrap;
}

.breadcrumbs .crumb {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 4px;
  cursor: pointer;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.breadcrumbs .crumb:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.breadcrumbs .separator {
  color: var(--text-muted);
}

/* ==================== git 改动条 ==================== */
.monaco-host :deep(.prism-git-bg-added) {
  background-color: color-mix(in srgb, var(--accent) 10%, transparent);
}
.monaco-host :deep(.prism-git-bg-modified) {
  background-color: color-mix(in srgb, var(--accent) 10%, transparent);
}
.monaco-host :deep(.prism-git-bg-deleted) {
  background-color: color-mix(in srgb, var(--danger) 9%, transparent);
}

.monaco-host :deep(.prism-git-glyph) {
  width: 3px;
  margin-left: 3px;
  border-radius: 1px;
}
.monaco-host :deep(.prism-git-glyph-added) {
  background-color: #34d399;
}
.monaco-host :deep(.prism-git-glyph-modified) {
  background-color: #60a5fa;
}
.monaco-host :deep(.prism-git-glyph-deleted) {
  background: linear-gradient(180deg, #f87171 0 45%, transparent 45% 55%, #f87171 55% 100%);
}

/* ==================== blame 行尾常驻 ==================== */
.monaco-host :deep(.prism-blame-inline) {
  color: var(--text-muted);
  opacity: 0.72;
  font-size: 0.92em;
}

/* ==================== 跳转落点 ==================== */
.monaco-host :deep(.prism-jump-line) {
  background-color: color-mix(in srgb, var(--accent) 14%, transparent) !important;
  animation: prism-jump-line 1.6s var(--ease-out) both;
}
.monaco-host :deep(.prism-jump-target) {
  background-color: var(--accent) !important;
  color: var(--accent-fg) !important;
  border-radius: 3px;
}
.monaco-host :deep(.prism-jump-gutter) {
  color: var(--accent) !important;
  font-weight: 700;
}

@keyframes prism-jump-line {
  0% {
    background-color: color-mix(in srgb, var(--accent) 27%, transparent);
  }
  100% {
    background-color: color-mix(in srgb, var(--accent) 14%, transparent);
  }
}

@media (prefers-reduced-motion: reduce) {
  .monaco-host :deep(.prism-jump-line) {
    animation: none;
  }
}
</style>
