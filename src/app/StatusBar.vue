<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { THEME_LABELS, THEME_ORDER } from "@/shared/themes";
import type { ThemeId } from "@/shared/types";
import { useBreadcrumbsStore } from "@/stores/breadcrumbs";
import { useEditorStore } from "@/stores/editor";
import { useJavaStore } from "@/stores/java";
import { useUiStore } from "@/stores/ui";
import { useGitStore } from "@/stores/git";
import { useSettingsStore } from "@/stores/settings";
import { useI18n } from "@/i18n";

const { t } = useI18n();
const settings = useSettingsStore();
const editor = useEditorStore();
const breadcrumbs = useBreadcrumbsStore();
const git = useGitStore();
const javaStore = useJavaStore();
const ui = useUiStore();
const { editor: editorPrefs, theme } = storeToRefs(settings);
const { activeTab } = storeToRefs(editor);
const { snapshot } = storeToRefs(git);

const themeMenuOpen = ref(false);
const javaMenuOpen = ref(false);

/** 状态栏时钟（IDEA 右下角 widget）：分钟精度，每 30 秒对齐刷新 */
const now = ref(new Date());
let clockTimer: number | undefined;
const clock = computed(() => {
  const hh = String(now.value.getHours()).padStart(2, "0");
  const mm = String(now.value.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
});
const showJavaPill = computed(
  () =>
    activeTab.value?.language === "Java" ||
    (activeTab.value ? /\.java$/i.test(activeTab.value.path) : false) ||
    javaStore.status.state !== "stopped",
);
const javaStatusLabel = computed(() => t(`java.status.${javaStore.status.state}`));

const lang = computed(() => activeTab.value?.language ?? "—");
const cursor = computed(() => activeTab.value?.cursor ?? { line: 1, column: 1 });
const dirty = computed(() => activeTab.value?.dirty ?? false);

const themeLabel = computed(() => THEME_LABELS[theme.value]);

const themeOptions = computed(() =>
  THEME_ORDER.map((id) => ({ id, label: THEME_LABELS[id] })),
);

function toggleThemeMenu(event: MouseEvent) {
  event.stopPropagation();
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

function toggleJavaMenu(event: MouseEvent) {
  event.stopPropagation();
  themeMenuOpen.value = false;
  javaMenuOpen.value = !javaMenuOpen.value;
}

async function runJavaAction(action: "start" | "stop" | "rebuild" | "logs" | "endpoints" | "settings") {
  javaMenuOpen.value = false;
  if (action === "start") await javaStore.start();
  else if (action === "stop") await javaStore.stop();
  else if (action === "rebuild") await javaStore.rebuildIndex();
  else if (action === "logs") await javaStore.viewLogs();
  else if (action === "endpoints") await javaStore.openSpringEndpoints();
  else ui.openSettings("java");
}

function onDocClick() {
  themeMenuOpen.value = false;
  javaMenuOpen.value = false;
}

onMounted(() => {
  window.addEventListener("click", onDocClick);
  clockTimer = window.setInterval(() => {
    now.value = new Date();
  }, 30_000);
});

onBeforeUnmount(() => {
  window.removeEventListener("click", onDocClick);
  if (clockTimer !== undefined) window.clearInterval(clockTimer);
});
</script>

<template>
  <footer class="status-bar">
    <div class="left">
      <!-- IDEA New UI：navigation bar（路径 > 符号）位于状态栏左下 -->
      <nav
        v-if="breadcrumbs.visible"
        class="crumbs"
        :aria-label="t('editor.breadcrumbs')"
      >
        <template
          v-for="(seg, index) in breadcrumbs.pathCrumbs"
          :key="`p-${index}-${seg.name}`"
        >
          <span v-if="index > 0" class="crumb-sep">&gt;</span>
          <button
            type="button"
            class="crumb"
            :class="{
              'crumb-file': index === breadcrumbs.pathCrumbs.length - 1,
            }"
            :title="seg.path"
            @click="breadcrumbs.reveal(seg.path)"
          >
            {{ seg.name }}
          </button>
        </template>
        <template
          v-for="(crumb, index) in breadcrumbs.symbolCrumbs"
          :key="`s-${index}-${crumb.offset}`"
        >
          <span class="crumb-sep">&gt;</span>
          <button
            type="button"
            class="crumb"
            :title="crumb.name"
            @click="breadcrumbs.jump(crumb)"
          >
            {{ crumb.name }}
          </button>
        </template>
      </nav>
      <span v-else class="ok">{{ t("status.ready") }}</span>
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
      <div v-if="showJavaPill" class="java-switch" @click.stop>
        <button type="button" class="java-btn" @click="toggleJavaMenu">
          {{ javaStatusLabel }}
        </button>
        <div v-if="javaMenuOpen" class="java-menu" role="menu">
          <button type="button" @click="runJavaAction('start')">{{ t("java.action.start") }}</button>
          <button type="button" @click="runJavaAction('stop')">{{ t("java.action.stop") }}</button>
          <button type="button" @click="runJavaAction('rebuild')">{{ t("java.action.rebuildIndex") }}</button>
          <button type="button" @click="runJavaAction('logs')">{{ t("java.action.viewLogs") }}</button>
          <button type="button" @click="runJavaAction('endpoints')">{{ t("spring.endpoints.open") }}</button>
          <button type="button" @click="runJavaAction('settings')">{{ t("java.action.openSettings") }}</button>
        </div>
      </div>
      <span v-if="showJavaPill" class="sep">·</span>
      <span>Ln {{ cursor.line }}, Col {{ cursor.column }}</span>
      <span class="sep">·</span>
      <span class="meta">UTF-8</span>
      <span class="sep">·</span>
      <span>Spaces: {{ editorPrefs.tabSize }}</span>
      <span class="sep">·</span>
      <span class="meta">{{ lang }}</span>
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
      <span class="clock">{{ clock }}</span>
    </div>
  </footer>
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

.meta {
  flex-shrink: 0;
}

/* ==================== 导航栏面包屑（IDEA New UI：状态栏左下） ==================== */
.crumbs {
  display: flex;
  align-items: center;
  gap: 1px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.crumb {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  line-height: 1.2;
  padding: 1px 4px;
  border-radius: 4px;
  cursor: pointer;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.crumb:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 当前文件段加重（与符号链区分） */
.crumb-file {
  color: var(--text-primary);
  font-weight: 500;
}

.crumb-sep {
  color: var(--text-muted);
  flex-shrink: 0;
}

/* 状态栏时钟（IDEA 右下角） */
.clock {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
}

.sep {
  color: var(--text-muted);
  flex-shrink: 0;
}

.dirty {
  color: var(--warning);
  flex-shrink: 0;
}

/* 冲突数也是状态栏可点 Widget：与其他 Widget 统一为 4px 圆角灰块，去掉下划线；
   红色语义保留，hover 只加块不改色 */
.conflict {
  color: var(--danger);
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;
  padding: 2px 6px;
  border-radius: 4px;
  transition: background var(--transition-fast) var(--ease-out);
}

.conflict:hover {
  background: var(--bg-hover);
}

.java-switch {
  position: relative;
}

.java-btn {
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--text-secondary);
  transition:
    background var(--transition-fast) var(--ease-out),
    color var(--transition-fast) var(--ease-out);
}

.java-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.java-menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  min-width: 160px;
  padding: 4px;
  border-radius: 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  z-index: 30;
  display: flex;
  flex-direction: column;
}

.java-menu button {
  text-align: left;
  padding: 6px 8px;
  border-radius: 4px;
  color: var(--text-primary);
}

.java-menu button:hover {
  background: var(--bg-hover);
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
