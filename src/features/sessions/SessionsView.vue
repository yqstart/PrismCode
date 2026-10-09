<script setup lang="ts">
import { ChevronDown, Plus, TerminalSquare, X } from "lucide-vue-next";
import { storeToRefs } from "pinia";
import { onMounted, watch } from "vue";
import JavaRunChips from "@/features/sessions/JavaRunChips.vue";
import LocalTerminal from "@/features/sessions/LocalTerminal.vue";
import PackageScriptsMenu from "@/features/sessions/PackageScriptsMenu.vue";
import { useJavaStore } from "@/stores/java";
import { usePackageScriptsStore } from "@/stores/packageScripts";
import { useSessionsStore } from "@/stores/sessions";
import { useWorkspaceStore } from "@/stores/workspace";
import { useI18n } from "@/i18n";

const { t } = useI18n();
const sessions = useSessionsStore();
const workspace = useWorkspaceStore();
const pkg = usePackageScriptsStore();
const java = useJavaStore();
const { localTerminals, activeLocalId } = storeToRefs(sessions);
// 勾选展示到顶栏的脚本（勾选集合为空时整槽隐藏）
const { pinnedScripts } = storeToRefs(pkg);

// 顶栏芯片只在面板可见时有意义：打开面板与切换工作区时各重算一次运行配置
onMounted(() => {
  void java.refreshRunConfigurations();
});
watch(
  () => workspace.rootPath,
  () => {
    void java.refreshRunConfigurations();
  },
);

function onAddLocal() {
  sessions.addLocalTerminal(workspace.rootPath);
}
</script>

<template>
  <div class="sessions">
    <!-- 本地终端顶栏 -->
    <header class="subtabs">
      <button
        v-for="term in localTerminals"
        :key="term.id"
        type="button"
        class="subtab"
        :class="{ active: term.id === activeLocalId }"
        :title="term.title"
        @click="sessions.activateLocal(term.id)"
      >
        <span>{{ term.title }}</span>
        <span
          class="close"
          :title="t('common.close')"
          @click.stop="sessions.closeLocalTerminal(term.id)"
        >
          <X :size="12" />
        </span>
      </button>
      <button
        type="button"
        class="add"
        :title="t('sessions.newLocalTitle')"
        @click="onAddLocal"
      >
        <Plus :size="14" />
      </button>
      <div v-if="pinnedScripts.length || java.runConfigurations.length" class="scripts-slot">
        <JavaRunChips />
        <PackageScriptsMenu v-if="pinnedScripts.length" variant="compact" />
      </div>
      <button
        type="button"
        class="collapse"
        :title="t('sessions.collapsePanel')"
        @click="sessions.hideSessions()"
      >
        <ChevronDown :size="14" />
      </button>
    </header>

    <div class="body">
      <LocalTerminal
        v-for="term in localTerminals"
        v-show="term.id === activeLocalId"
        :key="term.id"
        :session-id="term.id"
        :cwd="term.cwd"
        :active="term.id === activeLocalId"
      />
      <div v-if="!localTerminals.length" class="empty">
        <TerminalSquare :size="28" :stroke-width="1.5" class="empty-icon" />
        <p>{{ t("sessions.localEmpty") }}</p>
        <button type="button" class="cta" @click="onAddLocal">
          {{ t("sessions.newTerminal") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sessions {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-app);
}

.subtabs {
  height: 34px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-panel);
  min-width: 0;
}

.subtab {
  height: 26px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 10px;
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 12px;
  min-width: 0;
  max-width: 220px;
}

.subtab > span:first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subtab:hover {
  color: var(--text-primary);
  background: var(--accent-soft);
}

.subtab.active {
  color: var(--accent);
  background: var(--accent-soft);
}

.subtab .close {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  border-radius: 4px;
  display: grid;
  place-items: center;
  opacity: 0.55;
}

.subtab .close:hover {
  opacity: 1;
  background: var(--bg-app);
}

.add {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--text-muted);
}

.add:hover {
  color: var(--accent);
  background: var(--accent-soft);
}

/* 勾选脚本快捷芯片：推至顶栏右侧，横向滚动 */
.scripts-slot {
  flex: 1;
  min-width: 0;
  margin-left: 4px;
  display: flex;
  justify-content: flex-end;
  overflow: hidden;
}

/* 收起面板按钮：顶栏最右（无脚本芯片时靠 margin-left:auto 推右） */
.collapse {
  width: 26px;
  height: 26px;
  margin-left: auto;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--text-muted);
  flex-shrink: 0;
}

.collapse:hover {
  color: var(--text-primary);
  background: var(--accent-soft);
}

.body {
  flex: 1;
  min-height: 0;
  position: relative;
}

.empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-secondary);
  text-align: center;
  padding: 24px;
}

.empty-icon {
  opacity: 0.7;
}

.cta {
  height: 32px;
  padding: 0 14px;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--accent-fg);
  font-weight: 600;
}
</style>
