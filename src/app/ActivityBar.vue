<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import {
  Files,
  GitCommitHorizontal,
  History,
  Package,
  Settings,
  TerminalSquare,
} from "lucide-vue-next";
import { storeToRefs } from "pinia";
import PackageScriptsMenu from "@/features/sessions/PackageScriptsMenu.vue";
import { useGitLogStore } from "@/stores/gitLog";
import { useGitStore } from "@/stores/git";
import { usePackageScriptsStore } from "@/stores/packageScripts";
import { useSessionsStore } from "@/stores/sessions";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { useWorkspaceStore } from "@/stores/workspace";
import type { SidePanelId } from "@/shared/types";
import { useI18n } from "@/i18n";

const { t } = useI18n();
const settings = useSettingsStore();
const ui = useUiStore();
const workspace = useWorkspaceStore();
const git = useGitStore();
const gitLog = useGitLogStore();
const pkg = usePackageScriptsStore();
const sessions = useSessionsStore();
const { layout } = storeToRefs(settings);
const { isFocused: logFocused } = storeToRefs(gitLog);
const { changedFileCount } = storeToRefs(git);
const { available } = storeToRefs(pkg);
const { open: terminalOpen } = storeToRefs(sessions);

const scriptsOpen = ref(false);
const scriptsBtn = ref<HTMLButtonElement | null>(null);
const popStyle = ref<Record<string, string>>({});

const gitBadge = computed(() => {
  const n = changedFileCount.value;
  if (n <= 0) return "";
  return n > 99 ? "99+" : String(n);
});

const commitActive = computed(
  () =>
    layout.value.activePanel === "commit" && !layout.value.sidebarCollapsed,
);

const logActive = computed(() => logFocused.value);

function selectPanel(panel: SidePanelId) {
  scriptsOpen.value = false;
  if (layout.value.activePanel === panel && !layout.value.sidebarCollapsed) {
    settings.toggleSidebar();
    return;
  }
  settings.setActivePanel(panel);
  if (panel === "commit" && workspace.rootPath) {
    void git.scheduleRefresh();
  }
}

function toggleLog() {
  scriptsOpen.value = false;
  gitLog.toggleLog();
  if (gitLog.open && workspace.rootPath) {
    void git.scheduleRefresh();
    void git.loadLog(100);
  }
}

function placePop() {
  const el = scriptsBtn.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  popStyle.value = {
    left: `${rect.right + 8}px`,
    bottom: `${window.innerHeight - rect.bottom}px`,
  };
}

async function toggleScripts() {
  if (scriptsOpen.value) {
    scriptsOpen.value = false;
    return;
  }
  await pkg.refresh(true);
  scriptsOpen.value = true;
  await nextTick();
  placePop();
}

function onDocPointer(event: MouseEvent) {
  if (!scriptsOpen.value) return;
  const target = event.target as Node | null;
  if (scriptsBtn.value?.contains(target)) return;
  const pop = document.getElementById("prism-scripts-pop");
  if (pop?.contains(target)) return;
  scriptsOpen.value = false;
}

function onKey(event: KeyboardEvent) {
  if (event.key === "Escape") scriptsOpen.value = false;
}

onMounted(() => {
  document.addEventListener("mousedown", onDocPointer);
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", placePop);
});

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocPointer);
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("resize", placePop);
});
</script>

<template>
  <aside class="activity-bar" :aria-label="t('app.activityBar')">
    <div class="group">
      <button
        class="item"
        type="button"
        :title="t('activity.explorer')"
        :class="{
          active:
            layout.activePanel === 'explorer' && !layout.sidebarCollapsed,
        }"
        @click="selectPanel('explorer')"
      >
        <Files :size="20" :stroke-width="1.75" />
      </button>
      <button
        class="item"
        type="button"
        :title="
          gitBadge
            ? t('activity.commitWithChanges', { count: changedFileCount })
            : t('activity.commit')
        "
        :class="{ active: commitActive }"
        @click="selectPanel('commit')"
      >
        <GitCommitHorizontal :size="20" :stroke-width="1.75" />
        <span v-if="gitBadge" class="badge">{{ gitBadge }}</span>
      </button>
      <!-- Git Log：紧贴左上 Git 图标下，与 commit 组成 git 区 -->
      <button
        class="item"
        type="button"
        :title="t('activity.gitLog')"
        :class="{ active: logActive }"
        @click="toggleLog"
      >
        <History :size="18" :stroke-width="1.75" />
      </button>
    </div>

    <div class="group">
      <button
        ref="scriptsBtn"
        class="item"
        type="button"
        :title="t('activity.scripts')"
        :class="{ active: scriptsOpen }"
        :disabled="!workspace.rootPath"
        @click="toggleScripts"
      >
        <Package :size="18" :stroke-width="1.75" />
        <span v-if="available && !scriptsOpen" class="dot" />
      </button>
      <!-- 终端入口：设置与 scripts 之间；点击展开/收起底部终端面板 -->
      <button
        class="item"
        type="button"
        :title="t('activity.terminal')"
        :class="{ active: terminalOpen }"
        @click="sessions.toggleSessions(workspace.rootPath)"
      >
        <TerminalSquare :size="18" :stroke-width="1.75" />
      </button>
      <button
        class="item"
        type="button"
        :title="t('activity.settings')"
        @click="ui.openSettings()"
      >
        <Settings :size="18" :stroke-width="1.75" />
      </button>
    </div>
  </aside>

  <Teleport to="body">
    <Transition name="popover">
      <div
        v-if="scriptsOpen"
        id="prism-scripts-pop"
        class="scripts-pop"
        :style="popStyle"
        role="dialog"
        aria-label="package.json scripts"
      >
        <PackageScriptsMenu variant="panel" @ran="scriptsOpen = false" />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.activity-bar {
  width: var(--activity-bar-width);
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: center;
  padding: 9px 0;
  background: var(--bg-header);
  border-right: 1px solid var(--border-subtle);
  box-shadow: inset -1px 0 0 color-mix(in srgb, var(--bg-app) 35%, transparent);
}

.group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
}

.item {
  position: relative;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-md);
  display: grid;
  place-items: center;
  color: var(--text-muted);
  transition: background var(--transition-fast), color var(--transition-fast);
}

.item:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.item.active {
  color: var(--accent);
  background: var(--bg-active);
  box-shadow: inset 2px 0 0 var(--accent),
    0 0 0 1px color-mix(in srgb, var(--accent) 10%, transparent);
}

.item:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.badge {
  position: absolute;
  top: 1px;
  right: -1px;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 700;
  line-height: 15px;
  text-align: center;
  background: var(--accent);
  color: var(--accent-fg, #fff);
  box-shadow: 0 0 0 2px var(--bg-header);
  pointer-events: none;
}

.dot {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 2px var(--bg-header);
  pointer-events: none;
}

.scripts-pop {
  position: fixed;
  z-index: 70;
  width: min(360px, calc(100vw - 56px));
  max-height: min(420px, 70vh);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  transform-origin: top left;
}

/* popover：scripts-pop 等浮层 */
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
  transform: scale(0.96) translateY(-4px);
}

/* dot：脚本可用点脉动（已在 :root 挂 prism-status-pulse） */
.dot {
  animation: prism-status-pulse 2.4s ease-in-out infinite;
}

/* badge：数字徽标入场（roving / 一致 pop） */
.badge {
  animation: prism-dot-pop 0.32s var(--ease-out) both;
}
</style>
