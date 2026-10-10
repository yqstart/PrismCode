<script setup lang="ts">
// ==================== IDEA 工具窗口条 ====================
// 主窗口左侧的竖条（IDEA New UI 40px stripe）：
//   上组 = 垂直工具窗口（Project / Commit），显示在编辑器左侧；
//   下组 = 水平工具窗口（Terminal / Problems / Debug），显示在编辑器下方。
// 选中态表达「该工具窗口正在显示」；点击显示，再点收起（IDEA 行为）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import {
  Bug,
  CircleAlert,
  Files,
  GitCommitHorizontal,
  History,
  Package,
  Server,
  TerminalSquare,
} from "lucide-vue-next";
import PackageScriptsMenu from "@/features/sessions/PackageScriptsMenu.vue";
import { useGitStore } from "@/stores/git";
import { useGitLogStore } from "@/stores/gitLog";
import { usePackageScriptsStore } from "@/stores/packageScripts";
import { useSessionsStore } from "@/stores/sessions";
import { useSettingsStore } from "@/stores/settings";
import { useSshStore } from "@/stores/ssh";
import { useWorkspaceStore } from "@/stores/workspace";
import { useI18n } from "@/i18n";
import type { BottomToolWindowId, LeftToolWindowId } from "@/shared/types";

const { t } = useI18n();
const settings = useSettingsStore();
const git = useGitStore();
const gitLog = useGitLogStore();
const pkg = usePackageScriptsStore();
const sessions = useSessionsStore();
const ssh = useSshStore();
const workspace = useWorkspaceStore();
const { layout } = storeToRefs(settings);
const { changedFileCount } = storeToRefs(git);
const { isFocused: logFocused } = storeToRefs(gitLog);
const { isFocused: sshFocused } = storeToRefs(ssh);
const { available } = storeToRefs(pkg);

/** 图标尺寸与描边沿用 IDEA New UI 大图标观感 */
const ICON_SIZE = 20;

const gitBadge = computed(() => {
  const n = changedFileCount.value;
  if (n <= 0) return "";
  return n > 99 ? "99+" : String(n);
});

const leftActive = computed(() => layout.value.left.active);
const bottomActive = computed(() => layout.value.bottom.active);

/** package.json scripts 弹层（暂作下组入口，后续并入运行工具窗口） */
const scriptsOpen = ref(false);
const scriptsBtn = ref<HTMLButtonElement | null>(null);
const popStyle = ref<Record<string, string>>({});

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

function toggleLeft(id: LeftToolWindowId) {
  if (leftActive.value === id) {
    settings.setLeftWindow(null);
    return;
  }
  settings.setLeftWindow(id);
  if (id === "commit" && workspace.rootPath) void git.scheduleRefresh();
}

/** Git Log 是编辑器标签而非工具窗口：这里只负责打开并刷新（对齐 IDEA ⌘9） */
function toggleLog() {
  scriptsOpen.value = false;
  gitLog.toggleLog();
  if (gitLog.open && workspace.rootPath) {
    void git.scheduleRefresh();
    void git.loadLog(100);
  }
}

/** SSH 远程同样是编辑器标签：按钮负责显示 / 隐藏（⌘J 语义，连接保活） */
function toggleSsh() {
  scriptsOpen.value = false;
  ssh.toggleSsh();
}

/** 底部工具窗口：终端走 sessions store（会话保活语义），问题/调试走布局状态 */
function toggleBottom(id: BottomToolWindowId) {
  scriptsOpen.value = false;
  if (id === "terminal") {
    if (bottomActive.value === "terminal") {
      sessions.hideSessions();
      return;
    }
    sessions.openSessions(workspace.rootPath);
    return;
  }
  settings.setBottomWindow(bottomActive.value === id ? null : id);
}
</script>

<template>
  <aside class="tool-window-bar" :aria-label="t('app.toolWindowBar')">
    <div class="tw-group">
      <button
        type="button"
        class="tw-item"
        :class="{ active: leftActive === 'project' }"
        :title="t('activity.explorer')"
        :aria-pressed="leftActive === 'project'"
        @click="toggleLeft('project')"
      >
        <Files :size="ICON_SIZE" :stroke-width="1.6" />
      </button>
      <button
        type="button"
        class="tw-item"
        :class="{ active: leftActive === 'commit' }"
        :title="
          gitBadge
            ? t('activity.commitWithChanges', { count: changedFileCount })
            : t('activity.commit')
        "
        :aria-pressed="leftActive === 'commit'"
        @click="toggleLeft('commit')"
      >
        <GitCommitHorizontal :size="ICON_SIZE" :stroke-width="1.6" />
        <span v-if="gitBadge" class="badge">{{ gitBadge }}</span>
      </button>
      <button
        type="button"
        class="tw-item"
        :class="{ active: logFocused }"
        :title="t('activity.gitLog')"
        :aria-pressed="logFocused"
        @click="toggleLog"
      >
        <History :size="ICON_SIZE" :stroke-width="1.6" />
      </button>
      <button
        type="button"
        class="tw-item"
        :class="{ active: sshFocused }"
        :title="t('activity.ssh')"
        :aria-pressed="sshFocused"
        @click="toggleSsh"
      >
        <Server :size="ICON_SIZE" :stroke-width="1.6" />
      </button>
    </div>

    <div class="tw-spacer" data-tauri-drag-region />

    <div class="tw-group">
      <button
        ref="scriptsBtn"
        type="button"
        class="tw-item"
        :class="{ active: scriptsOpen }"
        :title="t('activity.scripts')"
        :disabled="!workspace.rootPath"
        @click="toggleScripts"
      >
        <Package :size="ICON_SIZE" :stroke-width="1.6" />
        <span v-if="available && !scriptsOpen" class="dot" />
      </button>
      <button
        type="button"
        class="tw-item"
        :class="{ active: bottomActive === 'problems' }"
        :title="t('activity.problems')"
        :aria-pressed="bottomActive === 'problems'"
        @click="toggleBottom('problems')"
      >
        <CircleAlert :size="ICON_SIZE" :stroke-width="1.6" />
      </button>
      <button
        type="button"
        class="tw-item"
        :class="{ active: bottomActive === 'terminal' }"
        :title="t('activity.terminal')"
        :aria-pressed="bottomActive === 'terminal'"
        @click="toggleBottom('terminal')"
      >
        <TerminalSquare :size="ICON_SIZE" :stroke-width="1.6" />
      </button>
      <button
        type="button"
        class="tw-item"
        :class="{ active: bottomActive === 'debug' }"
        :title="t('activity.debug')"
        :aria-pressed="bottomActive === 'debug'"
        @click="toggleBottom('debug')"
      >
        <Bug :size="ICON_SIZE" :stroke-width="1.6" />
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
.tool-window-bar {
  width: var(--activity-bar-width);
  height: 100%;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 4px 0;
  background: var(--bg-header);
  border-right: 1px solid var(--border-subtle);
}

.tw-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: center;
}

/* 组间弹性留白：下组工具窗口（终端/问题/调试）贴 IDEA 条底部 */
.tw-spacer {
  flex: 1;
  min-height: 8px;
  width: 100%;
}

.tw-item {
  position: relative;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  display: grid;
  place-items: center;
  color: var(--text-secondary);
  transition: background var(--transition-fast), color var(--transition-fast);
}

/* IDEA ActionButton.hoverBackground：hover 为浅叠加块（不覆盖下方选中态） */
.tw-item:hover:not(:disabled):not(.active) {
  color: var(--text-primary);
  background: var(--bg-hover);
}

/* IDEA ToolWindow.Button：选中 = Blue6 实色块 + 白色图标（--accent/--accent-fg） */
.tw-item.active {
  color: var(--accent-fg);
  background: var(--accent);
}

.tw-item:disabled {
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
  animation: prism-dot-pop 0.32s var(--ease-out) both;
}

.tw-item.active .badge {
  background: var(--accent-fg, #fff);
  color: var(--accent);
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
  animation: prism-status-pulse 2.4s ease-in-out infinite;
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
</style>
