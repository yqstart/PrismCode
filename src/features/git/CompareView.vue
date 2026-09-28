<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { editor as MonacoEditorApi } from "monaco-editor/editor";
import { storeToRefs } from "pinia";
import { monaco } from "@/features/editor/monaco/setup";
import { languageIdForPath } from "@/features/editor/monaco/langSetup";
import { registerMonacoThemes } from "@/features/editor/monacoTheme";
import { getEditorFontFamily } from "@/features/editor/fonts";
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

let diffEditor: MonacoEditorApi.IStandaloneDiffEditor | null = null;
let originalModel: MonacoEditorApi.ITextModel | null = null;
let modifiedModel: MonacoEditorApi.ITextModel | null = null;
let modifiedSub: { dispose(): void } | null = null;
let applying = false;
let lastEditable = false;
let resizeObserver: ResizeObserver | null = null;

function modelUri(kind: "original" | "result") {
  return monaco.Uri.parse(`inmemory://prism-compare/${props.tabId}/${kind}`);
}

function destroyView() {
  modifiedSub?.dispose();
  modifiedSub = null;
  diffEditor?.dispose();
  diffEditor = null;
  originalModel?.dispose();
  originalModel = null;
  modifiedModel?.dispose();
  modifiedModel = null;
}

function measureView() {
  diffEditor?.layout();
}

function createView() {
  const current = tab.value;
  if (!host.value || !current || !props.active) return;
  destroyView();
  lastEditable = current.editableRight;
  registerMonacoThemes();

  const languageId = languageIdForPath(current.path);
  originalModel = monaco.editor.createModel(current.left, languageId, modelUri("original"));
  modifiedModel = monaco.editor.createModel(current.right, languageId, modelUri("result"));

  diffEditor = monaco.editor.createDiffEditor(host.value, {
    automaticLayout: false,
    theme: theme.value,
    readOnly: !current.editableRight,
    originalEditable: false,
    renderSideBySide: true,
    ignoreTrimWhitespace: false,
    renderIndicators: true,
    renderOverviewRuler: true,
    hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6 },
    fontSize: settings.editor.fontSize,
    fontFamily: editorFontFamily.value,
    lineNumbers: "on",
    renderLineHighlight: "line",
    glyphMargin: false,
    minimap: { enabled: false },
    folding: true,
    scrollBeyondLastLine: false,
    padding: { top: 6, bottom: 24 },
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
    fixedOverflowWidgets: true,
  });
  diffEditor.setModel({ original: originalModel, modified: modifiedModel });

  const modified = modifiedModel;
  modifiedSub = modified.onDidChangeContent(() => {
    if (applying || !modifiedModel) return;
    compare.setRightContent(props.tabId, modifiedModel.getValue());
  });

  requestAnimationFrame(() => {
    measureView();
  });
}

function syncDocs() {
  const current = tab.value;
  if (!originalModel || !modifiedModel || !current) return;
  applying = true;
  if (originalModel.getValue() !== current.left) {
    originalModel.setValue(current.left);
  }
  if (modifiedModel.getValue() !== current.right) {
    modifiedModel.setValue(current.right);
  }
  applying = false;
}

async function saveResult() {
  const current = tab.value;
  if (!current || !workspace.rootPath || current.kind !== "merge") return;
  const root = workspace.rootPath;
  const tabId = current.id;
  const content = modifiedModel?.getValue() ?? current.right;
  try {
    const abs = joinPath(root, current.path);
    await writeTextFile(root, abs, content);
    if (workspace.rootPath !== root || !compare.tabs.some((item) => item.id === tabId)) {
      return;
    }
    await git.resolveConflict(current.path, "manual");
    if (workspace.rootPath !== root || !compare.tabs.some((item) => item.id === tabId)) {
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
    modifiedModel?.getValue() ??
    tab.value?.right ??
    tab.value?.conflict?.working ??
    "";
  const positions: number[] = [];
  const re = /^<<<<<<< /gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    positions.push(match.index);
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
  const editor = diffEditor?.getModifiedEditor();
  const model = modifiedModel;
  if (!editor || !model) return;
  const positions = conflictMarkerPositions();
  if (!positions.length) {
    workspace.showNotice(t("compare.noConflictMarker"));
    return;
  }
  const cursor = model.getOffsetAt(editor.getPosition() ?? { lineNumber: 1, column: 1 });
  let target = positions[0]!;
  if (dir > 0) {
    target = positions.find((position) => position > cursor) ?? positions[0]!;
  } else {
    const before = [...positions].reverse().find((position) => position < cursor);
    target = before ?? positions[positions.length - 1]!;
  }
  const position = model.getPositionAt(target);
  editor.setPosition(position);
  editor.revealPositionInCenter(position);
  editor.focus();
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
    if (!diffEditor) {
      createView();
    } else {
      // v-show 切回时容器尺寸变化，需要重新测量
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
    if (!diffEditor || editable !== lastEditable) {
      createView();
      return;
    }
    syncDocs();
  },
);

watch(theme, (name) => {
  registerMonacoThemes();
  monaco.editor.setTheme(name);
  if (props.active) measureView();
});

watch(
  () => [settings.editor.fontSize, settings.editor.fontFamily] as const,
  () => {
    if (!diffEditor) return;
    diffEditor.updateOptions({
      fontSize: settings.editor.fontSize,
      fontFamily: editorFontFamily.value,
    });
    measureView();
  },
);
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

.merge-host :deep(.monaco-diff-editor) {
  background: var(--bg-editor);
}

.merge-host :deep(.monaco-diff-editor .editor.original) {
  border-right: 1px solid var(--border-strong);
}

/* 折叠的未改动区：交给 Monaco hideUnchangedRegions，样式跟随主题 */
.merge-host :deep(.monaco-diff-editor .diff-hidden-lines .center) {
  background: var(--bg-panel);
  color: var(--text-muted);
  font-size: 11px;
}

.merge-host :deep(.monaco-diff-editor .diff-hidden-lines .center:hover) {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.merge-host :deep(.monaco-diff-editor .line-insert),
.merge-host :deep(.monaco-diff-editor .char-insert) {
  background: var(--diff-add-text);
}

.merge-host :deep(.monaco-diff-editor .line-delete),
.merge-host :deep(.monaco-diff-editor .char-delete) {
  background: var(--diff-remove-text);
}

.merge-host :deep(.monaco-diff-editor .diffOverview) {
  display: none;
}
</style>
