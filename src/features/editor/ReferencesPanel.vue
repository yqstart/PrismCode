<script setup lang="ts">
import { X } from "reicon-vue";
import { storeToRefs } from "pinia";
import { relativeToRoot } from "@/shared/fs";
import { useI18n } from "@/i18n";
import { useEditorStore } from "@/stores/editor";
import { useWorkspaceStore } from "@/stores/workspace";

const { t } = useI18n();
const editor = useEditorStore();
const workspace = useWorkspaceStore();
const { referencesVisible, referenceWord, referenceResults } = storeToRefs(editor);

function openResult(path: string, line: number, column: number) {
  editor.closeReferences();
  void editor.openFileAt(path, line, column);
}

function displayPath(path: string): string {
  return workspace.rootPath ? relativeToRoot(workspace.rootPath, path) : path;
}
</script>

<template>
  <Transition name="reference-panel">
    <section v-if="referencesVisible" class="references-panel" aria-live="polite">
      <header class="references-head">
        <div class="references-title">
          <strong>{{ t("editor.references") }}</strong>
          <span class="references-word">{{ referenceWord }}</span>
          <span class="references-count">
            {{ t("editor.referencesCount", { count: referenceResults.length }) }}
          </span>
        </div>
        <button
          type="button"
          class="icon-btn"
          :title="t('editor.closeReferences')"
          :aria-label="t('editor.closeReferences')"
          @click="editor.closeReferences()"
        >
          <X weight="Filled" :size="15" />
        </button>
      </header>

      <div v-if="referenceResults.length" class="references-list">
        <button
          v-for="item in referenceResults"
          :key="`${item.path}:${item.line}:${item.column}`"
          type="button"
          class="reference-row"
          @click="openResult(item.path, item.line, item.column)"
        >
          <span class="reference-location">
            <span class="reference-path">{{ displayPath(item.path) }}</span>
            <span class="reference-position">{{ item.line }}:{{ item.column }}</span>
          </span>
          <span v-if="item.isDefinition" class="reference-kind">
            {{ t("editor.referenceDefinition") }}
          </span>
        </button>
      </div>
      <p v-else class="references-empty">{{ t("editor.noReferences") }}</p>
    </section>
  </Transition>
</template>

<style scoped>
.references-panel {
  position: fixed;
  right: 20px;
  bottom: calc(var(--status-bar-height) + 14px);
  z-index: 35;
  width: min(640px, calc(100vw - 40px));
  max-height: min(420px, calc(100vh - 120px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-modal);
}

.references-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-subtle);
}

.references-title,
.reference-location {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.references-word {
  color: var(--accent);
  font-family: var(--font-mono);
}

.references-count,
.reference-position,
.reference-kind {
  color: var(--text-muted);
  font-size: 11px;
}

.icon-btn {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
}

.icon-btn:hover {
  background: var(--accent-soft);
  color: var(--text-primary);
}

.references-list {
  overflow: auto;
  padding: 4px;
}

.reference-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  text-align: left;
}

.reference-row:hover {
  background: var(--accent-soft);
}

.reference-path {
  overflow: hidden;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reference-kind {
  flex: 0 0 auto;
  color: var(--accent);
}

.references-empty {
  margin: 0;
  padding: 24px;
  color: var(--text-muted);
  text-align: center;
}

.reference-panel-enter-active,
.reference-panel-leave-active {
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}

.reference-panel-enter-from,
.reference-panel-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
