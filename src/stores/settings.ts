import { computed, reactive, watch } from "vue";
import { defineStore } from "pinia";
import { setI18nLocale } from "@/i18n";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type EditorPreferences,
  type SidePanelId,
  type ThemeId,
  isUpdateImportsOnMove,
  isEditorFontId,
} from "@/shared/types";

const STORAGE_KEY = "prismcode.settings.v1";
const LEGACY_STORAGE_KEY = "mirocode.settings.v1";

/** 历史主题 ID → 现行 ID */
const THEME_MIGRATION: Record<string, ThemeId> = {
  "adnify-dark": "prism-dark",
  "miro-dark": "prism-dark",
};

/** 各主题对应的 macOS Overlay 标题栏底色（仅最顶系统栏，不含项目行） */
const TITLEBAR_RGB: Record<ThemeId, [number, number, number]> = {
  dawn: [233, 235, 239],
  "prism-dark": [23, 24, 28],
  midnight: [20, 28, 43],
  cyberpunk: [23, 21, 31],
};

function isDarkTheme(theme: ThemeId): boolean {
  return theme === "prism-dark" || theme === "midnight" || theme === "cyberpunk";
}

/** 同步 macOS / 系统菜单栏文案到应用语言（无需重启） */
async function syncNativeMenuLocale(locale: AppSettings["locale"]) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_app_menu_locale", { locale });
  } catch {
    // 纯 Vite 预览或命令未就绪
  }
}

function loadSettings(): AppSettings {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ??
      localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw) as Partial<AppSettings> & {
      layout?: Partial<AppSettings["layout"]> & {
        gitToolWindow?: {
          open?: boolean;
          height?: number;
          tab?: string;
          changesWidth?: number;
        };
        activePanel?: string;
      };
    };

    const oldTw = parsed.layout?.gitToolWindow;
    const layout: AppSettings["layout"] = {
      ...DEFAULT_SETTINGS.layout,
      ...parsed.layout,
      gitLogWindow: {
        ...DEFAULT_SETTINGS.layout.gitLogWindow,
        ...(parsed.layout?.gitLogWindow ?? {}),
      },
    };

    // 丢掉旧字段
    delete (layout as { gitToolWindow?: unknown }).gitToolWindow;
    delete (layout as { commitDiffPreview?: unknown }).commitDiffPreview;
    delete (layout as { commitDiffPreviewHeight?: unknown })
      .commitDiffPreviewHeight;

    // 全局搜索已改为 WebStorm 弹层
    if ((layout.activePanel as string) === "search") {
      layout.activePanel = "explorer";
    }

    // 旧侧栏 git / 底部 Commit 工具窗 → New UI 左侧 Commit
    if (
      (layout.activePanel as string) === "git" ||
      (oldTw?.open && oldTw.tab === "commit")
    ) {
      layout.activePanel = "commit";
    }

    // 旧底部 Log 标签 → 底部 Git Log 窗口
    if (oldTw?.open && oldTw.tab === "log") {
      layout.gitLogWindow = {
        open: true,
        height: oldTw.height ?? DEFAULT_SETTINGS.layout.gitLogWindow.height,
      };
      if (layout.activePanel !== "commit") {
        layout.activePanel = "explorer";
      }
    }

    if (
      (layout.activePanel as string) !== "explorer" &&
      (layout.activePanel as string) !== "commit"
    ) {
      layout.activePanel = "explorer";
    }

    const rawTheme = parsed.theme as string | undefined;
    const theme =
      (rawTheme && THEME_MIGRATION[rawTheme]) ||
      (rawTheme as ThemeId | undefined) ||
      DEFAULT_SETTINGS.theme;

    // 旧版本把 AI 配置写在 editor.aiCompletion 中。不要把这部分历史配置
    // 继续带入响应式设置，避免用户以为应用仍然会联网请求 AI。
    const editorOverrides = {
      ...(parsed.editor ?? {}),
    } as Partial<EditorPreferences> & {
      aiCompletion?: unknown;
      minimap?: unknown;
    };
    delete editorOverrides.aiCompletion;
    // Minimap 已移除，清理旧版本持久化设置，避免无效字段继续写回磁盘。
    delete editorOverrides.minimap;
    const rawEditorFontFamily = parsed.editor?.fontFamily;
    const rawUpdateImportsOnMove = parsed.editor?.updateImportsOnMove;

    return {
      theme:
        theme === "dawn" ||
        theme === "prism-dark" ||
        theme === "midnight" ||
        theme === "cyberpunk"
          ? theme
          : DEFAULT_SETTINGS.theme,
      locale: parsed.locale ?? DEFAULT_SETTINGS.locale,
      editor: {
        ...DEFAULT_SETTINGS.editor,
        ...editorOverrides,
        fontFamily: isEditorFontId(rawEditorFontFamily)
          ? rawEditorFontFamily
          : DEFAULT_SETTINGS.editor.fontFamily,
        updateImportsOnMove: isUpdateImportsOnMove(rawUpdateImportsOnMove)
          ? rawUpdateImportsOnMove
          : DEFAULT_SETTINGS.editor.updateImportsOnMove,
      },
      layout,
      autoCheckUpdates:
        parsed.autoCheckUpdates ?? DEFAULT_SETTINGS.autoCheckUpdates,
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

/** 同步原生标题栏 / 窗口控件外观（macOS 上主题为应用级） */
async function syncNativeWindowTheme(theme: ThemeId) {
  const mode = isDarkTheme(theme) ? "dark" : "light";
  try {
    const { setTheme } = await import("@tauri-apps/api/app");
    await setTheme(mode);
  } catch {
    // 纯 Vite 预览或权限未就绪
  }
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTheme(mode);
  } catch {
    // 同上
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const [r, g, b] = TITLEBAR_RGB[theme];
    await invoke("set_titlebar_background", { r, g, b });
    await invoke("sync_traffic_lights");
  } catch {
    // 非桌面壳或命令未就绪
  }
}

function applyTheme(theme: ThemeId) {
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.style.colorScheme = isDarkTheme(theme)
    ? "dark"
    : "light";
}

export const useSettingsStore = defineStore("settings", () => {
  const settings = reactive<AppSettings>(loadSettings());
  let settingsPersistTimer: ReturnType<typeof setTimeout> | null = null;

  function persistNow() {
    if (settingsPersistTimer !== null) {
      clearTimeout(settingsPersistTimer);
      settingsPersistTimer = null;
    }
    // 存储不可用（隐私模式 / 配额超限）时静默降级：本次会话设置仍生效
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // ignore
    }
  }

  function schedulePersist() {
    if (settingsPersistTimer !== null) clearTimeout(settingsPersistTimer);
    settingsPersistTimer = setTimeout(() => {
      settingsPersistTimer = null;
      persistNow();
    }, 200);
  }

  applyTheme(settings.theme);
  setI18nLocale(settings.locale);
  void syncNativeWindowTheme(settings.theme);
  void syncNativeMenuLocale(settings.locale);

  watch(
    () => settings.theme,
    (theme) => {
      applyTheme(theme);
      void syncNativeWindowTheme(theme);
    },
  );

  watch(
    () => settings.locale,
    (locale) => {
      setI18nLocale(locale);
      void syncNativeMenuLocale(locale);
    },
  );

  watch(
    settings,
    () => {
      schedulePersist();
    },
    { deep: true },
  );

  const theme = computed(() => settings.theme);
  const locale = computed(() => settings.locale);
  const editor = computed(() => settings.editor);
  const layout = computed(() => settings.layout);
  const isDark = computed(() => isDarkTheme(settings.theme));

  function setTheme(next: ThemeId) {
    settings.theme = next;
  }

  function patchEditor(patch: Partial<EditorPreferences>) {
    Object.assign(settings.editor, patch);
  }

  function setSidebarCollapsed(collapsed: boolean) {
    settings.layout.sidebarCollapsed = collapsed;
  }

  function setSidebarWidth(width: number) {
    settings.layout.sidebarWidth = Math.min(520, Math.max(200, width));
  }

  function setActivePanel(panel: SidePanelId) {
    settings.layout.activePanel = panel;
    if (settings.layout.sidebarCollapsed) {
      settings.layout.sidebarCollapsed = false;
    }
  }

  function toggleSidebar() {
    settings.layout.sidebarCollapsed = !settings.layout.sidebarCollapsed;
  }

  /** 打开左侧 Commit 工具窗口（WebStorm New UI ⌘K） */
  function openCommitPanel() {
    settings.layout.activePanel = "commit";
    settings.layout.sidebarCollapsed = false;
  }

  function toggleCommitPanel() {
    if (
      settings.layout.activePanel === "commit" &&
      !settings.layout.sidebarCollapsed
    ) {
      settings.layout.sidebarCollapsed = true;
      return;
    }
    openCommitPanel();
  }

  function setGitLogWindowOpen(open: boolean) {
    settings.layout.gitLogWindow.open = open;
  }

  function toggleGitLogWindow() {
    settings.layout.gitLogWindow.open = !settings.layout.gitLogWindow.open;
  }

  function setGitLogWindowHeight(height: number) {
    settings.layout.gitLogWindow.height = Math.min(
      640,
      Math.max(160, Math.round(height)),
    );
  }

  function setTerminalPanelHeight(height: number) {
    settings.layout.terminalPanelHeight = Math.min(
      640,
      Math.max(120, Math.round(height)),
    );
  }

  function setLocale(next: AppSettings["locale"]) {
    settings.locale = next;
  }

  function setAutoCheckUpdates(next: boolean) {
    settings.autoCheckUpdates = next;
  }

  return {
    settings,
    theme,
    locale,
    editor,
    layout,
    isDark,
    setTheme,
    patchEditor,
    setSidebarCollapsed,
    setSidebarWidth,
    setActivePanel,
    toggleSidebar,
    openCommitPanel,
    toggleCommitPanel,
    setGitLogWindowOpen,
    toggleGitLogWindow,
    setGitLogWindowHeight,
    setTerminalPanelHeight,
    setLocale,
    setAutoCheckUpdates,
    persistNow,
  };
});
