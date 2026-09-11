import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { sshShellClose, type SshConnectConfig } from "@/shared/sshApi";

export type SshSurface = "hosts" | "session";

/** SSH 远程会话：仅终端，连接配置复用 SSH 凭据 */
export interface RemoteSession {
  id: string;
  title: string;
  config: SshConnectConfig;
}

const SSH_TAB_ID = "prism://ssh";

/**
 * SSH 远程会话视图：作为独立编辑区标签打开（对齐 VS Code 远程开发入口形态），
 * 与本地终端（sessions store）彻底解耦。
 * - 关闭 SSH 标签不会影响本地终端，反之亦然
 * - 会话在快捷键/隐藏时保活（dormant），关闭标签才断开连接
 */
export const useSshStore = defineStore("ssh", () => {
  /** SSH 标签是否出现在编辑区标签栏 */
  const open = ref(false);
  const focused = ref(false);
  /** 快捷键隐藏后 SSH 会话仍存活（连接不销毁），与关闭标签（断开）区分 */
  const dormant = ref(false);
  const remoteSessions = ref<RemoteSession[]>([]);
  const activeRemoteId = ref<string | null>(null);
  /** 当前 SSH 区表面：主机列表 / 已连接会话 */
  const surface = ref<SshSurface>("hosts");
  let seq = 0;

  const tabId = SSH_TAB_ID;
  const isFocused = computed(() => open.value && focused.value);
  /** 是否应挂载 SshView（显示中或隐藏保活） */
  const mounted = computed(() => open.value || dormant.value);
  const hasAnySession = computed(() => remoteSessions.value.length > 0);

  function blurPeers() {
    void import("@/stores/compare").then(({ useCompareStore }) => {
      useCompareStore().blurCompare();
    });
    void import("@/stores/gitLog").then(({ useGitLogStore }) => {
      useGitLogStore().blurLog();
    });
    void import("@/stores/sessions").then(({ useSessionsStore }) => {
      useSessionsStore().blurSessions();
    });
  }

  function openSsh() {
    const restoring = dormant.value;
    dormant.value = false;
    open.value = true;
    focused.value = true;
    blurPeers();
    if (restoring) return;
    // 首次打开默认主机列表；已存在会话则进入会话
    surface.value = remoteSessions.value.length ? "session" : "hosts";
  }

  /** 隐藏 SSH 标签但保留会话与连接 */
  function hideSsh() {
    if (!open.value) return;
    open.value = false;
    focused.value = false;
    dormant.value = hasAnySession.value;
  }

  function toggleSsh() {
    if (open.value) {
      hideSsh();
      return;
    }
    openSsh();
  }

  function focusSsh() {
    if (!open.value) return;
    focused.value = true;
    blurPeers();
  }

  function blurSsh() {
    focused.value = false;
  }

  /** 关闭 SSH 标签：断开全部远程连接、卸载视图并结束保活 */
  async function closeSsh(): Promise<boolean> {
    for (const session of remoteSessions.value.slice()) {
      const ok = await disconnectRemoteSession(session.id);
      if (!ok) return false;
    }
    remoteSessions.value = [];
    activeRemoteId.value = null;
    open.value = false;
    focused.value = false;
    dormant.value = false;
    surface.value = "hosts";
    return true;
  }

  /** 主动断开远程 SSH 终端 */
  async function disconnectRemoteSession(id: string): Promise<boolean> {
    const session = remoteSessions.value.find((t) => t.id === id);
    if (!session) return true;

    try {
      await sshShellClose(id);
    } catch {
      // 已断开则忽略
    }
    return true;
  }

  async function addRemoteSession(config: SshConnectConfig) {
    seq += 1;
    const id = `ssh-${seq}`;
    const title =
      config.displayName?.trim() || `${config.username}@${config.host}`;
    remoteSessions.value.push({
      id,
      title,
      config,
    });
    activeRemoteId.value = id;
    surface.value = "session";
    dormant.value = false;
    open.value = true;
    focused.value = true;
    blurPeers();
    return id;
  }

  async function closeRemoteSession(id: string): Promise<boolean> {
    const ok = await disconnectRemoteSession(id);
    if (!ok) return false;
    const idx = remoteSessions.value.findIndex((t) => t.id === id);
    if (idx < 0) return true;
    remoteSessions.value.splice(idx, 1);
    if (activeRemoteId.value === id) {
      const next =
        remoteSessions.value[idx] || remoteSessions.value[idx - 1] || null;
      activeRemoteId.value = next?.id ?? null;
    }
    if (!remoteSessions.value.length) {
      surface.value = "hosts";
      // 无活跃会话且标签未聚焦时，隐藏为空态
      if (!open.value && !dormant.value) {
        // 保持标签打开，展示主机列表
      }
    }
    return true;
  }

  function activateRemote(id: string) {
    activeRemoteId.value = id;
    surface.value = "session";
    focusSsh();
  }

  function goHosts() {
    surface.value = "hosts";
  }

  /** 打开/切换工作区时强制断开本窗口全部 SSH 远程连接（活跃会话） */
  async function resetForWorkspace() {
    const remotes = remoteSessions.value.slice();
    for (const session of remotes) {
      try {
        await sshShellClose(session.id);
      } catch {
        // 已断开则忽略
      }
    }
    remoteSessions.value = [];
    activeRemoteId.value = null;
    surface.value = "hosts";
  }

  return {
    tabId,
    open,
    focused,
    dormant,
    mounted,
    isFocused,
    surface,
    remoteSessions,
    activeRemoteId,
    openSsh,
    hideSsh,
    toggleSsh,
    focusSsh,
    blurSsh,
    closeSsh,
    addRemoteSession,
    disconnectRemoteSession,
    closeRemoteSession,
    activateRemote,
    goHosts,
    resetForWorkspace,
  };
});
