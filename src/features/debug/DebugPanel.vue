<script setup lang="ts">
// ==================== 调试面板 ====================
// 底部面板的第三个视图（与终端/问题并列）。终端用 v-show 保活，这里同样保活：
// 调试时经常要切到终端看目标进程日志。会话只在面板收起或显式停止时结束。
import { computed, onBeforeUnmount, watch } from "vue";
import { ChevronRight, Pause, Play, Redo, SkipNext, Stop, Undo } from "reicon-vue";
import { storeToRefs } from "pinia";
import { useI18n } from "@/i18n";
import { useDebugStore } from "@/stores/debug";
import { useEditorStore } from "@/stores/editor";
import { useSessionsStore } from "@/stores/sessions";
import { useWorkspaceStore } from "@/stores/workspace";

const { t } = useI18n();
const debug = useDebugStore();
const sessions = useSessionsStore();
const workspace = useWorkspaceStore();
const editor = useEditorStore();
const { state, threads, activeThreadId, stackFrames, activeFrameId, variables, output, busy, stopReason, debugPort } =
  storeToRefs(debug);

const stateLabel = computed(() => t(`debug.state.${state.value}`));
/** DAP 的 stopped.reason 是自由字符串：只在已知集合里翻译，其余走兜底文案 */
const REASON_LABEL_KEY: Record<string, string> = {
  breakpoint: "debug.reason.breakpoint",
  step: "debug.reason.step",
  pause: "debug.reason.pause",
  exception: "debug.reason.exception",
  entry: "debug.reason.entry",
};
const reasonLabel = computed(() => {
  const reason = stopReason.value;
  if (!reason) return null;
  return t(REASON_LABEL_KEY[reason] ?? "debug.reason.other", { reason });
});
const paused = computed(() => state.value === "paused");
const live = computed(() => state.value === "running" || state.value === "paused" || state.value === "starting");

/** 工作区相对路径：调用栈里显示短路径，跳转时用完整路径 */
function shortPath(path: string | null): string {
  if (!path) return "";
  const root = workspace.rootPath;
  if (root && path.startsWith(root)) {
    return path.slice(root.length).replace(/^[/\\]/, "");
  }
  const parts = path.split(/[/\\]/);
  return parts.slice(Math.max(0, parts.length - 3)).join("/");
}

async function openFrame(frameId: number, path: string | null, line: number) {
  if (!path) return;
  await debug.selectFrame(frameId);
  await editor.openFile(path);
  editor.setCursor(path, line, 1);
}

// 面板收起（⌘J 或顶栏收起）即结束会话：DAP 会话不常驻内存
watch(
  () => sessions.open,
  (open) => {
    if (!open && debug.state !== "idle") void debug.stop();
  },
);

onBeforeUnmount(() => {
  if (debug.state !== "idle") void debug.stop();
});
</script>

<template>
  <div class="debug-panel">
    <header class="toolbar">
      <span class="state" :data-state="state">{{ stateLabel }}</span>
      <span v-if="debugPort" class="port">{{ t("debug.port", { port: debugPort }) }}</span>
      <span v-if="reasonLabel" class="reason">{{ reasonLabel }}</span>
      <span class="spacer" />
      <button
        type="button"
        class="icon-btn"
        :title="t('debug.action.continue')"
        :disabled="!live || busy || !paused"
        @click="debug.resume()"
      >
        <Play weight="Filled" :size="13" />
      </button>
      <button
        type="button"
        class="icon-btn"
        :title="t('debug.action.pause')"
        :disabled="!live || busy || paused"
        @click="debug.pause()"
      >
        <Pause weight="Filled" :size="13" />
      </button>
      <button
        type="button"
        class="icon-btn"
        :title="t('debug.action.stepOver')"
        :disabled="!paused || busy"
        @click="debug.stepOver()"
      >
        <SkipNext weight="Filled" :size="13" />
      </button>
      <button
        type="button"
        class="icon-btn"
        :title="t('debug.action.stepInto')"
        :disabled="!paused || busy"
        @click="debug.stepInto()"
      >
        <Undo weight="Filled" :size="13" />
      </button>
      <button
        type="button"
        class="icon-btn"
        :title="t('debug.action.stepOut')"
        :disabled="!paused || busy"
        @click="debug.stepOut()"
      >
        <Redo weight="Filled" :size="13" />
      </button>
      <button
        type="button"
        class="icon-btn"
        :title="t('debug.action.stop')"
        :disabled="!live"
        @click="debug.stop()"
      >
        <Stop weight="Filled" :size="13" />
      </button>
    </header>

    <div class="body">
      <section class="column threads">
        <h3 class="column-title">{{ t("debug.section.threads") }}</h3>
        <button
          v-for="thread in threads"
          :key="thread.id"
          type="button"
          class="row"
          :class="{ active: thread.id === activeThreadId }"
          @click="debug.refreshPaused(thread.id)"
        >
          <span class="row-name">{{ thread.name }}</span>
        </button>
        <p v-if="!threads.length" class="empty">{{ t("debug.empty.threads") }}</p>
      </section>

      <section class="column frames">
        <h3 class="column-title">{{ t("debug.section.frames") }}</h3>
        <button
          v-for="frame in stackFrames"
          :key="frame.id"
          type="button"
          class="row"
          :class="{ active: frame.id === activeFrameId }"
          @click="openFrame(frame.id, frame.path, frame.line)"
        >
          <span class="row-name">{{ frame.name }}</span>
          <span class="row-meta">{{ shortPath(frame.path) }}:{{ frame.line }}</span>
        </button>
        <p v-if="!stackFrames.length" class="empty">{{ t("debug.empty.frames") }}</p>
      </section>

      <section class="column variables">
        <h3 class="column-title">{{ t("debug.section.variables") }}</h3>
        <div v-for="(variable, index) in variables" :key="`${variable.name}:${index}`" class="variable">
          <span class="row-name">{{ variable.name }}</span>
          <span class="row-meta" :title="variable.type ?? ''">{{ variable.value }}</span>
        </div>
        <p v-if="!variables.length" class="empty">{{ t("debug.empty.variables") }}</p>
      </section>

      <section class="column output">
        <h3 class="column-title">{{ t("debug.section.output") }}</h3>
        <pre v-for="(line, index) in output" :key="index" class="output-line">{{ line }}</pre>
        <p v-if="!output.length" class="empty">{{ t("debug.empty.output") }}</p>
      </section>
    </div>

    <p class="hint">
      <ChevronRight weight="Filled" :size="12" />
      {{ t("debug.hint.breakpoints", { count: debug.breakpointCount }) }}
    </p>
  </div>
</template>

<style scoped>
.debug-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border-subtle);
}

.state {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
}

.state[data-state="running"] {
  color: var(--success);
}

.state[data-state="paused"] {
  color: var(--warning);
}

.port,
.reason {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-muted);
}

.spacer {
  flex: 1;
}

.icon-btn {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--text-muted);
}

.icon-btn:hover:not(:disabled) {
  color: var(--accent);
  background: var(--accent-soft);
}

.icon-btn:disabled {
  opacity: 0.4;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.column {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  overflow-y: auto;
  border-right: 1px solid var(--border-subtle);
}

.column:last-child {
  border-right: none;
}

.column-title {
  margin: 0 0 2px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 3px 6px;
  border-radius: 6px;
  text-align: left;
}

.row:hover {
  background: var(--accent-soft);
}

.row.active {
  background: var(--accent-soft);
  color: var(--accent);
}

.row-name {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row.active .row-name {
  color: var(--accent);
}

.row-meta {
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.variable {
  display: flex;
  gap: 6px;
  padding: 2px 6px;
  font-size: 11px;
}

.variable .row-meta {
  flex: 1;
  color: var(--text-secondary);
}

.output-line {
  margin: 0;
  padding: 0 6px;
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}

.empty {
  margin: 2px 6px;
  font-size: 11px;
  color: var(--text-muted);
}

.hint {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 3px 8px;
  font-size: 10px;
  color: var(--text-muted);
  border-top: 1px solid var(--border-subtle);
}
</style>
