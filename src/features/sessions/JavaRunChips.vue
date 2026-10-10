<script setup lang="ts">
// ==================== Java 运行配置芯片 ====================
// 终端面板顶栏的紧凑芯片：按 Maven/Gradle 模块列出可运行动作。
// 与 PackageScriptsMenu 是兄弟组件（同一个 .scripts-slot），点击后统一走
// java store 的启动计划，再由 sessions store 决定复用终端还是新开。
import { computed } from "vue";
import { AlertTriangle, Bug, Coffee, Package, Play, Refresh, RotateLeft } from "reicon-vue";
import { useI18n } from "@/i18n";
import { runActionOf, type JavaRunAction } from "@/shared/javaRun";
import { useDebugStore } from "@/stores/debug";
import { useJavaStore, type RunConfiguration } from "@/stores/java";
import { useSessionsStore } from "@/stores/sessions";

const { t } = useI18n();
const java = useJavaStore();
const debug = useDebugStore();
const sessions = useSessionsStore();

interface ChipGroup {
  module: string;
  actions: Partial<Record<JavaRunAction, RunConfiguration>>;
}

/** 模块 → 动作 → 配置。模块顺序沿用后端生成顺序（根在首位） */
const groups = computed<ChipGroup[]>(() => {
  const byModule = new Map<string, ChipGroup>();
  for (const configuration of java.runConfigurations) {
    const action = runActionOf(configuration);
    if (!action) continue;
    let group = byModule.get(configuration.module);
    if (!group) {
      group = { module: configuration.module, actions: {} };
      byModule.set(configuration.module, group);
    }
    // 同一动作只留第一条：生成层已按模块去重，这里防的是项目层覆盖出的重复项
    group.actions[action] ??= configuration;
  }
  return [...byModule.values()];
});

const chips = computed(() =>
  groups.value.map((group) => ({
    module: group.module,
    label: group.module === "." || !group.module ? t("run.group.root") : group.module,
    test: group.actions.test,
    package: group.actions.package,
    clean: group.actions.clean,
    run: group.actions.run,
    // 调试按钮跟着模块里最贴近「启动进程」的那条配置走
    debug: group.actions.run ?? group.actions.test,
  })),
);

const diagnostics = computed(() => java.runDiagnostics.map((item) => item.message));

async function onLaunch(configuration: RunConfiguration | undefined, debugMode: boolean) {
  if (!configuration) return;
  if (!debugMode) {
    await java.launchConfiguration(configuration.id, false);
    return;
  }
  // 调试走 DAP：先把面板切到调试视图，再让 debug store 起目标并 attach
  sessions.showDebug();
  await debug.start(configuration.id);
}
</script>

<template>
  <div v-if="chips.length" class="run-chips">
    <span class="group-mark" :title="t('maven.module.label')">
      <Coffee weight="Filled" :size="12" />
    </span>
    <div
      v-for="group in chips"
      :key="group.module"
      class="group"
      :title="group.module === '.' ? t('run.group.root') : group.module"
    >
      <span class="group-label">{{ group.label }}</span>
      <button
        v-if="group.test"
        type="button"
        class="chip"
        :title="`${t('run.action.test')} · ${group.label}`"
        @click="onLaunch(group.test, false)"
      >
        {{ t("run.action.test") }}
      </button>
      <button
        v-if="group.package"
        type="button"
        class="chip"
        :title="`${t('run.action.package')} · ${group.label}`"
        @click="onLaunch(group.package, false)"
      >
        <Package weight="Filled" :size="11" />
        {{ t("run.action.package") }}
      </button>
      <button
        v-if="group.clean"
        type="button"
        class="chip"
        :title="`${t('run.action.clean')} · ${group.label}`"
        @click="onLaunch(group.clean, false)"
      >
        <RotateLeft weight="Filled" :size="11" />
        {{ t("run.action.clean") }}
      </button>
      <button
        v-if="group.run"
        type="button"
        class="chip"
        :title="`${t('run.action.run')} · ${group.label}`"
        @click="onLaunch(group.run, false)"
      >
        <Play weight="Filled" :size="11" />
        {{ t("run.action.run") }}
      </button>
      <button
        v-if="group.debug"
        type="button"
        class="chip"
        :title="`${t('run.action.debug')} · ${group.label}`"
        @click="onLaunch(group.debug, true)"
      >
        <Bug weight="Filled" :size="11" />
        {{ t("run.action.debug") }}
      </button>
    </div>
    <button
      v-if="diagnostics.length"
      type="button"
      class="chip warn"
      :title="diagnostics.join('\n')"
    >
      <AlertTriangle weight="Filled" :size="11" />
      {{ diagnostics.length }}
    </button>
    <button
      type="button"
      class="chip icon"
      :title="t('run.refresh')"
      :disabled="java.runLoading"
      @click="java.refreshRunConfigurations()"
    >
      <Refresh weight="Filled" :size="11" :class="{ spin: java.runLoading }" />
    </button>
  </div>
</template>

<style scoped>
.run-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.run-chips::-webkit-scrollbar {
  display: none;
  height: 0;
}

.group-mark {
  display: grid;
  place-items: center;
  color: var(--text-muted);
  flex-shrink: 0;
}

.group {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.group-label {
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-muted);
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-app);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}

.chip:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}

.chip:disabled {
  opacity: 0.5;
}

.chip.warn {
  color: var(--warning);
  border-color: var(--warning);
}

.chip.icon {
  padding: 4px 6px;
}

.spin {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
