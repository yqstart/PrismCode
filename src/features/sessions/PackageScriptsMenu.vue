<script setup lang="ts">
import { nextTick, ref } from "vue";
import { Check, Play, Plus, Refresh, Trash2, X } from "reicon-vue";
import { storeToRefs } from "pinia";
import { useI18n } from "@/i18n";
import { usePackageScriptsStore } from "@/stores/packageScripts";

const props = defineProps<{
  /** compact：终端顶栏横滑；panel：活动栏弹层列表 */
  variant?: "compact" | "panel";
}>();

const emit = defineEmits<{
  ran: [];
}>();

const { t } = useI18n();
const pkg = usePackageScriptsStore();
const {
  allScripts,
  pinned,
  pinnedScripts,
  manager,
  packageName,
  loading,
  hasPackageJson,
} = storeToRefs(pkg);

const adding = ref(false);
const customName = ref("");
const customCommand = ref("");
const customError = ref("");
const nameInput = ref<HTMLInputElement | null>(null);

async function onRun(name: string, custom = false) {
  await pkg.runScript(name, custom);
  emit("ran");
}

async function onRefresh() {
  await pkg.refresh(true);
}

async function onStartAdd() {
  adding.value = true;
  customError.value = "";
  await nextTick();
  nameInput.value?.focus();
}

function onCancelAdd() {
  adding.value = false;
  customName.value = "";
  customCommand.value = "";
  customError.value = "";
}

function onSaveCustom() {
  const result = pkg.saveCustomScript(customName.value, customCommand.value);
  if (result === "saved") {
    onCancelAdd();
    return;
  }
  customError.value = t(`packageScripts.${result}`);
}

function onDeleteCustom(name: string) {
  pkg.deleteCustomScript(name);
}
</script>

<template>
  <div class="scripts" :data-variant="props.variant ?? 'panel'">
    <header class="head">
      <div class="title-wrap">
        <span class="title">{{ t("packageScripts.title") }}</span>
        <span v-if="packageName" class="pkg">{{ packageName }}</span>
        <span v-if="hasPackageJson" class="pm">{{ manager }}</span>
      </div>
      <div class="head-actions">
        <button
          v-if="props.variant !== 'compact'"
          type="button"
          class="icon-btn"
          :title="t('packageScripts.addCustom')"
          @click="onStartAdd"
        >
          <Plus weight="Filled" :size="14" />
        </button>
        <button
          type="button"
          class="icon-btn"
          :title="t('packageScripts.refresh')"
          :disabled="loading"
          @click="onRefresh"
        >
          <Refresh weight="Filled" :size="13" :class="{ spin: loading }" />
        </button>
      </div>
    </header>

    <form v-if="adding && props.variant !== 'compact'" class="custom-form" @submit.prevent="onSaveCustom">
      <div class="custom-fields">
        <input
          ref="nameInput"
          v-model="customName"
          class="custom-input"
          type="text"
          autocomplete="off"
          :placeholder="t('packageScripts.customNamePlaceholder')"
          @keydown.esc="onCancelAdd"
        />
        <input
          v-model="customCommand"
          class="custom-input"
          type="text"
          autocomplete="off"
          :placeholder="t('packageScripts.customCommandPlaceholder')"
          @keydown.esc="onCancelAdd"
        />
      </div>
      <div class="custom-form-foot">
        <span v-if="customError" class="custom-error">{{ customError }}</span>
        <span class="custom-form-actions">
          <button
            type="button"
            class="form-btn"
            :title="t('packageScripts.cancelCustom')"
            @click="onCancelAdd"
          >
            <X weight="Filled" :size="13" />
          </button>
          <button
            type="submit"
            class="form-btn primary"
            :title="t('packageScripts.saveCustom')"
            :disabled="!customName.trim() || !customCommand.trim()"
          >
            <Check weight="Filled" :size="13" />
          </button>
        </span>
      </div>
    </form>

    <div v-if="loading && !allScripts.length" class="hint">{{ t("packageScripts.loading") }}</div>
    <div v-else-if="!allScripts.length && !hasPackageJson" class="hint">{{ t("packageScripts.noPackageJson") }}</div>
    <div v-else-if="!allScripts.length" class="hint">{{ t("packageScripts.noScripts") }}</div>
    <div v-else class="list">
      <div
        v-for="item in props.variant === 'compact' ? pinnedScripts : allScripts"
        :key="`${item.custom ? 'custom' : 'package'}:${item.name}`"
        class="row"
        :class="{ custom: item.custom }"
      >
        <button
          type="button"
          class="play-btn"
          :title="t('packageScripts.run', { name: item.name })"
          @click="onRun(item.name, item.custom)"
        >
          <Play weight="Filled" :size="12" class="play" />
        </button>
        <input
          v-if="props.variant !== 'compact'"
          type="checkbox"
          class="pin-check"
          :checked="pinned.includes(item.name)"
          :title="t('packageScripts.pinToTerminal')"
          :aria-label="t('packageScripts.pinToTerminal')"
          @change="pkg.togglePinned(item.name)"
        />
        <button
          type="button"
          class="run-main"
          :title="item.script"
          @click="onRun(item.name, item.custom)"
        >
          <span class="name-wrap">
            <span class="name">{{ item.name }}</span>
            <span v-if="item.custom" class="custom-mark">{{ t("packageScripts.custom") }}</span>
          </span>
          <span class="cmd">{{ item.script }}</span>
        </button>
        <button
          v-if="props.variant !== 'compact' && item.custom"
          type="button"
          class="delete-btn"
          :title="t('packageScripts.deleteCustom')"
          :aria-label="t('packageScripts.deleteCustom')"
          @click="onDeleteCustom(item.name)"
        >
          <Trash2 weight="Filled" :size="13" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scripts {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-subtle);
}

.title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.pkg {
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pm {
  flex-shrink: 0;
  font-size: 10px;
  font-family: var(--font-mono);
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
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
  color: var(--text-primary);
  background: var(--accent-soft);
}

.icon-btn:disabled {
  opacity: 0.5;
}

.spin {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.hint {
  padding: 14px 12px;
  font-size: 12px;
  color: var(--text-muted);
}

.custom-form {
  display: grid;
  gap: 6px;
  margin: 8px 10px 4px;
  padding: 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg-app) 55%, transparent);
}

.custom-fields {
  display: grid;
  grid-template-columns: minmax(0, 0.72fr) minmax(0, 1.28fr);
  gap: 6px;
}

.custom-input {
  width: 100%;
  min-width: 0;
  height: 26px;
  padding: 0 7px;
  border: 1px solid var(--border-subtle);
  border-radius: 5px;
  outline: none;
  background: var(--bg-app);
  color: var(--text-primary);
  font-size: 11px;
  font-family: var(--font-mono);
}

.custom-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 16%, transparent);
}

.custom-form-foot {
  min-height: 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.custom-error {
  min-width: 0;
  color: var(--danger);
  font-size: 10px;
  line-height: 1.3;
}

.custom-form-actions {
  display: flex;
  gap: 4px;
  margin-left: auto;
}

.form-btn,
.delete-btn {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  border-radius: 5px;
  color: var(--text-muted);
}

.form-btn:hover {
  color: var(--text-primary);
  background: var(--accent-soft);
}

.form-btn.primary {
  color: var(--accent);
}

.form-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  overflow: auto;
  max-height: 320px;
}

.row {
  width: 100%;
  display: grid;
  grid-template-columns: 16px 16px minmax(72px, auto) minmax(0, 1fr) 24px;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
}

.row:hover {
  background: var(--accent-soft);
}

.play-btn {
  display: grid;
  place-items: center;
  width: 16px;
  height: 20px;
  border-radius: 4px;
  color: var(--accent);
  flex-shrink: 0;
}

.play-btn:hover {
  background: var(--accent-soft);
}

.play {
  display: block;
}

/* 勾选「展示到终端顶栏」 */
.pin-check {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  accent-color: var(--accent);
  cursor: pointer;
}

.run-main {
  grid-column: 3 / 5;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(72px, auto) minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 0;
  text-align: left;
  color: var(--text-primary);
}

.run-main:hover .name {
  color: var(--accent);
}

.name-wrap {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 5px;
}

.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  font-family: var(--font-mono);
}

.custom-mark {
  flex-shrink: 0;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 9px;
  font-family: var(--font-ui);
  font-weight: 500;
}

.cmd {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}

.delete-btn {
  grid-column: 5;
  color: var(--text-muted);
}

.delete-btn:hover {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 14%, transparent);
}

/* 终端顶栏：横向滚动芯片 */
.scripts[data-variant="compact"] {
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 0;
  border: none;
  min-height: 0;
}

.scripts[data-variant="compact"] .head {
  border: none;
  padding: 0;
  gap: 6px;
  flex-shrink: 0;
}

.scripts[data-variant="compact"] .pkg,
.scripts[data-variant="compact"] .hint {
  display: none;
}

.scripts[data-variant="compact"] .list {
  flex-direction: row;
  flex-wrap: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  max-height: none;
  padding: 0;
  gap: 4px;
  /* 顶栏高度紧，原生横向条会压在芯片上；保留触控板/滚轮横滑 */
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.scripts[data-variant="compact"] .list::-webkit-scrollbar {
  display: none;
  height: 0;
}

.scripts[data-variant="compact"] .row {
  width: auto;
  grid-template-columns: 16px minmax(0, auto);
  padding: 4px 8px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-app);
  white-space: nowrap;
}

.scripts[data-variant="compact"] .play-btn {
  grid-column: 1;
}

.scripts[data-variant="compact"] .run-main {
  grid-column: 2;
  display: block;
}

.scripts[data-variant="compact"] .name-wrap {
  display: inline-flex;
}

.scripts[data-variant="compact"] .cmd {
  display: none;
}

.scripts[data-variant="compact"] .name {
  font-size: 11px;
  font-weight: 500;
}
</style>
