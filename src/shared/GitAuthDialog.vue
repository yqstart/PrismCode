<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "@/i18n";
import { PLAIN_INPUT_ATTRS } from "@/shared/plainInput";
import {
  registerGitAuthHandler,
  type GitAuthDialogOptions,
  type GitAuthResult,
} from "@/shared/gitAuthDialog";

const { t } = useI18n();
const visible = ref(false);
const title = ref("");
const remoteUrl = ref("");
const message = ref("");
const username = ref("");
const password = ref("");
const remember = ref(true);
const userRef = ref<HTMLInputElement | null>(null);
const passRef = ref<HTMLInputElement | null>(null);

let resolveFn: ((result: GitAuthResult | null) => void) | null = null;

async function open(options: GitAuthDialogOptions): Promise<GitAuthResult | null> {
  if (resolveFn) {
    resolveFn(null);
    resolveFn = null;
  }
  title.value = options.title ?? t("gitAuth.title");
  remoteUrl.value = options.remoteUrl?.trim() ?? "";
  message.value = options.message?.trim() ?? "";
  username.value = options.defaultUsername?.trim() ?? "";
  password.value = "";
  remember.value = true;
  visible.value = true;
  await nextTick();
  if (username.value) {
    passRef.value?.focus();
  } else {
    userRef.value?.focus();
  }
  return new Promise((resolve) => {
    resolveFn = resolve;
  });
}

function finish(result: GitAuthResult | null) {
  visible.value = false;
  const fn = resolveFn;
  resolveFn = null;
  fn?.(result);
}

function onConfirm() {
  const u = username.value.trim();
  if (!u || !password.value) return;
  finish({
    username: u,
    password: password.value,
    remember: remember.value,
  });
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
  registerGitAuthHandler(open);
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  registerGitAuthHandler(null);
  window.removeEventListener("keydown", onKeydown);
  if (resolveFn) finish(null);
});
</script>

<template>
  <div v-if="visible" class="overlay" @mousedown.self="onCancel">
    <div class="dialog" role="dialog" aria-modal="true" :aria-label="title">
      <h3 class="title">{{ title }}</h3>
      <p v-if="remoteUrl" class="remote" :title="remoteUrl">{{ remoteUrl }}</p>
      <p v-if="message" class="hint">{{ message }}</p>

      <label class="label">{{ t("gitAuth.username") }}</label>
      <input
        ref="userRef"
        v-model="username"
        v-bind="PLAIN_INPUT_ATTRS"
        class="ui-input"
        type="text"
        name="prism-git-user"
        autocomplete="username"
        :placeholder="t('gitAuth.usernamePlaceholder')"
        @keydown.enter.prevent="passRef?.focus()"
      />

      <label class="label">{{ t("gitAuth.password") }}</label>
      <input
        ref="passRef"
        v-model="password"
        v-bind="PLAIN_INPUT_ATTRS"
        class="ui-input"
        type="password"
        name="prism-git-pass"
        autocomplete="current-password"
        :placeholder="t('gitAuth.passwordPlaceholder')"
        @keydown.enter.prevent="onConfirm"
      />

      <label class="remember">
        <input v-model="remember" type="checkbox" />
        {{ t("gitAuth.remember") }}
      </label>

      <div class="actions">
        <button type="button" class="btn ghost" @click="onCancel">{{ t("common.cancel") }}</button>
        <button
          type="button"
          class="btn primary"
          :disabled="!username.trim() || !password"
          @click="onConfirm"
        >
          {{ t("gitAuth.login") }}
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
  width: min(420px, 100%);
  animation: prism-dialog-in var(--transition-normal) var(--ease-out);
  padding: 18px 18px 14px;
  border-radius: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.remote {
  margin: 0;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hint {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
  line-height: 1.4;
  white-space: pre-wrap;
}

.label {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.ui-input {
  height: 34px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-app);
  color: var(--text-primary);
  font-size: 13px;
}

.ui-input:focus {
  outline: none;
  border-color: var(--accent);
}

.remember {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
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
  color: var(--text-primary);
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
