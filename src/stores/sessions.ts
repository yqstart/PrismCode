import { computed, nextTick, ref, watch } from "vue";
import { defineStore } from "pinia";
import {
  loadTerminalSession,
  saveTerminalSession,
  type TerminalSession,
} from "@/shared/terminalSession";
import {
  defaultShellName,
  inferShellFromTitle,
} from "@/shared/terminalShell";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";

export interface LocalTerminalSession {
  id: string;
  title: string;
  /** 终端标签标题对应的 shell 名（zsh / bash / powershell），用于同 shell 序号重排 */
  shell: string;
  cwd: string | null;
}

/**
 * 本地终端会话：作为底部面板打开（状态栏左下角按钮 / ⌘J / 资源树右键「在终端中打开」）。
 * SSH 远程会话已拆分为独立标签（见 ssh store），与本 store 解耦。
 */
export const useSessionsStore = defineStore("sessions", () => {
  const settings = useSettingsStore();
  /**
   * 底部工具窗口区当前显示终端。唯一真源是 IDEA 布局状态
   * `settings.layout.bottom.active`：置 true 打开底部区并切到终端，
   * 置 false 收起整个底部区（对应 AppShell 中终端视图的 v-show）。
   */
  const open = computed({
    get: () => settings.layout.bottom.active === "terminal",
    set: (value: boolean) => {
      settings.setBottomWindow(value ? "terminal" : null);
    },
  });
  const focused = ref(false);
  /**
   * 快捷键收起后面板仍保活：视图保持挂载、PTY 不销毁，
   * 与关闭全部终端（卸载并结束进程）区分。
  */
  const dormant = ref(false);
  /**
   * 本次运行中是否已经真正挂载过终端视图。磁盘快照里的 dormant 只表示
   * 上次退出前收起了面板，PTY 不可能跨进程保活，不应因此在开项目时加载 xterm。
   */
  const viewHydrated = ref(false);
  const localTerminals = ref<LocalTerminalSession[]>([]);
  const activeLocalId = ref<string | null>(null);
  /**
   * 各本地终端是否空闲（shell 停在提示符上）。由 LocalTerminal 解析 PTY 输出
   * 上报（见 features/sessions/terminalIdle.ts）。缺省 undefined = 未知（PTY 未
   * 启动），按「可用」处理。
   */
  const localIdle = ref<Record<string, boolean>>({});
  /** 注入到本地 PTY 的待发送输入 */
  const pendingLocalWrite = ref<{
    terminalId: string;
    data: string;
    seq: number;
  } | null>(null);
  let seq = 0;
  let writeSeq = 0;
  let sessionTimer: ReturnType<typeof setTimeout> | null = null;
  let restoringSession = false;
  let suppressPersist = false;

  const isFocused = computed(() => open.value && focused.value);
  /**
   * 是否应挂载终端视图：本次运行已创建终端且会话仍然存在。
   * 与底部区当前显示哪个工具窗口解耦——切到问题/调试时终端保持挂载、PTY 不销毁。
   */
  const mounted = computed(
    () => viewHydrated.value && localTerminals.value.length > 0,
  );
  const hasAnySession = computed(() => localTerminals.value.length > 0);

  /** 立即保存当前窗口、当前工作区的终端标签快照。PTY 进程不会跨退出保留。 */
  function persistSession(root?: string | null) {
    if (sessionTimer !== null) {
      clearTimeout(sessionTimer);
      sessionTimer = null;
    }
    if (suppressPersist) return;
    const sessionRoot = root ?? useWorkspaceStore().rootPath;
    if (!sessionRoot) return;
    saveTerminalSession(sessionRoot, {
      localTerminals: localTerminals.value,
      activeLocalId: activeLocalId.value,
      open: open.value,
      dormant: dormant.value,
    });
  }

  function schedulePersistSession() {
    if (restoringSession || suppressPersist || sessionTimer !== null) return;
    if (!useWorkspaceStore().rootPath) return;
    sessionTimer = setTimeout(() => {
      sessionTimer = null;
      persistSession();
    }, 180);
  }

  function syncSequenceFromIds() {
    for (const terminal of localTerminals.value) {
      const match = /^local-(\d+)$/.exec(terminal.id);
      if (match) seq = Math.max(seq, Number(match[1]));
    }
  }

  function restoreSavedSession(saved: TerminalSession) {
    localTerminals.value = saved.localTerminals.map((terminal) => ({
      id: terminal.id,
      title: terminal.title,
      shell: terminal.shell ?? inferShellFromTitle(terminal.title),
      cwd: terminal.cwd,
    }));
    // 恢复后统一按新规则重排标题（旧快照可能是「终端 N」/命令摘要）
    applyShellTitles();
    syncSequenceFromIds();
    activeLocalId.value = saved.activeLocalId;
    open.value = saved.open;
    dormant.value = saved.dormant && !saved.open;
    // 只有退出前仍展开的面板需要随项目恢复；收起快照延迟到用户再次展开。
    viewHydrated.value = saved.open;
    focused.value = saved.open;
    localIdle.value = {};
    pendingLocalWrite.value = null;
  }

  function blurPeers() {
    void import("@/stores/compare").then(({ useCompareStore }) => {
      useCompareStore().blurCompare();
    });
    void import("@/stores/gitLog").then(({ useGitLogStore }) => {
      useGitLogStore().blurLog();
    });
    void import("@/stores/ssh").then(({ useSshStore }) => {
      useSshStore().blurSsh();
    });
  }

  function ensureDefaultLocal(cwd: string | null) {
    if (localTerminals.value.length > 0) return;
    seq += 1;
    const id = `local-${seq}`;
    const shell = defaultShellName();
    localTerminals.value.push({
      id,
      title: shell,
      shell,
      cwd,
    });
    activeLocalId.value = id;
  }

  /**
   * 切到底部工具窗口的调试视图：调试芯片点击时用，面板没开就一并打开。
   * 先走 openSessions 拿到同一条不变式（viewHydrated 置位 + 保证有一个终端），
   * 调试目标本来就要在那个终端里跑。
   */
  function showDebug(): void {
    openSessions();
    settings.setBottomWindow("debug");
  }

  /** 切到底部工具窗口的问题视图（状态栏与快捷键入口），不牵动终端 */
  function showProblems(): void {
    settings.setBottomWindow("problems");
  }

  function openSessions(cwd: string | null = null) {
    const restoring = dormant.value;
    viewHydrated.value = true;
    dormant.value = false;
    open.value = true;
    focused.value = true;
    if (restoring) return;
    ensureDefaultLocal(cwd);
    // 底部面板与画布（SSH/GitLog/Compare）并存，打开面板不打断其它视图的聚焦
  }

  /** 隐藏终端标签但保留会话与 PTY（⌘/Ctrl+J） */
  function hideSessions() {
    if (!open.value) return;
    open.value = false;
    focused.value = false;
    dormant.value = hasAnySession.value;
  }

  /** 显示 ↔ 隐藏切换；关闭标签请用 closeSessions */
  function toggleSessions(cwd: string | null = null) {
    if (open.value) {
      hideSessions();
      return;
    }
    openSessions(cwd);
  }

  function focusSessions() {
    if (!open.value) return;
    focused.value = true;
    blurPeers();
  }

  function blurSessions() {
    focused.value = false;
  }

  /**
   * 关闭终端标签：卸载视图并结束保活（PTY 随组件卸载退出）。
   * 应用关闭时传 preserveSession，先保存标签，再清理运行中的 PTY，避免
   * 清理过程把本次退出前的终端快照覆盖为空。
   */
  async function closeSessions(options?: { preserveSession?: boolean }): Promise<boolean> {
    const root = useWorkspaceStore().rootPath;
    if (options?.preserveSession) {
      persistSession(root);
    }

    suppressPersist = true;
    try {
      localTerminals.value = [];
      activeLocalId.value = null;
      localIdle.value = {};
      // 清空待注入命令：目标终端已销毁，残留任务永远无法被消费
      pendingLocalWrite.value = null;
      open.value = false;
      focused.value = false;
      dormant.value = false;
      viewHydrated.value = false;
      // 等 Vue 卸载 LocalTerminal，确保 PTY kill 已经发出后再返回。
      await nextTick();
    } finally {
      suppressPersist = false;
    }

    // 用户主动关闭全部终端时，快照也应同步为空；应用关闭前的保留路径
    // 已在上面保存，不能让清理过程把它覆盖掉。
    if (!options?.preserveSession) persistSession(root);
    return true;
  }

  /**
   * 终端标签标题：shell 名 + 同 shell 序号（对齐 Cursor / VS Code 终端标签）。
   * 首个实例显示 shell 名（如 zsh），第二个起加序号（zsh (2)、zsh (3)…）。
   */
  function applyShellTitles() {
    const counts = new Map<string, number>();
    for (const terminal of localTerminals.value) {
      const count = (counts.get(terminal.shell) ?? 0) + 1;
      counts.set(terminal.shell, count);
      terminal.title = count <= 1 ? terminal.shell : `${terminal.shell} (${count})`;
    }
  }

  function addLocalTerminal(cwd: string | null = null) {
    seq += 1;
    const id = `local-${seq}`;
    const shell = defaultShellName();
    localTerminals.value.push({
      id,
      title: shell,
      shell,
      cwd,
    });
    applyShellTitles();
    activeLocalId.value = id;
    openSessions(cwd);
  }

  /**
   * 在指定目录打开本地终端（资源树右键「在终端中打开」）：
   * 面板展开；活动终端已在该目录且空闲则直接复用，否则新开终端（cwd=目录），
   * 保证「文件 → 所在目录、文件夹 → 自身目录」最终落地为终端工作目录。
   */
  function openTerminalAt(cwd: string | null) {
    openSessions(cwd);
    const active = localTerminals.value.find((t) => t.id === activeLocalId.value);
    if (!active) return; // 无终端时 ensureDefaultLocal 已按 cwd 创建
    if (active.cwd === cwd && localIdle.value[active.id] !== false) return;
    addLocalTerminal(cwd);
  }

  /**
   * 打开/切换工作区时：本地终端一律重建（cwd 跟随新项目根）。
   * SSH 远程连接强制断开逻辑见 ssh store 的 resetForWorkspace。
   */
  async function resetLocalForWorkspace(cwd: string | null) {
    const keepUiOpen = open.value;
    const wasDormant = dormant.value;
    const hadLocal = localTerminals.value.length > 0;
    const saved = cwd ? loadTerminalSession(cwd) : null;

    if (sessionTimer !== null) {
      clearTimeout(sessionTimer);
      sessionTimer = null;
    }
    suppressPersist = true;
    localTerminals.value = [];
    activeLocalId.value = null;
    localIdle.value = {};
    // 旧终端全部销毁，其待注入命令作废
    pendingLocalWrite.value = null;
    dormant.value = false;
    viewHydrated.value = false;

    // 先卸载旧工作区的终端，再创建新 cwd 的终端，避免切换项目时短暂
    // 同时保留两组 PTY 读/等待任务。
    restoringSession = true;
    try {
      await nextTick();

      if (saved) {
        restoreSavedSession(saved);
      } else if (keepUiOpen || wasDormant || hadLocal) {
        ensureDefaultLocal(cwd);
        viewHydrated.value = keepUiOpen;
        if (wasDormant && !keepUiOpen) {
          dormant.value = true;
        }
      }
    } finally {
      restoringSession = false;
      suppressPersist = false;
    }
    if (!saved && (keepUiOpen || wasDormant || hadLocal)) {
      schedulePersistSession();
    }
  }

  function closeLocalTerminal(id: string) {
    const idx = localTerminals.value.findIndex((t) => t.id === id);
    if (idx < 0) return;
    localTerminals.value.splice(idx, 1);
    delete localIdle.value[id];
    // 组件卸载后 watcher 不一定还有机会消费异步等待中的任务；目标终端
    // 已不存在时，待注入命令必须立即作废，避免残留到后续操作。
    if (pendingLocalWrite.value?.terminalId === id) {
      pendingLocalWrite.value = null;
    }
    applyShellTitles();
    if (activeLocalId.value === id) {
      const next = localTerminals.value[idx] || localTerminals.value[idx - 1] || null;
      activeLocalId.value = next?.id ?? null;
    }
    if (localTerminals.value.length === 0) {
      void closeSessions();
    }
  }

  function activateLocal(id: string) {
    activeLocalId.value = id;
    focusSessions();
  }

  /** LocalTerminal 上报本终端的空闲状态（见 terminalIdle.ts） */
  function setLocalIdle(id: string, idle: boolean) {
    localIdle.value[id] = idle;
  }

  /** 打开本地终端视图并向活动本地终端写入命令（含回车）。
   *  活动终端正在跑任务（不空闲）时新开一个终端执行，避免命令叠加进 busy 终端。 */
  function runInLocalTerminal(command: string, cwd: string | null = null) {
    openSessions(cwd);
    let id = activeLocalId.value;
    // 未知（PTY 未启动）按可用处理；busy 或尚无终端则新开
    if (!id || localIdle.value[id] === false) {
      addLocalTerminal(cwd);
      id = activeLocalId.value;
    }
    if (!id) return;
    focusSessions();
    const data = command.endsWith("\r") || command.endsWith("\n")
      ? command
      : `${command}\r`;
    writeSeq += 1;
    pendingLocalWrite.value = { terminalId: id, data, seq: writeSeq };
    // 写入即忙：命令已注入但提示符检测尚未反应时，再次点击快捷方式不会叠进同一终端；
    // 命令结束后 shell 重新打印提示符，检测器会把 idle 恢复为 true。
    localIdle.value[id] = false;
  }

  /**
   * 向活动本地终端发一次 Ctrl-C。调试目标以 suspend=y 挂起时连不上调试器，
   * 必须能打断它，否则终端里会留下一个永远不动的 JVM。
   */
  function interruptLocalTerminal(terminalId?: string) {
    const id = terminalId ?? activeLocalId.value;
    if (!id || !localTerminals.value.some((item) => item.id === id)) return;
    writeSeq += 1;
    pendingLocalWrite.value = { terminalId: id, data: "\u0003", seq: writeSeq };
  }

  function consumePendingLocalWrite(seq: number) {
    if (pendingLocalWrite.value?.seq === seq) {
      pendingLocalWrite.value = null;
    }
  }

  watch(
    [open, dormant, activeLocalId, localTerminals],
    () => schedulePersistSession(),
    { deep: true },
  );

  return {
    open,
    showDebug,
    showProblems,
    focused,
    dormant,
    mounted,
    isFocused,
    localTerminals,
    activeLocalId,
    localIdle,
    pendingLocalWrite,
    persistSession,
    openSessions,
    hideSessions,
    toggleSessions,
    focusSessions,
    blurSessions,
    closeSessions,
    addLocalTerminal,
    openTerminalAt,
    resetLocalForWorkspace,
    closeLocalTerminal,
    activateLocal,
    setLocalIdle,
    runInLocalTerminal,
    interruptLocalTerminal,
    consumePendingLocalWrite,
  };
});
