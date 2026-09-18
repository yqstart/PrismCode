<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { GitBranch } from "lucide-vue-next";
import { storeToRefs } from "pinia";
import BranchesPopup from "@/features/git/BranchesPopup.vue";
import { THEME_LABELS, THEME_ORDER } from "@/features/editor/theme";
import { basename } from "@/shared/fs";
import type { ThemeId } from "@/shared/types";
import { useEditorStore } from "@/stores/editor";
import { useGitStore } from "@/stores/git";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import { useI18n } from "@/i18n";

const { t } = useI18n();
const settings = useSettingsStore();
const workspace = useWorkspaceStore();
const editor = useEditorStore();
const git = useGitStore();
const { editor: editorPrefs, theme } = storeToRefs(settings);
const { activeTab } = storeToRefs(editor);
const { snapshot } = storeToRefs(git);

const themeMenuOpen = ref(false);
const branchesOpen = ref(false);

const lang = computed(() => activeTab.value?.language ?? "—");
const cursor = computed(() => activeTab.value?.cursor ?? { line: 1, column: 1 });
const dirty = computed(() => activeTab.value?.dirty ?? false);
const branch = computed(() =>
  snapshot.value.initialized ? snapshot.value.branch : null,
);
const syncLabel = computed(() => {
  if (!snapshot.value.initialized) return "";
  const { ahead, behind, upstream } = snapshot.value;
  if (!upstream && !ahead && !behind) return "";
  const parts: string[] = [];
  if (ahead) parts.push(`↑${ahead}`);
  if (behind) parts.push(`↓${behind}`);
  if (!parts.length && upstream) return t("status.synced");
  return parts.join(" ");
});
const themeLabel = computed(() => THEME_LABELS[theme.value]);

/** 状态栏左端名称：项目名；light 模式（无工作区）显示当前独立文件名 */
const workspaceLabel = computed(() =>
  workspace.rootPath
    ? workspace.rootName
    : (editor.activePath ? basename(editor.activePath) : workspace.rootName),
);
const workspaceLabelTitle = computed(
  () => workspace.rootPath ?? editor.activePath ?? workspace.rootName,
);

const themeOptions = computed(() =>
  THEME_ORDER.map((id) => ({ id, label: THEME_LABELS[id] })),
);

function toggleThemeMenu(event: MouseEvent) {
  event.stopPropagation();
  branchesOpen.value = false;
  themeMenuOpen.value = !themeMenuOpen.value;
}

function selectTheme(id: ThemeId) {
  settings.setTheme(id);
  themeMenuOpen.value = false;
}

function cycleTheme() {
  const idx = THEME_ORDER.indexOf(theme.value);
  const next = THEME_ORDER[(idx + 1) % THEME_ORDER.length] ?? THEME_ORDER[0];
  settings.setTheme(next);
}

function toggleBranches(event: MouseEvent) {
  event.stopPropagation();
  if (!branch.value) return;
  themeMenuOpen.value = false;
  branchesOpen.value = !branchesOpen.value;
}

function onDocClick() {
  themeMenuOpen.value = false;
}

onMounted(() => {
  window.addEventListener("click", onDocClick);
});

onBeforeUnmount(() => {
  window.removeEventListener("click", onDocClick);
});
</script>

<template>
  <footer class="status-bar">
    <div class="left">
      <span class="root-name" :title="workspaceLabelTitle">{{
        workspaceLabel
      }}</span>
      <div v-if="branch" class="branch-switch" @click.stop>
        <button
          type="button"
          class="branch-btn"
          :title="`Git Branches · ${branch}${syncLabel ? ` · ${syncLabel}` : ''}`"
          @click="toggleBranches"
        >
          <GitBranch :size="12" class="branch-icon" />
          <span class="branch-name">{{ branch }}</span>
          <span v-if="syncLabel" class="sync-label">{{ syncLabel }}</span>
        </button>
      </div>
      <span class="sep">·</span>
      <span class="meta">{{ lang }}</span>
      <span class="sep">·</span>
      <span class="meta">UTF-8</span>
      <span v-if="dirty" class="dirty">{{ t("status.unsaved") }}</span>
      <button
        v-if="snapshot.conflictCount > 0"
        type="button"
        class="conflict"
        :title="t('status.openConflict')"
        @click="git.openFirstConflict()"
      >
        {{ t("status.conflicts", { count: snapshot.conflictCount }) }}
      </button>
    </div>
    <div class="right">
      <span>Ln {{ cursor.line }}, Col {{ cursor.column }}</span>
      <span class="sep">·</span>
      <span>Spaces: {{ editorPrefs.tabSize }}</span>
      <span class="sep">·</span>
      <div class="theme-switch" @click.stop>
        <button
          type="button"
          class="theme-btn"
          :title="t('status.switchThemeHint')"
          @click="toggleThemeMenu"
          @contextmenu.prevent="cycleTheme"
        >
          {{ themeLabel }}
        </button>
        <Transition name="popover">
          <div v-if="themeMenuOpen" class="theme-menu" role="menu">
            <button
              v-for="item in themeOptions"
              :key="item.id"
              type="button"
              class="theme-item"
              :class="{ active: theme === item.id }"
              role="menuitem"
              @click="selectTheme(item.id)"
            >
              {{ item.label }}
            </button>
          </div>
        </Transition>
      </div>
      <span class="sep">·</span>
      <span class="ok">{{ t("status.ready") }}</span>
    </div>
  </footer>

  <BranchesPopup :open="branchesOpen" @close="branchesOpen = false" />
</template>

<style scoped>
.status-bar {
  height: var(--status-bar-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px;
  background: var(--bg-header);
  border-top: 1px solid var(--border-subtle);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--bg-app) 28%, transparent);
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  min-width: 0;
}

.left,
.right {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.left {
  flex: 1;
  overflow: hidden;
}

.right {
  flex-shrink: 0;
}

.root-name {
  flex-shrink: 1;
  min-width: 0;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branch-switch {
  position: relative;
  min-width: 0;
  flex-shrink: 1;
}

.branch-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  min-width: 0;
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--accent);
  font-weight: 500;
  line-height: inherit;
}

.branch-btn:hover {
  background: var(--bg-hover);
}

.branch-icon {
  flex-shrink: 0;
}

.branch-name {
  min-width: 0;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sync-label {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.meta {
  flex-shrink: 0;
}

.sep {
  color: var(--text-muted);
  flex-shrink: 0;
}

.dirty {
  color: var(--warning);
  flex-shrink: 0;
}

.conflict {
  color: var(--danger);
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;
}

.conflict:hover {
  text-decoration: underline;
}

.theme-switch {
  position: relative;
}

.theme-btn {
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--text-secondary);
  transition: background var(--transition-fast) var(--ease-out),
    color var(--transition-fast) var(--ease-out);
}

.theme-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.theme-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  min-width: 140px;
  padding: 4px;
  border-radius: 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  z-index: 30;
  display: flex;
  flex-direction: column;
  transform-origin: bottom right;
}

.theme-item {
  text-align: left;
  padding: 6px 10px;
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 12px;
  transition: background var(--transition-fast) var(--ease-out),
    color var(--transition-fast) var(--ease-out);
}

.theme-item:hover,
.theme-item.active {
  background: var(--accent-soft);
  color: var(--accent);
}

/* popover：theme menu 等浮层（与 ActivityBar/scripts-pop 共用） */
.popover-enter-active {
  transition: opacity var(--transition-medium) var(--ease-out),
    transform var(--transition-medium) var(--ease-out);
}
.popover-leave-active {
  transition: opacity var(--transition-fast) var(--ease-out),
    transform var(--transition-fast) var(--ease-out);
}
.popover-enter-from,
.popover-leave-to {
  opacity: 0;
  transform: scale(0.96) translateY(4px);
}

.ok {
  color: var(--success);
}
</style>
