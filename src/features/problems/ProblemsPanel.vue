<script setup lang="ts">
// ==================== 问题面板 ====================
// 聚合所有 model 的 marker（TS/JS、Vue script、JSON、.env、ESLint），
// 按文件分组展示，点击定位到编辑器。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "@/i18n";
import { monaco } from "@/features/editor/monaco/setup";
import { basename } from "@/shared/fs";
import { useEditorStore } from "@/stores/editor";
import { useWorkspaceStore } from "@/stores/workspace";

interface Problem {
  path: string;
  line: number;
  column: number;
  severity: number;
  message: string;
  source: string;
}

const { t } = useI18n();
const editor = useEditorStore();
const workspace = useWorkspaceStore();

const problems = ref<Problem[]>([]);
const filter = ref<"all" | "error" | "warning">("all");

const collect = () => {
  const list: Problem[] = [];
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme !== "file") continue;
    for (const marker of monaco.editor.getModelMarkers({ resource: model.uri })) {
      list.push({
        path: model.uri.fsPath,
        line: marker.startLineNumber,
        column: marker.startColumn,
        severity: marker.severity,
        message: marker.message,
        source: marker.source ?? "",
      });
    }
  }
  list.sort(
    (a, b) =>
      a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column,
  );
  problems.value = list;
};

const errorCount = computed(
  () => problems.value.filter((problem) => problem.severity >= 8).length,
);
const warningCount = computed(
  () => problems.value.filter((problem) => problem.severity < 8).length,
);

const visible = computed(() =>
  problems.value.filter((problem) => {
    if (filter.value === "all") return true;
    if (filter.value === "error") return problem.severity >= 8;
    return problem.severity < 8;
  }),
);

/** 按文件分组，保持稳定顺序 */
const grouped = computed(() => {
  const groups: Array<{ path: string; items: Problem[] }> = [];
  let current: { path: string; items: Problem[] } | null = null;
  for (const problem of visible.value) {
    if (!current || current.path !== problem.path) {
      current = { path: problem.path, items: [] };
      groups.push(current);
    }
    current.items.push(problem);
  }
  return groups;
});

function revealProblem(problem: Problem) {
  editor.requestOpenAt(problem.path, problem.line, problem.column);
}

let subscription: { dispose(): void } | null = null;

onMounted(() => {
  collect();
  subscription = monaco.editor.onDidChangeMarkers(() => collect());
});

onBeforeUnmount(() => {
  subscription?.dispose();
  subscription = null;
});
</script>

<template>
  <div class="problems">
    <header class="toolbar">
      <div class="filters">
        <button
          type="button"
          class="filter"
          :class="{ active: filter === 'all' }"
          @click="filter = 'all'"
        >
          {{ t("problems.filterAll") }} ({{ problems.length }})
        </button>
        <button
          type="button"
          class="filter"
          :class="{ active: filter === 'error' }"
          @click="filter = 'error'"
        >
          {{ t("problems.filterError") }} ({{ errorCount }})
        </button>
        <button
          type="button"
          class="filter"
          :class="{ active: filter === 'warning' }"
          @click="filter = 'warning'"
        >
          {{ t("problems.filterWarning") }} ({{ warningCount }})
        </button>
      </div>
    </header>

    <div v-if="!grouped.length" class="empty">{{ t("problems.empty") }}</div>

    <div v-else class="list">
      <section v-for="group in grouped" :key="group.path" class="group">
        <div class="group-title" :title="group.path">
          <span class="name">{{ basename(group.path) }}</span>
          <span class="dir">{{ group.path }}</span>
        </div>
        <button
          v-for="(problem, index) in group.items"
          :key="`${problem.line}:${problem.column}:${index}`"
          type="button"
          class="row"
          @click="revealProblem(problem)"
        >
          <span class="severity" :class="problem.severity >= 8 ? 'error' : 'warning'">
            {{ problem.severity >= 8 ? "✕" : "!" }}
          </span>
          <span class="where">{{ problem.line }}:{{ problem.column }}</span>
          <span class="message">{{ problem.message }}</span>
          <span v-if="problem.source" class="source">{{ problem.source }}</span>
        </button>
      </section>
    </div>
    <div v-if="workspace.rootPath" class="footer-hint">{{ t("problems.hint") }}</div>
  </div>
</template>

<style scoped>
.problems {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-panel);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.filters {
  display: flex;
  gap: 4px;
}

.filter {
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
  cursor: pointer;
}

.filter:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.filter.active {
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  color: var(--accent);
}

.empty {
  flex: 1;
  display: grid;
  place-items: center;
  color: var(--text-muted);
  font-size: 12px;
}

.list {
  flex: 1;
  overflow: auto;
  min-height: 0;
}

.group-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 10px 3px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  position: sticky;
  top: 0;
  background: var(--bg-panel);
}

.group-title .dir {
  font-weight: 400;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 3px 10px 3px 18px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.row:hover {
  background: var(--bg-hover);
}

.severity {
  flex-shrink: 0;
  width: 12px;
  text-align: center;
  font-weight: 700;
}

.severity.error {
  color: #f87171;
}

.severity.warning {
  color: #fbbf24;
}

.where {
  flex-shrink: 0;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.message {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 11px;
}

.footer-hint {
  padding: 3px 10px;
  border-top: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: 11px;
  flex-shrink: 0;
}
</style>
