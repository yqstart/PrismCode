import { computed, reactive, watch } from "vue";
import { defineStore } from "pinia";
import { setI18nLocale } from "@/i18n";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type BottomToolWindowId,
  type EditorPreferences,
  type JavaPreferences,
  type LeftToolWindowId,
  type RightToolWindowId,
  type ThemeId,
  isUpdateImportsOnMove,
  isEditorFontId,
  isKeymapPreset,
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
  "intellij-dark": [30, 31, 34], // #1e1f22
  "intellij-light": [247, 248, 250], // #f7f8fa
  dawn: [233, 235, 239],
  "prism-dark": [23, 24, 28],
  midnight: [20, 28, 43],
  cyberpunk: [23, 21, 31],
};

function isDarkTheme(theme: ThemeId): boolean {
  return (
    theme === "intellij-dark" ||
    theme === "prism-dark" ||
    theme === "midnight" ||
    theme === "cyberpunk"
  );
}

/** 左侧工具窗口列宽约束（px） */
function clampLeftWidth(width: number): number {
  return Math.min(520, Math.max(200, Math.round(width)));
}

/** 底部工具窗口区高约束（px） */
function clampBottomHeight(height: number): number {
  return Math.min(640, Math.max(120, Math.round(height)));
}

/** 右侧工具窗口列宽约束（px） */
function clampRightWidth(width: number): number {
  return Math.min(560, Math.max(220, Math.round(width)));
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
        /** 旧版（VS Code 式）布局字段，仅用于迁移 */
        gitToolWindow?: {
          open?: boolean;
          height?: number;
          tab?: string;
          changesWidth?: number;
        };
        sidebarCollapsed?: boolean;
        sidebarWidth?: number;
        activePanel?: string;
        terminalPanelHeight?: number;
        commitDiffPreview?: unknown;
        commitDiffPreviewHeight?: unknown;
      };
    };

    const parsedLayout = parsed.layout;
    const oldTw = parsedLayout?.gitToolWindow;

    // 旧侧栏字段 → IDEA 工具窗口区模型
    // （activePanel=explorer/git/commit/search 归一为 project/commit）
    const legacyLeftWindow: LeftToolWindowId =
      parsedLayout?.activePanel === "commit" ||
        (oldTw?.open === true && oldTw.tab === "commit")
        ? "commit"
        : "project";
    const legacyLeftActive: LeftToolWindowId | null =
      parsedLayout?.sidebarCollapsed === true ? null : legacyLeftWindow;

    const rawLeftActive = parsedLayout?.left?.active;
    const rawLeftLast = parsedLayout?.left?.lastActive;
    const rawBottomActive = parsedLayout?.bottom?.active;
    const rawBottomLast = parsedLayout?.bottom?.lastActive;
    const rawRightActive = parsedLayout?.right?.active;
    const rawRightLast = parsedLayout?.right?.lastActive;

    const layout: AppSettings["layout"] = {
      left: {
        active:
          rawLeftActive === null
            ? null
            : rawLeftActive === "project" || rawLeftActive === "commit"
              ? rawLeftActive
              : legacyLeftActive,
        lastActive:
          rawLeftLast === "project" || rawLeftLast === "commit"
            ? rawLeftLast
            : legacyLeftWindow,
        width: clampLeftWidth(
          parsedLayout?.left?.width ??
          parsedLayout?.sidebarWidth ??
          DEFAULT_SETTINGS.layout.left.width,
        ),
        maximized: parsedLayout?.left?.maximized === true,
      },
      bottom: {
        active:
          rawBottomActive === "terminal" ||
            rawBottomActive === "problems" ||
            rawBottomActive === "debug"
            ? rawBottomActive
            : null,
        lastActive:
          rawBottomLast === "terminal" ||
            rawBottomLast === "problems" ||
            rawBottomLast === "debug"
            ? rawBottomLast
            : "terminal",
        height: clampBottomHeight(
          parsedLayout?.bottom?.height ??
          parsedLayout?.terminalPanelHeight ??
          DEFAULT_SETTINGS.layout.bottom.height,
        ),
        maximized: parsedLayout?.bottom?.maximized === true,
      },
      right: {
        active: rawRightActive === "spring" ? rawRightActive : null,
        lastActive: rawRightLast === "spring" ? rawRightLast : "spring",
        width: clampRightWidth(
          parsedLayout?.right?.width ?? DEFAULT_SETTINGS.layout.right.width,
        ),
        maximized: parsedLayout?.right?.maximized === true,
      },
      gitLogWindow: {
        ...DEFAULT_SETTINGS.layout.gitLogWindow,
        ...(parsedLayout?.gitLogWindow ?? {}),
      },
    };

    const rawTheme = parsed.theme as string | undefined;
    let theme =
      (rawTheme && THEME_MIGRATION[rawTheme]) ||
      (rawTheme as ThemeId | undefined) ||
      DEFAULT_SETTINGS.theme;
    // 旧版本的默认主题是 cyberpunk：沿用旧默认（== 从未主动切换过的用户）跟随
    // 新默认 IntelliJ Dark。主动选过其它主题的保持不变；主动选过 cyberpunk 的
    // 无法与旧默认区分，一并跟随（可在设置里改回）。
    if (theme === "cyberpunk") theme = "intellij-dark";

    // 旧版本把 AI 配置写在 editor.aiCompletion 中。不要把这部分历史配置
    // 继续带入响应式设置，避免用户以为应用仍然会联网请求 AI。
    const editorOverrides = {
      ...(parsed.editor ?? {}),
    } as Partial<EditorPreferences> & {
      aiCompletion?: unknown;
      /** 更早的版本把 minimap 存成 { enabled } 对象 */
      minimap?: unknown;
    };
    delete editorOverrides.aiCompletion;
    // minimap 曾是对象形态的遗留字段，统一收敛成布尔开关
    if (
      editorOverrides.minimap !== undefined &&
      typeof editorOverrides.minimap !== "boolean"
    ) {
      const legacy = editorOverrides.minimap as { enabled?: unknown } | null;
      editorOverrides.minimap = legacy?.enabled === true;
    }
    const rawEditorFontFamily = parsed.editor?.fontFamily;
    const rawUpdateImportsOnMove = parsed.editor?.updateImportsOnMove;

    return {
      theme:
        theme === "intellij-dark" ||
          theme === "intellij-light" ||
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
        keymap: isKeymapPreset(editorOverrides.keymap)
          ? editorOverrides.keymap
          : DEFAULT_SETTINGS.editor.keymap,
      },
      layout,
      java: normalizeJava(parsed.java),
      autoCheckUpdates:
        parsed.autoCheckUpdates ?? DEFAULT_SETTINGS.autoCheckUpdates,
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeJava(value: Partial<JavaPreferences> | undefined): JavaPreferences {
  return {
    ...DEFAULT_SETTINGS.java,
    ...value,
    enabled: typeof value?.enabled === "boolean" ? value.enabled : DEFAULT_SETTINGS.java.enabled,
    serverMemoryMb: clampNumber(value?.serverMemoryMb, 512, 4096, DEFAULT_SETTINGS.java.serverMemoryMb),
    idleStopMinutes: clampNumber(value?.idleStopMinutes, 0, 60, DEFAULT_SETTINGS.java.idleStopMinutes),
    jrePath: typeof value?.jrePath === "string" ? value.jrePath : "",
    jdtlsPath: typeof value?.jdtlsPath === "string" ? value.jdtlsPath : "",
  };
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

  watch(
    () => settings.java.enabled,
    (enabled) => {
      if (enabled) return;
      void import("@/features/java/javaSession").then((module) => module.stopJavaSession());
    },
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

  function patchJava(patch: Partial<JavaPreferences>) {
    Object.assign(settings.java, normalizeJava({ ...settings.java, ...patch }));
  }

  /** 切换左侧工具窗口；传 null 收起（切换会退出该区最大化） */
  function setLeftWindow(id: LeftToolWindowId | null) {
    settings.layout.left.active = id;
    settings.layout.left.maximized = false;
    if (id) settings.layout.left.lastActive = id;
  }

  /** 收起 ↔ 展开（展开回到收起前的工具窗口） */
  function toggleLeftWindow() {
    setLeftWindow(
      settings.layout.left.active ? null : settings.layout.left.lastActive,
    );
  }

  function setLeftWidth(width: number) {
    settings.layout.left.width = clampLeftWidth(width);
  }

  /** 打开左侧 Commit 工具窗口（IDEA ⌘0 / WebStorm ⌘K） */
  function openCommitPanel() {
    setLeftWindow("commit");
  }

  function toggleCommitPanel() {
    setLeftWindow(settings.layout.left.active === "commit" ? null : "commit");
  }

  /** 打开左侧 Project 工具窗口（IDEA ⌘1） */
  function openProjectPanel() {
    setLeftWindow("project");
  }

  function toggleProjectPanel() {
    setLeftWindow(settings.layout.left.active === "project" ? null : "project");
  }

  /** 切换底部工具窗口；点同一个则收起（IDEA 行为；切换会退出该区最大化） */
  function setBottomWindow(id: BottomToolWindowId | null) {
    settings.layout.bottom.active = id;
    settings.layout.bottom.maximized = false;
    if (id) settings.layout.bottom.lastActive = id;
  }

  function toggleBottomWindow(id: BottomToolWindowId) {
    setBottomWindow(settings.layout.bottom.active === id ? null : id);
  }

  function setBottomHeight(height: number) {
    settings.layout.bottom.height = clampBottomHeight(height);
  }

  /** 切换右侧工具窗口；传 null 收起（切换会退出该区最大化） */
  function setRightWindow(id: RightToolWindowId | null) {
    settings.layout.right.active = id;
    settings.layout.right.maximized = false;
    if (id) settings.layout.right.lastActive = id;
  }

  function toggleRightWindow(id: RightToolWindowId) {
    setRightWindow(settings.layout.right.active === id ? null : id);
  }

  function setRightWidth(width: number) {
    settings.layout.right.width = clampRightWidth(width);
  }

  /**
   * 工具窗口 ⋮ 菜单「最大化 / 恢复」（IDEA Maximize Tool Window）：
   * 该区铺满工作区，其余区与编辑器临时隐藏；同一时刻只有一个区可最大化。
   */
  function toggleToolWindowMaximize(area: "left" | "bottom" | "right") {
    const target = settings.layout[area];
    const next = !target.maximized;
    settings.layout.left.maximized = false;
    settings.layout.bottom.maximized = false;
    settings.layout.right.maximized = false;
    target.maximized = next;
  }

  /** 工具窗口 ⋮ 菜单「重置尺寸」：恢复该区默认宽 / 高 */
  function resetToolWindowSize(area: "left" | "bottom" | "right") {
    if (area === "left") {
      settings.layout.left.width = DEFAULT_SETTINGS.layout.left.width;
      return;
    }
    if (area === "bottom") {
      settings.layout.bottom.height = DEFAULT_SETTINGS.layout.bottom.height;
      return;
    }
    settings.layout.right.width = DEFAULT_SETTINGS.layout.right.width;
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
    java: computed(() => settings.java),
    layout,
    isDark,
    setTheme,
    patchEditor,
    patchJava,
    setLeftWindow,
    toggleLeftWindow,
    setLeftWidth,
    openCommitPanel,
    toggleCommitPanel,
    openProjectPanel,
    toggleProjectPanel,
    setBottomWindow,
    toggleBottomWindow,
    setBottomHeight,
    setRightWindow,
    toggleRightWindow,
    setRightWidth,
    resetToolWindowSize,
    toggleToolWindowMaximize,
    setLocale,
    setAutoCheckUpdates,
    persistNow,
  };
});
