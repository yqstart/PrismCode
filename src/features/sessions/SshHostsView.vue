<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  Eye,
  EyeOff,
  Pencil,
  Plus,
  Server,
  Trash2,
  X,
} from "lucide-vue-next";
import { useI18n } from "@/i18n";
import type { SshConnectConfig } from "@/shared/sshApi";
import { PLAIN_INPUT_ATTRS } from "@/shared/plainInput";
import {
  createEmptyProfile,
  getSshSecret,
  loadSshProfiles,
  removeSshProfile,
  removeSshSecret,
  setSshSecret,
  upsertSshProfile,
  type SshProfile,
} from "@/shared/sshProfiles";

const props = defineProps<{
  connecting?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  connect: [config: SshConnectConfig];
}>();

const { t } = useI18n();
const profiles = ref<SshProfile[]>([]);
const showEditor = ref(false);
const editingId = ref<string | null>(null);
const form = ref<SshProfile>(createEmptyProfile());
const password = ref("");
const passphrase = ref("");
/** 记住密码 / 私钥口令 */
const rememberSecret = ref(true);
const unlockId = ref<string | null>(null);
const unlockPassword = ref("");
const unlockPassphrase = ref("");
const showFormPassword = ref(false);
const showPassphrase = ref(false);
const showUnlockPassword = ref(false);
const showUnlockPassphrase = ref(false);
const formError = ref("");

const editorTitle = computed(() =>
  editingId.value ? t("sessions.editHost") : t("sessions.addHost"),
);

const AVATAR_COLORS = [
  "#f97316",
  "#eab308",
  "#22c55e",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f43f5e",
];

function avatarColor(profile: SshProfile): string {
  const key = profile.name || profile.host || profile.id;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function avatarLetter(profile: SshProfile): string {
  const label = (profile.name || profile.host || "?").trim();
  return label.slice(0, 1).toUpperCase() || "?";
}

function refreshProfiles() {
  void loadSshProfiles().then((list) => {
    profiles.value = list;
  });
}

onMounted(() => {
  refreshProfiles();
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
});

/** Escape 关闭两个 sheet（与 .overlay @mousedown.self 一致） */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  if (showEditor.value) {
    event.preventDefault();
    closeEditor();
  } else if (unlocking.value) {
    event.preventDefault();
    cancelUnlock();
  }
}

function openAdd() {
  editingId.value = null;
  form.value = createEmptyProfile();
  password.value = "";
  passphrase.value = "";
  rememberSecret.value = true;
  formError.value = "";
  unlockId.value = null;
  showEditor.value = true;
}

async function openEdit(profile: SshProfile, event: MouseEvent) {
  event.stopPropagation();
  editingId.value = profile.id;
  form.value = { ...profile };
  const secret = await getSshSecret(profile.id);
  password.value = secret?.password ?? "";
  passphrase.value = secret?.passphrase ?? "";
  rememberSecret.value = profile.rememberSecret !== false;
  formError.value = "";
  unlockId.value = null;
  showEditor.value = true;
}

function closeEditor() {
  showEditor.value = false;
  editingId.value = null;
  formError.value = "";
}

function onDeleteProfile(profile: SshProfile, event: MouseEvent) {
  event.stopPropagation();
  void removeSshProfile(profile.id).then(() => {
    if (editingId.value === profile.id) closeEditor();
    if (unlockId.value === profile.id) unlockId.value = null;
    refreshProfiles();
  });
}

async function persistSecret(profile: SshProfile, pwd: string, pass: string) {
  if (!rememberSecret.value) {
    await removeSshSecret(profile.id);
    return;
  }
  const existing = await getSshSecret(profile.id);
  const nextPassword =
    profile.authKind === "password"
      ? pwd || existing?.password || undefined
      : existing?.password;
  const nextPassphrase =
    profile.authKind === "key"
      ? pass || existing?.passphrase || undefined
      : existing?.passphrase;
  if (!nextPassword && !nextPassphrase) return;
  await setSshSecret(profile.id, {
    password: nextPassword,
    passphrase: nextPassphrase,
  });
}

/** 「仅保存 / 保存并连接」一律写入主机列表 */
async function saveProfileFromForm(): Promise<SshProfile | null> {
  const host = form.value.host.trim();
  const username = form.value.username.trim();
  if (!host || !username) {
    formError.value = t("sessions.hostRequired");
    return null;
  }
  const profile: SshProfile = {
    ...form.value,
    id: editingId.value || form.value.id || `profile-${Date.now()}`,
    name: form.value.name.trim() || `${username}@${host}`,
    host,
    username,
    port: Number(form.value.port) || 22,
    privateKeyPath: form.value.privateKeyPath?.trim() || "~/.ssh/id_ed25519",
    rememberSecret: rememberSecret.value,
  };
  await upsertSshProfile(profile);
  await persistSecret(profile, password.value, passphrase.value);
  refreshProfiles();
  formError.value = "";
  return profile;
}

function emitConnect(profile: SshProfile, pwd: string, pass: string) {
  const config: SshConnectConfig = {
    host: profile.host,
    port: Number(profile.port) || 22,
    username: profile.username,
    authKind: profile.authKind,
    displayName: profile.name.trim() || undefined,
    password: profile.authKind === "password" ? pwd : undefined,
    privateKeyPath:
      profile.authKind === "key" ? profile.privateKeyPath : undefined,
    passphrase: profile.authKind === "key" ? pass || undefined : undefined,
  };
  emit("connect", config);
}

async function onSaveAndConnect() {
  const profile = await saveProfileFromForm();
  if (!profile) return;
  if (profile.authKind === "password" && !password.value) {
    const secret = await getSshSecret(profile.id);
    if (secret?.password) {
      emitConnect(profile, secret.password, "");
      closeEditor();
      return;
    }
    closeEditor();
    unlockId.value = profile.id;
    unlockPassword.value = "";
    return;
  }
  emitConnect(profile, password.value, passphrase.value);
  closeEditor();
}

async function onSaveOnly() {
  const profile = await saveProfileFromForm();
  if (!profile) return;
  closeEditor();
}

async function onCardClick(profile: SshProfile) {
  if (props.connecting) return;
  showEditor.value = false;
  rememberSecret.value = profile.rememberSecret !== false;

  // 未勾选「记住密码」：每次连接都需手动输入
  if (profile.rememberSecret === false) {
    unlockId.value = profile.id;
    unlockPassword.value = "";
    unlockPassphrase.value = "";
    return;
  }

  const secret = await getSshSecret(profile.id);

  if (profile.authKind === "password") {
    const saved = secret?.password ?? "";
    if (saved) {
      emitConnect(profile, saved, "");
      return;
    }
    unlockId.value = profile.id;
    unlockPassword.value = "";
    unlockPassphrase.value = "";
    return;
  }

  // 私钥：多数无口令；有已存口令则带上直连
  emitConnect(profile, "", secret?.passphrase ?? "");
}

async function persistUnlockCredentials(profile: SshProfile) {
  if (rememberSecret.value) {
    await setSshSecret(profile.id, {
      password:
        profile.authKind === "password" ? unlockPassword.value : undefined,
      passphrase:
        profile.authKind === "key" ? unlockPassphrase.value : undefined,
    });
    await upsertSshProfile({ ...profile, rememberSecret: true });
  } else {
    await removeSshSecret(profile.id);
    await upsertSshProfile({ ...profile, rememberSecret: false });
  }
  refreshProfiles();
}

async function saveUnlock() {
  const profile = profiles.value.find((p) => p.id === unlockId.value);
  if (!profile) return;
  if (profile.authKind === "password" && !unlockPassword.value) return;
  await persistUnlockCredentials(profile);
  unlockId.value = null;
}

async function confirmUnlock() {
  const profile = profiles.value.find((p) => p.id === unlockId.value);
  if (!profile) return;
  if (profile.authKind === "password" && !unlockPassword.value) return;
  await persistUnlockCredentials(profile);
  emitConnect(profile, unlockPassword.value, unlockPassphrase.value);
  unlockId.value = null;
}

function cancelUnlock() {
  unlockId.value = null;
}

const unlocking = computed(() =>
  profiles.value.find((p) => p.id === unlockId.value) ?? null,
);
</script>

<template>
  <div class="hosts">
    <header class="toolbar">
      <button type="button" class="tool-btn primary" @click="openAdd">
        <Plus :size="15" />
        {{ t("sessions.addHost") }}
      </button>
    </header>

    <div class="content">
      <h2 class="section-title">{{ t("sessions.hosts") }}</h2>

      <div v-if="profiles.length" class="grid">
        <button
          v-for="profile in profiles"
          :key="profile.id"
          type="button"
          class="card"
          :disabled="connecting"
          @click="onCardClick(profile)"
        >
          <span
            class="avatar"
            :style="{ background: avatarColor(profile) }"
          >
            {{ avatarLetter(profile) }}
          </span>
          <span class="meta">
            <span class="name">{{ profile.name || `${profile.username}@${profile.host}` }}</span>
            <span class="sub">ssh, {{ profile.username }}</span>
          </span>
          <span class="card-actions">
            <span
              class="icon-hit"
              :title="t('sessions.edit')"
              @click="void openEdit(profile, $event)"
            >
              <Pencil :size="13" />
            </span>
            <span
              class="icon-hit danger"
              :title="t('common.delete')"
              @click="onDeleteProfile(profile, $event)"
            >
              <Trash2 :size="13" />
            </span>
          </span>
        </button>
      </div>

      <div v-else class="empty">
        <Server :size="28" :stroke-width="1.5" class="empty-icon" />
        <p>{{ t("sessions.hostsEmptyTitle") }}</p>
        <p class="empty-hint">{{ t("sessions.hostsEmptyHint") }}</p>
        <button type="button" class="cta" @click="openAdd">
          {{ t("sessions.addHost") }}
        </button>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
    </div>

    <!-- 添加 / 编辑主机 -->
    <div v-if="showEditor" class="overlay" @mousedown.self="closeEditor">
      <div class="sheet" @click.stop>
        <header class="sheet-head">
          <h3>{{ editorTitle }}</h3>
          <button
            type="button"
            class="icon-btn"
            :title="t('common.close')"
            @click="closeEditor"
          >
            <X :size="16" />
          </button>
        </header>
        <div class="sheet-body">
          <label class="field">
            <span>{{ t("sessions.displayName") }}</span>
            <input
              v-model="form.name"
              v-bind="PLAIN_INPUT_ATTRS"
              class="ui-input"
              type="text"
              name="prism-ssh-name"
              :placeholder="t('sessions.displayNamePlaceholder')"
            />
          </label>
          <div class="row-2">
            <label class="field grow">
              <span>{{ t("sessions.host") }}</span>
              <input
                v-model="form.host"
                v-bind="PLAIN_INPUT_ATTRS"
                class="ui-input"
                type="text"
                name="prism-ssh-host"
                placeholder="example.com"
              />
            </label>
            <label class="field narrow">
              <span>{{ t("sessions.port") }}</span>
              <input
                v-model.number="form.port"
                v-bind="PLAIN_INPUT_ATTRS"
                class="ui-input"
                type="number"
                name="prism-ssh-port"
                min="1"
                max="65535"
              />
            </label>
          </div>
          <label class="field">
            <span>{{ t("sessions.username") }}</span>
            <input
              v-model="form.username"
              v-bind="PLAIN_INPUT_ATTRS"
              class="ui-input"
              type="text"
              name="prism-ssh-username"
              placeholder="root"
            />
          </label>
          <label class="field">
            <span>{{ t("sessions.authMethod") }}</span>
            <select v-model="form.authKind" class="ui-select">
              <option value="password">{{ t("sessions.authPassword") }}</option>
              <option value="key">{{ t("sessions.authKey") }}</option>
            </select>
          </label>
          <label v-if="form.authKind === 'password'" class="field">
            <span>{{ t("sessions.password") }}</span>
            <div class="password-field">
              <input
                v-model="password"
                v-bind="PLAIN_INPUT_ATTRS"
                class="ui-input"
                :type="showFormPassword ? 'text' : 'password'"
                name="prism-ssh-password"
              />
              <button
                type="button"
                class="pwd-toggle"
                :title="
                  showFormPassword
                    ? t('sessions.hidePassword')
                    : t('sessions.showPassword')
                "
                @click="showFormPassword = !showFormPassword"
              >
                <EyeOff v-if="showFormPassword" :size="14" />
                <Eye v-else :size="14" />
              </button>
            </div>
          </label>
          <template v-else>
            <label class="field">
              <span>{{ t("sessions.privateKey") }}</span>
              <input
                v-model="form.privateKeyPath"
                v-bind="PLAIN_INPUT_ATTRS"
                class="ui-input"
                type="text"
                name="prism-ssh-key-path"
                placeholder="~/.ssh/id_ed25519"
              />
            </label>
            <label class="field">
              <span>{{ t("sessions.passphraseOptional") }}</span>
              <div class="password-field">
                <input
                  v-model="passphrase"
                  v-bind="PLAIN_INPUT_ATTRS"
                  class="ui-input"
                  :type="showPassphrase ? 'text' : 'password'"
                  name="prism-ssh-passphrase"
                />
                <button
                  type="button"
                  class="pwd-toggle"
                  :title="
                    showPassphrase
                      ? t('sessions.hidePassphrase')
                      : t('sessions.showPassphrase')
                  "
                  @click="showPassphrase = !showPassphrase"
                >
                  <EyeOff v-if="showPassphrase" :size="14" />
                  <Eye v-else :size="14" />
                </button>
              </div>
            </label>
          </template>
          <label class="check">
            <input v-model="rememberSecret" type="checkbox" />
            <span>{{ t("sessions.rememberSecret") }}</span>
          </label>
          <p v-if="formError" class="form-error">{{ formError }}</p>
        </div>
        <footer class="sheet-foot">
          <button type="button" class="ghost" @click="closeEditor">
            {{ t("common.cancel") }}
          </button>
          <button
            type="button"
            class="ghost"
            :disabled="!form.host.trim() || !form.username.trim()"
            @click="onSaveOnly"
          >
            {{ t("sessions.saveOnly") }}
          </button>
          <button
            type="button"
            class="cta"
            :disabled="connecting || !form.host.trim() || !form.username.trim()"
            @click="onSaveAndConnect"
          >
            {{
              connecting ? t("sessions.connecting") : t("sessions.saveAndConnect")
            }}
          </button>
        </footer>
      </div>
    </div>

    <!-- 连接解锁（密码 / 私钥口令） -->
    <div v-if="unlocking" class="overlay" @mousedown.self="cancelUnlock">
      <div class="sheet compact" @click.stop>
        <header class="sheet-head">
          <h3>
            {{
              t("sessions.connectTo", {
                name: unlocking.name || unlocking.host,
              })
            }}
          </h3>
          <button
            type="button"
            class="icon-btn"
            :title="t('common.close')"
            @click="cancelUnlock"
          >
            <X :size="16" />
          </button>
        </header>
        <div class="sheet-body">
          <p class="unlock-meta">ssh · {{ unlocking.username }}@{{ unlocking.host }}:{{ unlocking.port }}</p>
          <label v-if="unlocking.authKind === 'password'" class="field">
            <span>{{ t("sessions.password") }}</span>
            <div class="password-field">
              <input
                v-model="unlockPassword"
                v-bind="PLAIN_INPUT_ATTRS"
                class="ui-input"
                :type="showUnlockPassword ? 'text' : 'password'"
                name="prism-ssh-unlock-password"
                @keydown.enter="confirmUnlock"
              />
              <button
                type="button"
                class="pwd-toggle"
                :title="
                  showUnlockPassword
                    ? t('sessions.hidePassword')
                    : t('sessions.showPassword')
                "
                @click="showUnlockPassword = !showUnlockPassword"
              >
                <EyeOff v-if="showUnlockPassword" :size="14" />
                <Eye v-else :size="14" />
              </button>
            </div>
          </label>
          <label v-else class="field">
            <span>{{ t("sessions.passphraseIfAny") }}</span>
            <div class="password-field">
              <input
                v-model="unlockPassphrase"
                v-bind="PLAIN_INPUT_ATTRS"
                class="ui-input"
                :type="showUnlockPassphrase ? 'text' : 'password'"
                name="prism-ssh-unlock-passphrase"
                @keydown.enter="confirmUnlock"
              />
              <button
                type="button"
                class="pwd-toggle"
                :title="
                  showUnlockPassphrase
                    ? t('sessions.hidePassphrase')
                    : t('sessions.showPassphrase')
                "
                @click="showUnlockPassphrase = !showUnlockPassphrase"
              >
                <EyeOff v-if="showUnlockPassphrase" :size="14" />
                <Eye v-else :size="14" />
              </button>
            </div>
          </label>
          <label class="check">
            <input v-model="rememberSecret" type="checkbox" />
            <span>{{ t("sessions.rememberSecret") }}</span>
          </label>
        </div>
        <footer class="sheet-foot">
          <button type="button" class="ghost" @click="cancelUnlock">
            {{ t("common.cancel") }}
          </button>
          <button
            type="button"
            class="ghost"
            :disabled="unlocking.authKind === 'password' && !unlockPassword"
            @click="saveUnlock"
          >
            {{ t("sessions.save") }}
          </button>
          <button
            type="button"
            class="cta"
            :disabled="connecting || (unlocking.authKind === 'password' && !unlockPassword)"
            @click="confirmUnlock"
          >
            {{ connecting ? t("sessions.connecting") : t("sessions.connect") }}
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hosts {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-app);
  position: relative;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-panel);
  flex-shrink: 0;
}

.tool-btn {
  height: 32px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
}

.tool-btn.primary {
  background: var(--accent);
  border-color: transparent;
  color: var(--accent-fg);
}

.tool-btn:hover {
  filter: brightness(1.05);
}

.content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 20px 20px 32px;
}

.section-title {
  margin: 0 0 14px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}

.card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 12px 14px 14px;
  border-radius: 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-card);
  text-align: left;
  color: var(--text-primary);
  min-height: 64px;
}

.card:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border-subtle));
  background: color-mix(in srgb, var(--accent-soft) 55%, var(--bg-elevated));
}

.card:disabled {
  opacity: 0.6;
  cursor: wait;
}

.avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  flex-shrink: 0;
}

.meta {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sub {
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.card:hover .card-actions {
  opacity: 1;
}

.icon-hit {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--text-muted);
}

.icon-hit:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

.icon-hit.danger:hover {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 240px;
  color: var(--text-secondary);
  text-align: center;
}

.empty-icon {
  color: var(--text-muted);
  margin-bottom: 4px;
}

.empty-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}

.cta {
  height: 34px;
  padding: 0 14px;
  border-radius: 8px;
  background: var(--accent);
  color: var(--accent-fg);
  font-weight: 600;
}

.empty .cta {
  margin-top: 6px;
}

.cta:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.error {
  margin: 16px 0 0;
  font-size: 12px;
  color: var(--danger);
}

.overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  padding: 20px;
  background: var(--bg-overlay);
}

.sheet {
  width: min(440px, 100%);
  max-height: min(90%, 640px);
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  overflow: hidden;
}

.sheet.compact {
  width: min(360px, 100%);
}

.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-subtle);
}

.sheet-head h3 {
  margin: 0;
  font-size: 15px;
}

.icon-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--text-muted);
}

.icon-btn:hover {
  background: var(--accent-soft);
  color: var(--text-primary);
}

.sheet-body {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: auto;
}

.sheet-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-subtle);
}

.sheet-foot .cta {
  height: 32px;
  margin-top: 0;
}

.password-field {
  position: relative;
  display: flex;
  align-items: center;
}

.password-field .ui-input {
  width: 100%;
  padding-right: 36px;
}

.pwd-toggle {
  position: absolute;
  right: 6px;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--text-muted);
}

.pwd-toggle:hover {
  background: var(--accent-soft);
  color: var(--text-primary);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.row-2 {
  display: flex;
  gap: 10px;
}

.grow {
  flex: 1;
  min-width: 0;
}

.narrow {
  width: 96px;
  flex-shrink: 0;
}

.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.ghost {
  height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  background: transparent;
}

.ghost:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--text-primary);
}

.ghost:disabled {
  opacity: 0.4;
}

.unlock-meta {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}

.form-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}
</style>
