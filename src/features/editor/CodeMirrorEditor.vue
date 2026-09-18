<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  closeBrackets,
} from "@codemirror/autocomplete";
import { history } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
} from "@codemirror/language";
import { lintGutter } from "@codemirror/lint";
import { highlightSelectionMatches, search } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { storeToRefs } from "pinia";
import { createCompletionExtension } from "@/features/editor/completions";
import { expandEmmetAt, matchEmmetAbbreviation } from "@/features/editor/completion/emmet";
import { createDiagnosticsExtension } from "@/features/editor/diagnostics";
import { getEditorFontFamily } from "@/features/editor/fonts";
import { createEditorKeymap } from "@/features/editor/keymap";
import {
  createJumpHighlightTarget,
  jumpHighlightExtension,
  setJumpHighlightEffect,
} from "@/features/editor/jumpHighlight";
import { languageExtensionForPath } from "@/features/editor/languages";
import { createNavigationExtension } from "@/features/editor/navigation";
import { editorThemeExtensions } from "@/features/editor/theme";
import { createPrismFindPanel, openFindPanel, openFindReplacePanel } from "@/features/editor/findPanel";
import { formatDocumentContent } from "@/features/editor/formatting";
import { singleTextChange } from "@/features/editor/formatting/textChange";
import { wordAt } from "@/features/editor/documentSymbols";
import { renameSymbol } from "@/features/editor/renameSymbol";
import { createTypeScriptHoverExtension } from "@/features/editor/typeService/tsHover";
import { promptInput } from "@/shared/promptDialog";
import { gitChangesExtension } from "@/features/editor/gitChanges";
import { gitBlameExtension } from "@/features/editor/gitBlame";
import { relativeToRoot } from "@/shared/fs";
import { useEditorStore } from "@/stores/editor";
import { useGitStore } from "@/stores/git";
import { useSettingsStore } from "@/stores/settings";
import { useSearchStore } from "@/stores/search";
import { useWorkspaceStore } from "@/stores/workspace";

const props = defineProps<{
  path: string;
  content: string;
}>();

const host = ref<HTMLDivElement | null>(null);
const editorStore = useEditorStore();
const settings = useSettingsStore();
const searchStore = useSearchStore();
const workspace = useWorkspaceStore();
const git = useGitStore();
const { theme, editor } = storeToRefs(settings);
const { openAt, findRequest, blameVisible } = storeToRefs(editorStore);
const { snapshot: gitSnapshot } = storeToRefs(git);
const editorFontFamily = computed(() => getEditorFontFamily(editor.value.fontFamily));

let view: EditorView | null = null;
const themeComp = new Compartment();
const langComp = new Compartment();
const prefsComp = new Compartment();
const gitComp = new Compartment();
let applyingExternal = false;
let resizeObserver: ResizeObserver | null = null;
let measureRaf: number | null = null;
let jumpHighlightTimer: ReturnType<typeof setTimeout> | null = null;
const JUMP_HIGHLIGHT_DURATION = 1800;

/**
 * 编辑器可能在 Transition、底部终端面板或窗口恢复尚未完成布局时创建。
 * CodeMirror 首次测量若拿到 0 高度，后续不会因为父级布局变化自动恢复绘制，
 * 最终表现为「标签和状态栏都在，但编辑区空白」。用 ResizeObserver 监听真实
 * 容器尺寸，并合并到下一帧重新测量，避免启动恢复/拖拽面板时留下空白编辑器。
 * rAF 之外再加 setTimeout 兜底：WKWebView 长时间空闲后恢复绘制时可能丢弃
 * rAF 回调（WebKit resumePainting 时序缺陷），定时器恢复后必然执行。
 */
let measureTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleEditorMeasure(): void {
  if (!view || measureRaf !== null || measureTimer !== null) return;
  const run = () => {
    if (measureRaf !== null) cancelAnimationFrame(measureRaf);
    measureRaf = null;
    if (measureTimer !== null) clearTimeout(measureTimer);
    measureTimer = null;
    if (!view || !host.value?.isConnected) return;
    view.requestMeasure();
  };
  measureRaf = requestAnimationFrame(run);
  measureTimer = setTimeout(run, 150);
}

const navHandlers = {
  onNavigate: (path: string, line: number, column: number) => {
    void editorStore.openFileAt(path, line, column);
  },
  onGoBack: () => {
    const target = editorStore.takeJumpBack();
    if (!target) return false;
    void editorStore.openFileAt(target.path, target.line, target.column, {
      recordHistory: false,
    });
    return true;
  },
  onGoForward: () => {
    const target = editorStore.takeJumpForward();
    if (!target) return false;
    void editorStore.openFileAt(target.path, target.line, target.column, {
      recordHistory: false,
    });
    return true;
  },
  workspaceRoot: () => workspace.rootPath,
  currentFile: () => props.path,
};

function buildPrefs() {
  const exts = [
    EditorState.tabSize.of(editor.value.tabSize),
    // 特异性必须高于 uiTheme 的 `& { fontSize: inherit }`（theme.ts:207）：
    // 两者同为单类选择器时按注入顺序后者胜出，inherit 会覆盖这里的字号，
    // 导致 fontSize 任何改动（滚轮/设置面板）在 DOM 上都不生效（恒为继承的 13px）。
    // `&.cm-editor` 展开为 `.ͼN.cm-editor`（双类），特异性更高，必然胜出。
    EditorView.theme({
      "&.cm-editor": { fontSize: `${editor.value.fontSize}px` },
    }),
  ];
  if (editor.value.lineNumbers) {
    exts.push(lineNumbers(), highlightActiveLineGutter());
  }
  if (editor.value.wordWrap) {
    exts.push(EditorView.lineWrapping);
  }
  return exts;
}

// 光标写入节流：同一帧内多次 selectionSet/docChanged 合并为一次 store 写入
// （状态栏行/列显示允许 16ms 延迟，消除每键重复触发 Pinia 响应式）
let cursorRaf: number | null = null;
let pendingCursorPath = "";
let pendingCursorLine = 0;
let pendingCursorColumn = 0;
function emitCursor(current: EditorView) {
  const head = current.state.selection.main.head;
  const line = current.state.doc.lineAt(head);
  // 捕获触发时刻的路径：帧末回调执行时可能已切换标签（输入后立即点击），
  // 不得把上一标签的光标/状态栏行列写进新标签。
  pendingCursorPath = props.path;
  // 帧内不断用最新值覆盖，帧末统一写一次
  pendingCursorLine = line.number;
  pendingCursorColumn = head - line.from + 1;
  if (cursorRaf !== null) return;
  cursorRaf = requestAnimationFrame(() => {
    cursorRaf = null;
    editorStore.setCursor(
      pendingCursorPath,
      pendingCursorLine,
      pendingCursorColumn,
    );
  });
}

function scrollTo(line: number, column: number) {
  if (!view) return;
  const clampedLine = Math.max(1, Math.min(line, view.state.doc.lines));
  const lineObj = view.state.doc.line(clampedLine);
  const col = Math.max(1, column);
  const pos = lineObj.from + Math.min(col - 1, lineObj.length);
  const highlightTarget = createJumpHighlightTarget(view.state.doc, pos);
  view.dispatch({
    selection: { anchor: pos },
    effects: [
      EditorView.scrollIntoView(pos, { y: "center" }),
      setJumpHighlightEffect.of(highlightTarget),
    ],
  });
  view.focus();
  emitCursor(view);
  if (jumpHighlightTimer !== null) clearTimeout(jumpHighlightTimer);
  jumpHighlightTimer = setTimeout(() => {
    jumpHighlightTimer = null;
    if (view) view.dispatch({ effects: setJumpHighlightEffect.of(null) });
  }, JUMP_HIGHLIGHT_DURATION);
}

/** 字体大小调节：10-24；wheel deltaY 归一化到「格」浮点累积（一格≈100px），
 *  每满 1 格调 1px。浮点累积适配 deltaY 单位差异：标准鼠标一格 100 正好 1 步，
 *  精细设备（触控板/部分驱动每事件仅 ±1~±20）多滚几下也能触发，快速滚动不丢步。
 *  方向：上推（deltaY<0）调小、下推调大（用户约定，与 macOS 自然滚动直觉一致）。 */
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 24;
const WHEEL_STEP_DELTA = 100;
let fontWheelAcc = 0;

function adjustFontSize(delta: number) {
  const cur = settings.editor.fontSize;
  const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, cur + delta));
  if (next === cur) return;
  settings.patchEditor({ fontSize: next });
}

/** ⌘/Ctrl + 滚轮调字号：上推调小、下推调大 */
function wheelFontSize(event: WheelEvent): boolean {
  if (!(event.metaKey || event.ctrlKey)) return false;
  event.preventDefault();
  // deltaMode 归一化：0=像素（触控板/主流鼠标）、1=行、2=页，统一换算成像素再累积
  const delta =
    event.deltaMode === 1 ? event.deltaY * 40 : event.deltaMode === 2 ? event.deltaY * 100 : event.deltaY;
  fontWheelAcc += delta / WHEEL_STEP_DELTA;
  const steps = Math.trunc(fontWheelAcc);
  if (steps === 0) return true;
  fontWheelAcc -= steps;
  adjustFontSize(steps);
  return true;
}

/** 行内 git 扩展：改动条（始终）+ blame（hover 悬浮始终、常驻列可开关） */
function buildGitExtensions(path: string): Extension[] {
  const root = workspace.rootPath;
  if (!root) return [];
  const relPath = relativeToRoot(root, path);
  const exts: Extension[] = [
    gitChangesExtension({
      root,
      relPath,
      openDiff: () => {
        void git.showDiff(relPath, false);
      },
    }),
    gitBlameExtension({
      root,
      relPath,
      showGutter: blameVisible.value,
    }),
  ];
  return exts;
}

/** ⌘K ⌘F：只格式化单一连续选区；实际修改仍走 CM 历史。 */
async function formatSelection(current: EditorView): Promise<void> {
  const selection = current.state.selection;
  if (selection.ranges.length !== 1 || selection.main.empty) return;

  const root = workspace.rootPath;
  if (!root) return;
  if (!settings.editor.prettierEnabled) {
    workspace.showNotice("请先在设置中启用代码格式化");
    return;
  }

  const path = props.path;
  const before = current.state.doc.toString();
  const range = selection.main;
  try {
    const formatted = await formatDocumentContent(root, path, before, {
      rangeStart: range.from,
      rangeEnd: range.to,
    });

    // 格式化期间若用户继续输入、切换标签或销毁视图，丢弃过期结果。
    if (
      view !== current ||
      currentPath !== path ||
      current.state.doc.toString() !== before
    ) {
      return;
    }

    const change = singleTextChange(before, formatted, {
      from: range.from,
      to: range.to,
    });
    if (!change) return;
    current.dispatch({
      changes: change,
      userEvent: "input.format.selection",
    });
  } catch (error) {
    workspace.showNotice(
      error instanceof Error ? error.message : String(error),
      3200,
    );
  }
}

/** 构建编辑器扩展集（按当前 props.path / 设置；标签切换时按需重建） */
function buildExtensions(): Extension[] {
  return [
    highlightSpecialChars(),
    history(),
    foldGutter(),
    lintGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    createCompletionExtension(props.path),
    createTypeScriptHoverExtension(props.path),
    ...createDiagnosticsExtension(props.path),
    createNavigationExtension(navHandlers),
    // 勿用 domEventHandlers 处理 contextmenu：
    // main.ts 已在捕获阶段 preventDefault，CM 会跳过 defaultPrevented 的 handler，导致右键菜单失效。
    // 父级 @contextmenu 通过 Vue 透传到本组件根节点即可。
    // ⌘/Ctrl + 滚轮调字号（VS Code 行为）；只拦截带修饰键的滚轮，其他滚轮照旧滚动。
    EditorView.domEventHandlers({
      wheel: (event) => wheelFontSize(event),
      mousedown(event, view) {
        if (event.button !== 0 || view.hasFocus) return false;
        if (!(event.target instanceof Node) || !view.contentDOM.contains(event.target)) return false;
        // WKWebView 的 UA 不含 Version/26，无法命中 CM 的 Safari 26
        // preventScroll 兼容分支。先同步聚焦并恢复视口，再让 CM 根据原始
        // 点击坐标处理单击、双击和拖选，避免聚焦滚动把起止点映射到不同区域。
        const { scrollTop, scrollLeft } = view.scrollDOM;
        view.focus();
        view.scrollDOM.scrollTop = scrollTop;
        view.scrollDOM.scrollLeft = scrollLeft;
        return false;
      },
    }),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    jumpHighlightExtension,
    highlightSelectionMatches(),
    // VS Code 风格查找面板：自研 PrismFindPanel（右上角悬浮、查找/替换两行、
    // 上下箭头、Aa/.*/Ab 切换、结果计数、⌘F/⌘H/⌘G/Esc/F3 等快捷键）。
    // openFindPanel/openFindReplacePanel 已用 requestAnimationFrame 修复
    // panelByView 时序问题（openSearchPanel 后下一帧才 mount 注册）。
    search({ top: true, createPanel: createPrismFindPanel }),
    createEditorKeymap({
      navigation: navHandlers,
      onRename: (v) => {
        const root = workspace.rootPath;
        if (!root) {
          workspace.showNotice("未打开工作区", 2000);
          return;
        }
        // Tauri WKWebView 不支持 window.prompt，使用应用内输入框。
        const current =
          wordAt(v.state.doc.toString(), v.state.selection.main.head)?.word ?? "";
        void promptInput({
          title: "重命名符号",
          label: "新名称",
          defaultValue: current,
          confirmText: "重命名",
        }).then((newName) => {
          if (!newName || view !== v) return;
          void renameSymbol(v, newName, root, props.path);
        });
      },
      onReferences: (v) => {
        void editorStore.openReferences(
          props.path,
          v.state.doc.toString(),
          v.state.selection.main.head,
        );
      },
      onOpenFind: openFindPanel,
      onOpenReplace: openFindReplacePanel,
      onOpenRecentFiles: () => searchStore.openQuickOpen(),
      onFormatDocument: () => {
        void editorStore.formatDocument();
      },
      onFormatSelection: (v) => {
        void formatSelection(v);
      },
      // Emmet 缩写展开在普通 Tab 缩进之前消费，仅 html/css/vue 启用。
      onEmmet: (v) => {
        if (!/\.(html?|vue|css|scss|sass|less)$/i.test(props.path)) return false;
        const head = v.state.selection.main.head;
        const before = v.state.doc.sliceString(0, head);
        if (!matchEmmetAbbreviation(before)) return false;
        void expandEmmetAt(v, props.path);
        return true;
      },
    }),
    langComp.of([]),
    gitComp.of(buildGitExtensions(props.path)),
    themeComp.of(editorThemeExtensions(theme.value)),
    prefsComp.of(buildPrefs()),
    EditorView.updateListener.of((update) => {
      if (!view) return;
      if (update.docChanged && !applyingExternal) {
        editorStore.setContent(props.path, update.state.doc.toString());
      }
      if (update.selectionSet || update.docChanged) {
        emitCursor(view);
      }
    }),
  ];
}

// ==================== 标签切换：保留实例换文档 ====================
// 切标签不再销毁重建 EditorView（重建 = 整文档二次 parse + DOM 重排 +
// 丢失撤销历史/折叠/滚动），改为按 path 缓存 EditorState（含 doc / 撤销
// 历史 / 折叠 / 选区），切换时 view.setState 换入；滚动位置单独存取。
// 缓存随标签关闭裁剪（上限 = 打开标签数）。
interface CachedEditorState {
  state: EditorState;
  scrollTop: number;
}
const stateCache = new Map<string, CachedEditorState>();
let currentPath = "";

function pruneStateCache(): void {
  const open = new Set(editorStore.tabs.map((t) => t.path));
  for (const key of stateCache.keys()) {
    if (!open.has(key)) stateCache.delete(key);
  }
}

/** 语言解析器按需动态加载：resolve 后 reconfigure 补齐（已切换/销毁则丢弃） */
function loadLanguage(path: string): void {
  void languageExtensionForPath(path).then((lang) => {
    if (!view || currentPath !== path) return;
    view.dispatch({ effects: langComp.reconfigure(lang ?? []) });
  });
}

function switchDocument(path: string, content: string): void {
  if (!view) return;
  if (jumpHighlightTimer !== null) {
    clearTimeout(jumpHighlightTimer);
    jumpHighlightTimer = null;
  }
  view.dispatch({ effects: setJumpHighlightEffect.of(null) });
  // 1. 保存当前标签状态（撤销历史/折叠/选区）与滚动位置
  if (currentPath) {
    stateCache.set(currentPath, {
      state: view.state,
      scrollTop: view.scrollDOM.scrollTop,
    });
  }
  currentPath = path;
  pruneStateCache();

  // 2. 命中缓存且内容未变：整状态换入（瞬时、无二次 parse、历史/折叠保留）
  const cached = stateCache.get(path);
  if (cached && cached.state.doc.toString() === content) {
    view.setState(cached.state);
    const scrollTop = cached.scrollTop;
    requestAnimationFrame(() => {
      if (view) view.scrollDOM.scrollTop = scrollTop;
    });
  } else {
    // 3. 未命中 / 内容被外部修改：按当前内容重建状态（历史从空开始）
    stateCache.delete(path);
    view.setState(
      EditorState.create({ doc: content, extensions: buildExtensions() }),
    );
    loadLanguage(path);
  }

  // 4. 主题与编辑偏好以当前设置为准（缓存状态可能携带旧配置）。
  view.dispatch({
    effects: [
      themeComp.reconfigure(editorThemeExtensions(theme.value)),
      prefsComp.reconfigure(buildPrefs()),
      gitComp.reconfigure(buildGitExtensions(path)),
    ],
  });
  emitCursor(view);
  scheduleEditorMeasure();
}

function createEditor() {
  if (!host.value) return;

  currentPath = props.path;
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.content,
      extensions: buildExtensions(),
    }),
  });
  loadLanguage(props.path);
  emitCursor(view);
  scheduleEditorMeasure();
}

/** 窗口恢复（空闲后被遮挡/最小化再回到前台）时强制重测。
 *  WKWebView 长时间空闲后恢复绘制时可能丢掉 rAF/测量循环，
 *  表现为「标签已打开但编辑区空白/黑屏」；focus 与 visibilitychange
 *  必然伴随用户回到窗口，此时补一次 requestMeasure 兜底。 */
function handleWindowRestore(): void {
  if (document.hidden) return;
  scheduleEditorMeasure();
}

onMounted(() => {
  createEditor();
  if (host.value && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
      scheduleEditorMeasure();
    });
    resizeObserver.observe(host.value);
  }
  // 编辑器首次挂载时拉一次 git status，避免刚打开文件右键看不到 git 菜单
  void git.scheduleRefresh();
  window.addEventListener("focus", handleWindowRestore);
  document.addEventListener("visibilitychange", handleWindowRestore);
});

onBeforeUnmount(() => {
  window.removeEventListener("focus", handleWindowRestore);
  document.removeEventListener("visibilitychange", handleWindowRestore);
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
  if (jumpHighlightTimer !== null) {
    clearTimeout(jumpHighlightTimer);
    jumpHighlightTimer = null;
  }
  view?.destroy();
  view = null;
});

watch(
  () => props.path,
  (newPath) => {
    // 保留实例换文档：不销毁重建 EditorView，状态（撤销历史/折叠/选区）
    // 按 path 缓存换入，滚动位置单独恢复
    switchDocument(newPath, props.content);
    // 切换文件后立刻拉一次 git status，避免刚切换就右键时 statusMap 暂空
    // 看不到「显示 Diff / 回滚变更」菜单项。
    void git.scheduleRefresh();
  },
);

watch(
  () => props.content,
  (next) => {
    if (!view) return;
    // 断环核心：只有外部修改（syncFromDisk / reloadAfterDiscard /
    // formatDocument / renameSymbol 等）才标记了 pendingExternalUpdate，
    // 此时把新内容 dispatch 进 CM。用户输入触发的 setContent 不标记，
    // watcher 直接 return，彻底切断 CM -> store -> prop -> CM 回环。
    if (!editorStore.consumeExternalUpdate(props.path)) return;
    const current = view.state.doc.toString();
    if (next === current) return;

    // 保留光标位置：记录 dispatch 前的行号+列号，dispatch 后按行号重新定位。
    // 不能用绝对 offset（格式化/外部修改可能改变行数和缩进，offset 会错位）。
    // 用「行号不变、列号取 min(原列, 当前行长度)」策略，对格式化场景足够稳健。
    const sel = view.state.selection.main;
    const headLine = view.state.doc.lineAt(sel.head);
    const savedLine = headLine.number;
    const savedCol = sel.head - headLine.from;
    const anchorLine = view.state.doc.lineAt(sel.anchor);
    const savedAnchorLine = anchorLine.number;
    const savedAnchorCol = sel.anchor - anchorLine.from;

    applyingExternal = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
        userEvent: "input.external",
      });
    } finally {
      applyingExternal = false;
    }

    // dispatch 后按行号+列号重新定位光标
    const newDoc = view.state.doc;
    const newLineCount = newDoc.lines;
    const targetLine = Math.min(savedLine, newLineCount);
    const newLineObj = newDoc.line(targetLine);
    const targetHead = newLineObj.from + Math.min(savedCol, newLineObj.length);

    const targetAnchorLine = Math.min(savedAnchorLine, newLineCount);
    const newAnchorLineObj = newDoc.line(targetAnchorLine);
    const targetAnchor =
      newAnchorLineObj.from + Math.min(savedAnchorCol, newAnchorLineObj.length);

    view.dispatch({
      selection: { anchor: targetAnchor, head: targetHead },
      scrollIntoView: false,
    });
  },
);

watch(openAt, (target) => {
  if (!target || target.path !== props.path) return;
  scrollTo(target.line, target.column);
});

// 原生菜单 ⌘F -> store 信号 -> 打开查找面板（macOS 键盘事件被原生层占用时的兜底路由）
watch(findRequest, (req) => {
  if (!req || !view || req.path !== props.path) return;
  openFindPanel(view);
});

watch(theme, (next) => {
  view?.dispatch({
    effects: themeComp.reconfigure(editorThemeExtensions(next)),
  });
});

watch(
  editor,
  () => {
    view?.dispatch({
      effects: prefsComp.reconfigure(buildPrefs()),
    });
  },
  { deep: true },
);

// 行内 blame 常驻列开关热更新（gitComp reconfigure）
watch(blameVisible, () => {
  view?.dispatch({
    effects: gitComp.reconfigure(buildGitExtensions(props.path)),
  });
});

// HEAD 提交变化（commit / checkout / reset 后）时重载改动条与 blame，
// 否则相对 HEAD 的逐行 diff 与 blame 会停留在旧提交，需重开标签才更新。
watch(
  () => gitSnapshot.value.head,
  () => {
    view?.dispatch({
      effects: gitComp.reconfigure(buildGitExtensions(props.path)),
    });
  },
);

defineExpose({ scrollTo });
</script>

<template>
  <div class="editor-shell">
    <div
      ref="host"
      class="cm-host"
      :style="{ '--prism-editor-font-family': editorFontFamily }"
    />
  </div>
</template>

<style scoped>
.editor-shell {
  display: flex;
  height: 100%;
  width: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.cm-host {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  width: auto;
  overflow: hidden;
  font-family: var(--prism-editor-font-family, var(--font-mono, ui-monospace, monospace));
}

.cm-host :deep(.cm-editor) {
  height: 100%;
}

.cm-host :deep(.cm-editor.cm-focused) {
  outline: none;
}

.cm-host :deep(.cm-tooltip-autocomplete) {
  border: 1px solid var(--border-subtle) !important;
  background: var(--bg-elevated) !important;
  box-shadow: var(--shadow-modal);
  border-radius: 10px;
  overflow: hidden;
}

.cm-host :deep(.cm-tooltip-autocomplete > ul) {
  font-family: inherit;
  max-height: 280px;
}

.cm-host :deep(.cm-tooltip-autocomplete > ul > li) {
  padding: 4px 10px;
  line-height: 1.45;
}

.cm-host :deep(.cm-tooltip-autocomplete > ul > li[aria-selected]) {
  background: var(--accent-soft) !important;
  color: var(--accent) !important;
}

.cm-host :deep(.cm-completionLabel) {
  color: var(--text-primary);
}

.cm-host :deep(.cm-completionDetail) {
  color: var(--text-muted);
  font-style: normal;
  margin-left: 8px;
}

.cm-host :deep(.cm-completionIcon) {
  opacity: 0.7;
}

.cm-host :deep(.prism-hover-info) {
  max-width: 560px;
  padding: 2px 0;
  color: var(--text-primary);
  font-size: 12px;
  line-height: 1.5;
}

.cm-host :deep(.prism-hover-signature) {
  padding: 3px 10px 5px;
  color: var(--accent);
  font-family: var(--prism-editor-font-family, var(--font-mono, ui-monospace, monospace));
  white-space: pre-wrap;
}

.cm-host :deep(.prism-hover-doc) {
  max-width: 520px;
  padding: 5px 10px 3px;
  border-top: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  white-space: pre-wrap;
}

/* ===== 签名帮助（VS Code 风格） ===== */
.cm-host :deep(.prism-signature-help) {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-primary);
  max-width: 520px;
  padding: 2px 0;
}
.cm-host :deep(.prism-signature-line) {
  padding: 2px 10px;
}
.cm-host :deep(.prism-signature-line.active) {
  background: color-mix(in srgb, var(--accent-soft) 55%, transparent);
  border-radius: 6px;
}
.cm-host :deep(.prism-signature-label) {
  font-family: var(--prism-editor-font-family, var(--font-mono, ui-monospace, monospace));
  font-size: 11.5px;
  word-break: break-all;
}
.cm-host :deep(.prism-signature-param) {
  color: var(--accent);
  font-weight: 600;
  margin-top: 2px;
  font-family: var(--prism-editor-font-family, var(--font-mono, ui-monospace, monospace));
  font-size: 11.5px;
}
.cm-host :deep(.prism-signature-doc) {
  color: var(--text-muted);
  margin-top: 2px;
  font-size: 11px;
}

/* ===== 补全项文档（markdown 渲染，VS Code 风格） ===== */
.cm-host :deep(.prism-completion-doc) {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
  max-width: 480px;
  max-height: 280px;
  overflow-y: auto;
}
.cm-host :deep(.prism-completion-doc p) {
  margin: 4px 0;
}
.cm-host :deep(.prism-completion-doc h1),
.cm-host :deep(.prism-completion-doc h2),
.cm-host :deep(.prism-completion-doc h3) {
  margin: 6px 0 4px;
  font-size: 13px;
  color: var(--text-primary);
}
.cm-host :deep(.prism-completion-doc code) {
  background: color-mix(in srgb, var(--text-secondary) 14%, transparent);
  border-radius: 3px;
  padding: 0 4px;
  font-size: 11px;
}
.cm-host :deep(.prism-completion-doc pre) {
  background: color-mix(in srgb, var(--text-secondary) 10%, transparent);
  padding: 8px;
  border-radius: 6px;
  overflow-x: auto;
  margin: 4px 0;
}
.cm-host :deep(.prism-completion-doc a) {
  color: var(--accent);
}
.cm-host :deep(.prism-completion-doc ul),
.cm-host :deep(.prism-completion-doc ol) {
  padding-left: 18px;
  margin: 4px 0;
}

/* ===== CSS 颜色 swatch（VS Code 色块预览） ===== */
.cm-host :deep(.prism-completion-color) {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cm-host :deep(.prism-completion-color-swatch) {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  border: 1px solid color-mix(in srgb, var(--text-secondary) 40%, transparent);
  display: inline-block;
  flex: 0 0 auto;
}
.cm-host :deep(.prism-completion-color-desc) {
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 11px;
}

/* 文件内查找：VS Code 风格右上角悬浮（CM 内置 .cm-panels-top 容器） */
.cm-host :deep(.cm-panels-top) {
  position: absolute;
  inset: 0 0 auto 0;
  z-index: 12;
  pointer-events: none;
}

.cm-host :deep(.cm-panels-top .cm-panel) {
  pointer-events: auto;
}

.cm-host :deep(.prism-find-panel) {
  position: absolute;
  top: 10px;
  right: 14px;
  width: min(520px, calc(100% - 28px));
  padding: 6px 8px;
  border-radius: 10px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 查找行与替换行：水平 flex、元素居中（f1ed485 动效改造时误删了 .prism-find-row，
   导致按钮失去 flex 逐行堆叠、面板被撑大，此处恢复公共布局） */
.cm-host :deep(.prism-find-row),
.cm-host :deep(.prism-find-replace-row) {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

/* 替换行：用 max-height + opacity 过渡实现折叠/展开（不依赖 display:none 硬切） */
.cm-host :deep(.prism-find-replace-row) {
  max-height: 60px;
  opacity: 1;
  overflow: hidden;
  transition: max-height var(--transition-medium) var(--ease-out),
    opacity var(--transition-fast) var(--ease-out),
    margin var(--transition-medium) var(--ease-out);
}
.cm-host :deep(.prism-find-replace-row.is-collapsed) {
  max-height: 0;
  opacity: 0;
  margin-top: -6px;
  pointer-events: none;
}

.cm-host :deep(.prism-find-spacer) {
  width: 24px;
  flex-shrink: 0;
}

.cm-host :deep(.prism-find-input) {
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-app);
  color: var(--text-primary);
  font-size: 12px;
}

.cm-host :deep(.prism-find-input:focus) {
  outline: none;
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border-subtle));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-soft) 70%, transparent);
}

.cm-host :deep(.prism-find-count) {
  flex: 0 0 auto;
  min-width: 52px;
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
  white-space: nowrap;
}

.cm-host :deep(.prism-find-btn) {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1;
  display: grid;
  place-items: center;
}

.cm-host :deep(.prism-find-btn:hover) {
  background: var(--accent-soft);
  color: var(--text-primary);
}

.cm-host :deep(.prism-find-btn.active) {
  background: var(--accent-soft);
  color: var(--accent);
}

.cm-host :deep(.prism-find-btn.toggle-replace) {
  width: 24px;
  font-size: 10px;
}

.cm-host :deep(.prism-find-toggle) {
  font-size: 11px;
  font-weight: 600;
}

.cm-host :deep(.prism-find-replace-actions) {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.cm-host :deep(.prism-find-text-btn) {
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--border-subtle);
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  white-space: nowrap;
}

.cm-host :deep(.prism-find-text-btn:hover) {
  background: var(--accent-soft);
  color: var(--text-primary);
}

/* 查找匹配弱于当前选中匹配；选区本身由 theme.selection 控制且应最亮 */
.cm-host :deep(.cm-selectionMatch) {
  background-color: color-mix(in srgb, var(--accent) 16%, transparent) !important;
  border-radius: 2px;
}

.cm-host :deep(.cm-searchMatch) {
  background: color-mix(in srgb, var(--accent) 22%, transparent) !important;
  border-radius: 2px;
}

.cm-host :deep(.cm-searchMatch-selected) {
  background: color-mix(in srgb, var(--accent) 55%, transparent) !important;
  outline: 1px solid color-mix(in srgb, var(--accent) 70%, transparent);
  /* 选中态从一个匹配跳到另一个时给 0.3s 缓动，避免硬切 */
  transition: background var(--transition-fast) var(--ease-out),
    outline-color var(--transition-fast) var(--ease-out);
}

/* ===== 弹层 enter 动画（CM6 仅提供 enter 钩子，leave 即时移除） ===== */
.cm-host :deep(.cm-tooltip-autocomplete) {
  transform-origin: var(--ease-out, 50% 0%);
  animation: prism-tooltip-in var(--transition-medium) var(--ease-out) both;
}

/* completions 选项：箭头键切换时背景平滑 */
.cm-host :deep(.cm-tooltip-autocomplete > ul > li) {
  transition: background var(--transition-fast) var(--ease-out),
    color var(--transition-fast) var(--ease-out);
}

/* find panel 容器 popover 入场 */
.cm-host :deep(.prism-find-panel) {
  transform-origin: top right;
  animation: prism-popover-in var(--transition-medium) var(--ease-out) both;
}

/* find panel 按钮：active/hover 平滑 */
.cm-host :deep(.prism-find-btn) {
  transition: background var(--transition-fast) var(--ease-out),
    color var(--transition-fast) var(--ease-out);
}
.cm-host :deep(.prism-find-text-btn) {
  transition: background var(--transition-fast) var(--ease-out),
    color var(--transition-fast) var(--ease-out),
    border-color var(--transition-fast) var(--ease-out);
}

/* find panel 输入：focus 缓动 */
.cm-host :deep(.prism-find-input) {
  transition: border-color var(--transition-fast) var(--ease-out),
    box-shadow var(--transition-fast) var(--ease-out);
}

/* 匹配数翻牌：scale 0.92 → 1，0.3s 反弹 */
.cm-host :deep(.prism-find-count) {
  display: inline-block;
  transition: color var(--transition-fast) var(--ease-out);
}
.cm-host :deep(.prism-find-count.bump) {
  animation: prism-count-bump 0.32s var(--ease-out);
}
@keyframes prism-count-bump {
  0% {
    transform: scale(0.92);
    opacity: 0.4;
  }
  60% {
    transform: scale(1.06);
    opacity: 1;
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}

/* ===== 代码区反馈过渡 ===== */
.cm-host :deep(.cm-activeLine),
.cm-host :deep(.cm-activeLineGutter) {
  transition: background-color var(--transition-fast) var(--ease-out);
}

/* ===== 跳转落点反馈 ===== */
.cm-host :deep(.cm-prism-jump-line) {
  background-color: color-mix(in srgb, var(--accent) 14%, transparent) !important;
  box-shadow:
    inset 3px 0 0 var(--accent),
    inset 0 1px 0 color-mix(in srgb, var(--accent) 32%, transparent),
    inset 0 -1px 0 color-mix(in srgb, var(--accent) 32%, transparent);
  animation: prism-jump-line 1.6s var(--ease-out) both;
}

.cm-host :deep(.cm-prism-jump-target) {
  background-color: var(--accent) !important;
  color: var(--accent-fg) !important;
  border-radius: 3px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 28%, transparent);
  animation: prism-jump-target 1.4s var(--ease-out) both;
}

.cm-host :deep(.cm-prism-jump-gutter) {
  background-color: color-mix(in srgb, var(--accent) 18%, transparent) !important;
  box-shadow: inset 3px 0 0 var(--accent);
}

.cm-host :deep(.cm-lineNumbers .cm-prism-jump-gutter) {
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

@keyframes prism-jump-target {
  0% {
    box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 46%, transparent),
      0 0 16px color-mix(in srgb, var(--accent) 36%, transparent);
  }
  100% {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 28%, transparent);
  }
}

@media (prefers-reduced-motion: reduce) {
  .cm-host :deep(.cm-prism-jump-line),
  .cm-host :deep(.cm-prism-jump-target) {
    animation: none;
  }
}

.cm-host :deep(.cm-selectionMatch) {
  transition: background-color var(--transition-fast) var(--ease-out);
}
.cm-host :deep(.cm-searchMatch) {
  transition: background-color var(--transition-fast) var(--ease-out);
}

/* bracket match 短 pulse：0.3s 一次性高亮（依赖动效，需要在 theme.ts 注入临时 class） */
.cm-host :deep(.cm-matchingBracket) {
  transition: background-color var(--transition-fast) var(--ease-out),
    box-shadow var(--transition-fast) var(--ease-out);
  border-radius: 2px;
}
.cm-host :deep(.cm-matchingBracket.prism-bracket-pulse) {
  animation: prism-bracket-pulse 0.32s var(--ease-out);
}
@keyframes prism-bracket-pulse {
  0% {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 35%, transparent);
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}

/* lint 雪佛龙下划线：出现时淡入（lintGutter 注入的 marker） */
.cm-host :deep(.cm-lintRange-error),
.cm-host :deep(.cm-lintRange-warning) {
  animation: prism-lint-in 0.4s var(--ease-out) both;
}
@keyframes prism-lint-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* ghost text：出现时 0.2s 淡入 */
.cm-host :deep(.cm-ghost-text) {
  opacity: 0.4;
  font-style: italic;
  white-space: pre-wrap;
  color: var(--text-muted);
  animation: prism-ghost-in 0.22s var(--ease-out) both;
}
.cm-host :deep(.cm-ghost-text.just-accepted) {
  animation: prism-ghost-accepted 0.28s var(--ease-out) both;
}
.cm-host :deep(.cm-ghost-text.just-dismissed) {
  animation: prism-ghost-dismissed 0.22s var(--ease-out) both;
}
@keyframes prism-ghost-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 0.4;
  }
}
@keyframes prism-ghost-accepted {
  0% {
    opacity: 0.4;
  }
  40% {
    opacity: 0.85;
    color: var(--accent);
  }
  100% {
    opacity: 0;
  }
}
@keyframes prism-ghost-dismissed {
  from {
    opacity: 0.4;
  }
  to {
    opacity: 0;
  }
}
</style>
