<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Grid, X } from "reicon-vue";
import { storeToRefs } from "pinia";
import RemoteTerminal from "@/features/sessions/RemoteTerminal.vue";
import SshHostsView from "@/features/sessions/SshHostsView.vue";
import { parseHostKeyUnknown, type SshConnectConfig } from "@/shared/sshApi";
import { useSshStore } from "@/stores/ssh";
import { useI18n } from "@/i18n";

const { t } = useI18n();
const ssh = useSshStore();
const { surface, remoteSessions, activeRemoteId } = storeToRefs(ssh);

const connecting = ref(false);
const error = ref("");

const showHosts = computed(
  () => surface.value === "hosts" || !remoteSessions.value.length,
);

function goHosts() {
  ssh.goHosts();
  error.value = "";
}

function onRemoteConnect(config: SshConnectConfig) {
  connecting.value = true;
  error.value = "";
  void ssh.addRemoteSession(config).finally(() => {
    connecting.value = false;
  });
}

function onRemoteFailed(id: string, message: string) {
  const session = remoteSessions.value.find((t) => t.id === id);
  const unknown = parseHostKeyUnknown(message);
  if (unknown && session) {
    const ok = window.confirm(
      t("sessions.hostKeyUnknownConfirm", {
        endpoint: unknown.endpoint,
        fingerprint: unknown.fingerprint,
      }),
    );
    const config = { ...session.config };
    void closeRemoteFully(id, { keepError: false });
    if (ok) {
      onRemoteConnect({ ...config, acceptUnknownHostKey: true });
    } else {
      error.value = t("sessions.hostKeyRejected");
      ssh.goHosts();
    }
    return;
  }

  // 先切回主机列表并保留错误；close 触发的 watch 不得清掉本条错误
  error.value = message;
  ssh.goHosts();
  void closeRemoteFully(id, { keepError: true });
}

function onRemoteClosed(id: string) {
  void closeRemoteFully(id);
}

async function closeRemoteFully(
  id: string,
  opts: { keepError?: boolean } = {},
) {
  const ok = await ssh.closeRemoteSession(id);
  if (!ok) return;
  if (!remoteSessions.value.length && !opts.keepError) {
    error.value = "";
  }
}

function activateRemoteSession(id: string) {
  ssh.activateRemote(id);
}

watch(remoteSessions, (list) => {
  if (!list.length) {
    ssh.goHosts();
  }
});
</script>

<template>
  <div class="ssh-view">
    <!-- SSH 会话顶栏 -->
    <header v-if="remoteSessions.length" class="subtabs">
      <button
        type="button"
        class="subtab"
        :class="{ active: showHosts }"
        :title="t('sessions.hostsList')"
        @click="goHosts"
      >
        <Grid weight="Filled" :size="12" />
        <span>{{ t("sessions.hosts") }}</span>
      </button>
      <button
        v-for="term in remoteSessions"
        :key="term.id"
        type="button"
        class="subtab"
        :class="{ active: !showHosts && term.id === activeRemoteId }"
        @click="activateRemoteSession(term.id)"
      >
        <span>{{ term.title }}</span>
        <span
          class="close"
          :title="t('common.close')"
          @click.stop="closeRemoteFully(term.id)"
        >
          <X weight="Filled" :size="12" />
        </span>
      </button>
    </header>

    <div class="body">
      <SshHostsView
        v-show="showHosts"
        :connecting="connecting"
        :error="error"
        @connect="onRemoteConnect"
      />

      <!-- 远程会话 -->
      <RemoteTerminal
        v-for="term in remoteSessions"
        v-show="
          !showHosts &&
          term.id === activeRemoteId
        "
        :key="term.id"
        :session-id="term.id"
        :config="term.config"
        :active="!showHosts && term.id === activeRemoteId"
        @failed="onRemoteFailed(term.id, $event)"
        @closed="onRemoteClosed(term.id)"
      />
    </div>
  </div>
</template>

<style scoped>
.ssh-view {
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
  border-radius: 4px;
  display: grid;
  place-items: center;
  opacity: 0.55;
}

.subtab .close:hover {
  opacity: 1;
  background: var(--bg-app);
}

.body {
  flex: 1;
  min-height: 0;
  position: relative;
}
</style>
