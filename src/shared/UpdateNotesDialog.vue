<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { renderMarkdown } from "@/features/editor/markdown/preview";
import {
  registerUpdateNotesHandler,
  type UpdateNotesDialogOptions,
  type UpdateNotesAction,
} from "@/shared/updateNotesDialog";
import { useI18n } from "@/i18n";

const { t } = useI18n();

const open = ref(false);
const version = ref("");
const notesMarkdown = ref("");
const showInstallActions = ref(false);
let resolver: ((value: UpdateNotesAction | null) => void) | null = null;

const notesHtml = computed(() => {
  const md = notesMarkdown.value.trim();
  if (!md) {
    return `<p class="empty">${t("update.notesEmpty")}</p>`;
  }
  // 走 preview.ts 的安全封装（raw HTML 转义 + 危险协议过滤），
  // 不裸调 marked.parse：notesMarkdown 可能来自 GitHub Release body
  // （网络不可信输入），裸渲染 = v-html 注入面。
  return renderMarkdown(md);
});

function close(action: UpdateNotesAction | null) {
  open.value = false;
  resolver?.(action);
  resolver = null;
}

async function show(
  options: UpdateNotesDialogOptions,
): Promise<UpdateNotesAction | null> {
  version.value = options.version;
  notesMarkdown.value = options.notesMarkdown;
  showInstallActions.value = options.showInstallActions === true;
  open.value = true;
  return new Promise<UpdateNotesAction | null>((resolve) => {
    resolver = resolve;
  });
}

function onBackdrop(event: MouseEvent) {
  if (event.target === event.currentTarget) {
    close(showInstallActions.value ? "later" : "close");
  }
}

function onKeydown(event: KeyboardEvent) {
  if (!open.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    close(showInstallActions.value ? "later" : "close");
  }
}

onMounted(() => {
  registerUpdateNotesHandler(show);
  window.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  registerUpdateNotesHandler(null);
  window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div
    v-if="open"
    class="overlay"
    role="dialog"
    aria-modal="true"
    :aria-label="t('update.notesTitle', { version })"
    @click="onBackdrop"
  >
    <div class="dialog" @click.stop>
      <header class="head">
        <h3 class="title">{{ t("update.notesTitle", { version }) }}</h3>
        <button
          type="button"
          class="close-btn"
          :title="t('common.close')"
          @click="close(showInstallActions ? 'later' : 'close')"
        >
          ×
        </button>
      </header>
      <div class="body prose" v-html="notesHtml" />
      <footer class="foot">
        <template v-if="showInstallActions">
          <button
            type="button"
            class="btn ghost"
            @click="close('later')"
          >
            {{ t("update.later") }}
          </button>
          <button
            type="button"
            class="btn primary"
            @click="close('install')"
          >
            {{ t("update.installNow") }}
          </button>
        </template>
        <button
          v-else
          type="button"
          class="btn primary"
          @click="close('close')"
        >
          {{ t("dialog.ok") }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 86;
  display: grid;
  place-items: center;
  background: var(--bg-overlay);
  backdrop-filter: blur(4px);
  animation: prism-overlay-in var(--transition-normal) var(--ease-out);
  padding: 24px;
}

.dialog {
  width: min(560px, 100%);
  animation: prism-dialog-in var(--transition-normal) var(--ease-out);
  max-height: min(78vh, 640px);
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--border-subtle);
}

.title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.close-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  font-size: 18px;
  line-height: 1;
  color: var(--text-muted);
}

.close-btn:hover {
  background: var(--accent-soft);
  color: var(--text-primary);
}

.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 18px 16px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-secondary);
}

.foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 16px 14px;
  border-top: 1px solid var(--border-subtle);
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
  border: 1px solid var(--border-subtle);
}

.btn.ghost:hover {
  color: var(--text-primary);
  border-color: var(--border-strong, var(--border-subtle));
}

.btn.primary {
  color: var(--accent-fg);
  background: var(--accent);
}

.btn.primary:hover {
  filter: brightness(1.06);
}

.body :deep(h2) {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.body :deep(h3) {
  margin: 14px 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.body :deep(p) {
  margin: 0 0 8px;
}

.body :deep(ul) {
  margin: 0 0 10px;
  padding-left: 1.25em;
}

.body :deep(li) {
  margin: 4px 0;
}

.body :deep(.empty) {
  color: var(--text-muted);
  font-style: italic;
}
</style>
