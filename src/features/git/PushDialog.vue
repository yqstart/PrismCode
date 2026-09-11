<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { gitUnpushedCommits, type GitCommitInfo } from "@/shared/gitApi";
import { registerPushDialogHandler } from "@/shared/gitDialogs";
import { useGitStore } from "@/stores/git";
import { useWorkspaceStore } from "@/stores/workspace";
import { useI18n } from "@/i18n";

const { t } = useI18n();
const visible = ref(false);
const force = ref(false);
const loading = ref(false);
const commits = ref<GitCommitInfo[]>([]);
const workspace = useWorkspaceStore();
const git = useGitStore();
const { snapshot } = storeToRefs(git);

let resolveFn: ((r: { force: boolean } | null) => void) | null = null;
/** 加载序号：连续两次 open 时旧加载结果作废，不覆盖新对话框状态 */
let loadSeq = 0;

async function open(): Promise<{ force: boolean } | null> {
  if (resolveFn) {
    resolveFn(null);
    resolveFn = null;
  }
  const seq = ++loadSeq;
  force.value = false;
  commits.value = [];
  visible.value = true;
  loading.value = true;
  await nextTick();
  try {
    if (workspace.rootPath) {
      const result = await gitUnpushedCommits(workspace.rootPath, 40);
      // 期间又触发了新的 open：本次作废，直接以 null 结束（等价取消），
      // 不覆盖新对话框的 commits/loading，也不再注册 resolveFn
      if (seq !== loadSeq) return null;
      commits.value = result;
    }
  } catch {
    if (seq === loadSeq) commits.value = [];
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
  return new Promise((resolve) => {
    resolveFn = resolve;
  });
}

function finish(result: { force: boolean } | null) {
  visible.value = false;
  const fn = resolveFn;
  resolveFn = null;
  fn?.(result);
}

function onConfirm() {
  if (force.value && !window.confirm(t("push.forceConfirm"))) {
    return;
  }
  finish({ force: force.value });
}

function onCancel() {
  finish(null);
}

function onKeydown(event: KeyboardEvent) {
  if (!visible.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    onCancel();
  }
}

onMounted(() => {
  registerPushDialogHandler(open);
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  registerPushDialogHandler(null);
  window.removeEventListener("keydown", onKeydown);
  if (resolveFn) finish(null);
});
</script>

<template>
  <div v-if="visible" class="overlay" @mousedown.self="onCancel">
    <div class="dialog" role="dialog" aria-modal="true" :aria-label="t('push.title')">
      <h3 class="title">{{ t("push.title") }}</h3>
      <p class="meta">
        {{ snapshot.branch ?? "—" }}
        <template v-if="snapshot.upstream"> → {{ snapshot.upstream }}</template>
        <span v-if="snapshot.ahead" class="ahead">↑{{ snapshot.ahead }}</span>
      </p>

      <div class="list">
        <div v-if="loading" class="empty">{{ t("push.loading") }}</div>
        <div v-else-if="!commits.length" class="empty">{{ t("push.empty") }}</div>
        <div v-for="c in commits" :key="c.id" class="row" :title="c.id">
          <span class="id">{{ c.id.slice(0, 7) }}</span>
          <span class="summary">{{ c.summary }}</span>
          <span class="author">{{ c.author }}</span>
        </div>
      </div>

      <label class="check">
        <input v-model="force" type="checkbox" />
        {{ t("push.force") }}
      </label>

      <div class="actions">
        <button type="button" class="btn ghost" @click="onCancel">
          {{ t("dialog.cancel") }}
        </button>
        <button
          type="button"
          class="btn primary"
          :disabled="!commits.length && !force"
          @click="onConfirm"
        >
          {{ t("push.push") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  animation: prism-overlay-in var(--transition-normal) var(--ease-out);
  padding: 24px;
}
.dialog {
  width: min(520px, 100%);
  animation: prism-dialog-in var(--transition-normal) var(--ease-out);
  max-height: min(70vh, 640px);
  padding: 18px;
  border-radius: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.meta {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
}
.ahead {
  margin-left: 8px;
  color: var(--accent);
  font-weight: 600;
}
.list {
  flex: 1;
  min-height: 120px;
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-app);
}
.empty {
  padding: 24px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}
.row {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  font-size: 12px;
  border-bottom: 1px solid var(--border-subtle);
}
.row:last-child {
  border-bottom: none;
}
.id {
  font-family: var(--font-mono);
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.author {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  text-align: right;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--danger);
  cursor: pointer;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.btn {
  height: 32px;
  padding: 0 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
}
.btn.ghost {
  color: var(--text-secondary);
}
.btn.ghost:hover {
  background: var(--accent-soft);
}
.btn.primary {
  background: var(--accent);
  color: var(--accent-fg);
}
.btn.primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
