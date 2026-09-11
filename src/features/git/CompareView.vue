<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { MergeView } from "@codemirror/merge";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { storeToRefs } from "pinia";
import { getEditorFontFamily } from "@/features/editor/fonts";
import { languageExtensionForPath } from "@/features/editor/languages";
import { editorThemeExtensions } from "@/features/editor/theme";
import { joinPath, writeTextFile } from "@/shared/fs";
import { useCompareStore } from "@/stores/compare";
import { useGitStore } from "@/stores/git";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import { useI18n } from "@/i18n";

const props = defineProps<{
  tabId: string;
  active: boolean;
}>();

const { t } = useI18n();
const host = ref<HTMLDivElement | null>(null);
const compare = useCompareStore();
const git = useGitStore();
const workspace = useWorkspaceStore();
const settings = useSettingsStore();
const { theme } = storeToRefs(settings);
const editorFontFamily = computed(() => getEditorFontFamily(settings.editor.fontFamily));

const tab = computed(() => compare.tabs.find((t) => t.id === props.tabId) ?? null);

let mergeView: MergeView | null = null;
let applying = false;
let lastEditable = false;
let resizeObserver: ResizeObserver | null = null;

/** 对比视图专用主题：块状着色，覆盖包默认的底部细线高亮 */
const mergeHighlightTheme = Prec.highest(
  EditorView.theme({
    "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": {
      backgroundColor: "var(--diff-remove-line)",
    },
    "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": {
      backgroundColor: "var(--diff-add-line)",
    },
    "&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText": {
      background: "var(--diff-remove-text)",
      borderRadius: "2px",
      color: "inherit",
      textDecoration: "none",
    },
    "&.cm-merge-b .cm-changedText": {
      background: "var(--diff-add-text)",
      borderRadius: "2px",
      color: "inherit",
      textDecoration: "none",
    },
    "&.cm-merge-b .cm-deletedText": {
      background: "var(--diff-remove-text)",
      borderRadius: "2px",
      textDecoration: "none",
    },
  }),
);

/** MergeView 自身整体滚动；去掉主编辑器 40vh 底垫 */
const mergeLayoutTheme = Prec.highest(
  EditorView.theme({
    "&": {
      height: "auto",
      fontSize: "13px",
      backgroundColor: "var(--bg-editor)",
    },
    ".cm-scroller": {
      fontFamily: "var(--prism-editor-font-family, var(--font-mono))",
      lineHeight: "1.55",
    },
    ".cm-content": {
      paddingBottom: "24px",
    },
    ".cm-gutters": {
      backgroundColor: "var(--bg-inset)",
      color: "var(--text-muted)",
      borderRight: "1px solid var(--border-subtle)",
    },
  }),
);

function buildExtensions(editable: boolean): Extension[] {
  const exts: Extension[] = [
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    // 语法高亮与配色复用主主题，再用 merge 布局主题覆盖高度/底垫
    ...editorThemeExtensions(theme.value),
    mergeLayoutTheme,
    mergeHighlightTheme,
    EditorView.editable.of(editable),
    EditorState.readOnly.of(!editable),
  ];
  if (editable) {
    exts.push(
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || applying) return;
        compare.setRightContent(props.tabId, update.state.doc.toString());
      }),
    );
  }
  return exts;
}

function destroyView() {
  mergeView?.destroy();
  mergeView = null;
}

function measureView() {
  if (!mergeView) return;
  mergeView.a.requestMeasure();
  mergeView.b.requestMeasure();
}

function createView() {
  const current = tab.value;
  if (!host.value || !current || !props.active) return;
  destroyView();
  lastEditable = current.editableRight;

  // 语言解析器按需加载：先以无语言创建 Merge 视图，resolve 后 reconfigure 补齐（A/B 各自 Compartment）
  const langCompA = new Compartment();
  const langCompB = new Compartment();
  mergeView = new MergeView({
    parent: host.value,
    orientation: "a-b",
    highlightChanges: true,
    gutter: true,
    collapseUnchanged: { margin: 3, minSize: 6 },
    a: {
      doc: current.left,
      extensions: [langCompA.of([]), ...buildExtensions(false)],
    },
    b: {
      doc: current.right,
      extensions: [langCompB.of([]), ...buildExtensions(current.editableRight)],
    },
  });

  // 异步装配语言高亮；视图已重建/销毁则丢弃（竞态）
  const mv = mergeView;
  void languageExtensionForPath(current.path).then((lang) => {
    if (mergeView !== mv) return;
    const ext = lang ?? [];
    mv.a.dispatch({ effects: langCompA.reconfigure(ext) });
    mv.b.dispatch({ effects: langCompB.reconfigure(ext) });
  });

  // 初次挂载后强制测量，避免容器尚未布局完成时高度为 0
  requestAnimationFrame(() => {
    measureView();
  });
}

function syncDocs() {
  const current = tab.value;
  if (!mergeView || !current) return;
  applying = true;
  const aDoc = mergeView.a.state.doc.toString();
  const bDoc = mergeView.b.state.doc.toString();
  if (aDoc !== current.left) {
    mergeView.a.dispatch({
      changes: { from: 0, to: mergeView.a.state.doc.length, insert: current.left },
    });
  }
  if (bDoc !== current.right) {
    mergeView.b.dispatch({
      changes: { from: 0, to: mergeView.b.state.doc.length, insert: current.right },
    });
  }
  applying = false;
}

async function saveResult() {
  const current = tab.value;
  if (!current || !workspace.rootPath || current.kind !== "merge") return;
  const root = workspace.rootPath;
  const tabId = current.id;
  const content = mergeView?.b.state.doc.toString() ?? current.right;
  try {
    const abs = joinPath(root, current.path);
    await writeTextFile(root, abs, content);
    if (
      workspace.rootPath !== root ||
      !compare.tabs.some((item) => item.id === tabId)
    ) {
      return;
    }
    await git.resolveConflict(current.path, "manual");
    if (
      workspace.rootPath !== root ||
      !compare.tabs.some((item) => item.id === tabId)
    ) {
      return;
    }
    workspace.showNotice(t("compare.savedResolved", { path: current.path }));
    compare.closeTab(tabId);
  } catch (error) {
    if (workspace.rootPath !== root) return;
    workspace.showNotice(
      error instanceof Error ? error.message : String(error),
      3200,
    );
  }
}

async function acceptOurs() {
  const current = tab.value;
  if (!current || !workspace.rootPath) return;
  const root = workspace.rootPath;
  const tabId = current.id;
  await git.resolveConflict(current.path, "ours");
  if (workspace.rootPath === root && compare.tabs.some((item) => item.id === tabId)) {
    compare.closeTab(tabId);
  }
}

async function acceptTheirs() {
  const current = tab.value;
  if (!current || !workspace.rootPath) return;
  const root = workspace.rootPath;
  const tabId = current.id;
  await git.resolveConflict(current.path, "theirs");
  if (workspace.rootPath === root && compare.tabs.some((item) => item.id === tabId)) {
    compare.closeTab(tabId);
  }
}

function rebuild() {
  nextTick(() => {
    destroyView();
    createView();
  });
}

function useOursInResult() {
  compare.applySideToResult(props.tabId, "ours");
  rebuild();
}

function useTheirsInResult() {
  compare.applySideToResult(props.tabId, "theirs");
  rebuild();
}

function useBaseInResult() {
  compare.applySideToResult(props.tabId, "base");
  rebuild();
}

function conflictMarkerPositions(): number[] {
  const text =
    mergeView?.b.state.doc.toString() ??
    tab.value?.right ??
    tab.value?.conflict?.working ??
    "";
  const positions: number[] = [];
  const re = /^<<<<<<< /gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    positions.push(m.index);
  }
  // 无标记时按变更块大致跳转：按 diff 行
  if (!positions.length) {
    const lines = text.split("\n");
    let offset = 0;
    for (const line of lines) {
      if (line.startsWith("=======") || line.startsWith(">>>>>>>")) {
        positions.push(offset);
      }
      offset += line.length + 1;
    }
  }
  return positions;
}

function jumpConflict(dir: 1 | -1) {
  const view = mergeView?.b;
  if (!view) return;
  const positions = conflictMarkerPositions();
  if (!positions.length) {
    workspace.showNotice(t("compare.noConflictMarker"));
    return;
  }
  const cursor = view.state.selection.main.head;
  let target = positions[0]!;
  if (dir > 0) {
    target = positions.find((p) => p > cursor) ?? positions[0]!;
  } else {
    const before = [...positions].reverse().find((p) => p < cursor);
    target = before ?? positions[positions.length - 1]!;
  }
  view.dispatch({
    selection: { anchor: target },
    scrollIntoView: true,
  });
  view.focus();
}

function toggleCompareMode() {
  const current = tab.value;
  if (!current?.conflict) return;
  if (current.editableRight) {
    compare.showOursTheirs(props.tabId);
  } else {
    compare.applySideToResult(props.tabId, "ours");
    const next = tab.value;
    if (next?.conflict) {
      next.right = next.conflict.working || next.conflict.ours;
    }
  }
  rebuild();
}

onMounted(() => {
  createView();
  if (host.value) {
    resizeObserver = new ResizeObserver(() => {
      if (!props.active) return;
      measureView();
    });
    resizeObserver.observe(host.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  destroyView();
});

watch(
  () => props.active,
  async (active) => {
    if (!active) return;
    await nextTick();
    if (!mergeView) {
      createView();
    } else {
      // v-show 切回时容器尺寸变化，需要重新测量对齐 spacer
      measureView();
    }
  },
);

watch(
  () =>
    tab.value
      ? ([tab.value.left, tab.value.right, tab.value.editableRight] as const)
      : null,
  (next) => {
    if (!next || !props.active) return;
    const editable = next[2];
    if (!mergeView || editable !== lastEditable) {
      createView();
      return;
    }
    syncDocs();
  },
);

watch(theme, () => {
  if (props.active) createView();
});
</script>

<template>
  <div class="compare">
    <header v-if="tab" class="toolbar">
      <div class="labels">
        <span class="side side-left">{{ tab.leftLabel }}</span>
        <span class="sep">↔</span>
        <span class="side side-right">{{ tab.rightLabel }}</span>
        <span class="path">{{ tab.path }}</span>
      </div>
      <div v-if="tab.kind === 'merge'" class="actions">
        <button type="button" class="btn" :title="t('compare.prevConflictTitle')" @click="jumpConflict(-1)">
          {{ t("compare.prevConflict") }}
        </button>
        <button type="button" class="btn" :title="t('compare.nextConflictTitle')" @click="jumpConflict(1)">
          {{ t("compare.nextConflict") }}
        </button>
        <button type="button" class="btn" @click="toggleCompareMode">
          {{ tab.editableRight ? t("compare.viewBoth") : t("compare.editResult") }}
        </button>
        <button type="button" class="btn" @click="useOursInResult">{{ t("compare.fillOurs") }}</button>
        <button type="button" class="btn" @click="useTheirsInResult">{{ t("compare.fillTheirs") }}</button>
        <button type="button" class="btn" @click="useBaseInResult">{{ t("compare.fillBase") }}</button>
        <button type="button" class="btn danger" @click="acceptOurs">{{ t("compare.keepOurs") }}</button>
        <button type="button" class="btn danger" @click="acceptTheirs">{{ t("compare.keepTheirs") }}</button>
        <button
          type="button"
          class="btn primary"
          :disabled="!tab.editableRight"
          @click="saveResult"
        >
          {{ t("compare.saveResolve") }}
        </button>
      </div>
      <div v-else class="actions">
        <span class="hint">{{ t("compare.readonlyHint") }}</span>
      </div>
    </header>
    <div
      ref="host"
      class="merge-host"
      :style="{ '--prism-editor-font-family': editorFontFamily }"
    />
  </div>
</template>

<style scoped>
.compare {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-app);

  /* 改动色只用于建立阅读锚点，不让整片代码被红绿底色淹没。 */
  --diff-remove-line: color-mix(in srgb, var(--danger) 7%, transparent);
  --diff-remove-text: color-mix(in srgb, var(--danger) 16%, transparent);
  --diff-remove-edge: color-mix(in srgb, var(--danger) 72%, transparent);
  --diff-add-line: color-mix(in srgb, var(--success) 7%, transparent);
  --diff-add-text: color-mix(in srgb, var(--success) 16%, transparent);
  --diff-add-edge: color-mix(in srgb, var(--success) 72%, transparent);
  --diff-change-edge: color-mix(in srgb, var(--accent) 72%, transparent);
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 34px;
  padding: 5px 12px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-panel);
  flex-shrink: 0;
}

.labels {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  font-size: 12px;
}

.side {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 180px;
  padding: 3px 7px 3px 6px;
  border: 1px solid var(--border-subtle);
  border-radius: 5px;
  background: var(--bg-inset);
  color: var(--text-secondary);
  font-weight: 600;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.side::before {
  content: "";
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
}

.side-left::before {
  background: var(--diff-remove-edge);
}

.side-right::before {
  background: var(--diff-add-edge);
}

.sep {
  padding: 0 1px;
  color: var(--text-muted);
}

.path {
  min-width: 0;
  padding-left: 8px;
  border-left: 1px solid var(--border-subtle);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.btn {
  height: 26px;
  padding: 0 10px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  border: 1px solid var(--border-subtle);
  background: var(--bg-inset);
  transition: background var(--transition-fast), color var(--transition-fast),
    border-color var(--transition-fast);
}

.btn:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent);
}

.btn.primary {
  background: var(--accent);
  color: var(--accent-fg);
  border-color: transparent;
}

.btn.danger:hover:not(:disabled) {
  color: var(--danger);
  border-color: var(--danger);
}

.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.hint {
  font-size: 11px;
  color: var(--text-muted);
}

/*
  CodeMirror MergeView 约定：外层 .cm-mergeView 设固定高度 + overflow:auto 才能滚动；
  两侧编辑器内容高度为 auto，由外层统一滚动并对齐。
*/
.merge-host {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  background: var(--bg-editor);
}

.merge-host :deep(.cm-mergeView) {
  height: 100%;
  overflow: auto;
  outline: none;
  background: var(--bg-editor);
  overscroll-behavior: contain;
}

.merge-host :deep(.cm-mergeViewEditors) {
  display: flex;
  align-items: stretch;
  min-height: 100%;
}

.merge-host :deep(.cm-mergeViewEditor) {
  flex: 1;
  min-width: 0;
  background: var(--bg-editor);
}

.merge-host :deep(.cm-mergeViewEditor + .cm-mergeViewEditor) {
  border-left: 1px solid var(--border-strong);
}

.merge-host :deep(.cm-editor) {
  height: auto;
}

.merge-host :deep(.cm-gutters) {
  background: var(--bg-inset);
  border-right-color: var(--border-subtle);
}

.merge-host :deep(.cm-lineNumbers .cm-gutterElement) {
  min-width: 38px;
  padding: 0 9px 0 7px;
  text-align: right;
}

/* MergeView 默认的绿/橙色改动 gutter 过亮，改成窄而稳定的语义色标。 */
.merge-host :deep(.cm-changeGutter) {
  width: 4px;
  padding-left: 0;
}

.merge-host :deep(.cm-merge-a .cm-changedLineGutter),
.merge-host :deep(.cm-deletedLineGutter) {
  background: var(--diff-remove-edge);
}

.merge-host :deep(.cm-merge-b .cm-changedLineGutter) {
  background: var(--diff-add-edge);
}

.merge-host :deep(.cm-inlineChangedLineGutter) {
  background: var(--diff-change-edge);
}

/* 字符级高亮只保留一层柔和底色和底部锚线，避免每一行变成实心色块。 */
.merge-host :deep(.cm-changedText),
.merge-host :deep(.cm-deletedText) {
  background-image: none !important;
  text-decoration: none !important;
  border-radius: 2px;
}

.merge-host :deep(.cm-merge-a .cm-changedText),
.merge-host :deep(.cm-deletedChunk .cm-deletedText) {
  background: var(--diff-remove-text) !important;
  box-shadow: inset 0 -1px 0 var(--diff-remove-edge);
}

.merge-host :deep(.cm-merge-b .cm-changedText) {
  background: var(--diff-add-text) !important;
  box-shadow: inset 0 -1px 0 var(--diff-add-edge);
}

.merge-host :deep(.cm-merge-a .cm-changedLine),
.merge-host :deep(.cm-deletedChunk) {
  background-color: var(--diff-remove-line);
  box-shadow: inset 2px 0 0 var(--diff-remove-edge);
}

.merge-host :deep(.cm-merge-b .cm-changedLine),
.merge-host :deep(.cm-inlineChangedLine) {
  background-color: var(--diff-add-line);
  box-shadow: inset 2px 0 0 var(--diff-add-edge);
}

.merge-host :deep(.cm-merge-b .cm-deletedText) {
  background: var(--diff-remove-text) !important;
  box-shadow: inset 0 -1px 0 var(--diff-remove-edge);
}

/* 折叠的未改动区变成明确的横向分隔，而不是一条发光渐变。 */
.merge-host :deep(.cm-collapsedLines) {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 27px;
  padding: 4px 10px;
  border-top: 1px solid var(--border-subtle);
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-panel);
  color: var(--text-muted);
  font-size: 11px;
  letter-spacing: 0.01em;
  text-align: center;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.merge-host :deep(.cm-collapsedLines:hover) {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.merge-host :deep(.cm-collapsedLines::before),
.merge-host :deep(.cm-collapsedLines::after) {
  color: var(--accent);
  opacity: 0.65;
}
</style>
