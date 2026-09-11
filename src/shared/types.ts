export type ThemeId = "prism-dark" | "dawn" | "midnight" | "cyberpunk";

export const EDITOR_FONT_IDS = [
  "system",
  "jetbrains",
  "sarasa",
  "cascadia",
] as const;

export type EditorFontId = (typeof EDITOR_FONT_IDS)[number];

export function isEditorFontId(value: unknown): value is EditorFontId {
  return (
    typeof value === "string" && EDITOR_FONT_IDS.includes(value as EditorFontId)
  );
}

/** 左侧工具窗口：资源管理器 | Commit（WebStorm New UI） */
export type SidePanelId = "explorer" | "commit";

export type UpdateImportsOnMove = "always" | "prompt" | "never";

export function isUpdateImportsOnMove(
  value: unknown,
): value is UpdateImportsOnMove {
  return value === "always" || value === "prompt" || value === "never";
}

export interface EditorPreferences {
  /** 编辑器字体预设 ID；具体 CSS 字体栈由编辑器字体模块解析 */
  fontFamily: EditorFontId;
  fontSize: number;
  tabSize: 2 | 4;
  wordWrap: boolean;
  lineNumbers: boolean;
  /** 编辑后延迟自动保存到磁盘 */
  autoSave: boolean;
  /** 自动保存延迟（毫秒） */
  autoSaveDelayMs: number;
  /** 启用代码格式化（内置 Prettier 引擎，项目已装 prettier 时优先走项目本地） */
  prettierEnabled: boolean;
  /** 保存文件前自动格式化（需 prettierEnabled） */
  formatOnSave: boolean;
  /** 移动文件/文件夹后如何更新相对 import 引用 */
  updateImportsOnMove: UpdateImportsOnMove;
}

/** 历史兼容：曾用底栏 Git Log 高度；现 Git Log 为编辑区标签，open 不再驱动布局 */
export interface GitLogWindowState {
  open: boolean;
  height: number;
}

export interface LayoutState {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  activePanel: SidePanelId;
  gitLogWindow: GitLogWindowState;
  /** 底部终端面板高度（px），可拖拽调整并持久化 */
  terminalPanelHeight: number;
}

export interface AppSettings {
  theme: ThemeId;
  locale: "zh-CN" | "en-US";
  editor: EditorPreferences;
  layout: LayoutState;
  /** 启动时自动检查 GitHub Release 更新 */
  autoCheckUpdates: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "cyberpunk",
  locale: "zh-CN",
  editor: {
    fontFamily: "system",
    fontSize: 13,
    tabSize: 2,
    wordWrap: true,
    lineNumbers: true,
    autoSave: true,
    autoSaveDelayMs: 1000,
    prettierEnabled: true,
    formatOnSave: false,
    updateImportsOnMove: "prompt",
  },
  layout: {
    sidebarCollapsed: false,
    sidebarWidth: 300,
    activePanel: "explorer",
    gitLogWindow: {
      open: false,
      height: 280,
    },
    terminalPanelHeight: 240,
  },
  autoCheckUpdates: true,
};

export interface ThemeMeta {
  id: ThemeId;
  name: string;
  available: boolean;
  preview: "dark" | "light" | "midnight" | "cyber";
}

export interface EditorJumpTarget {
  path: string;
  line: number;
  column: number;
}

export interface EditorOpenAt {
  path: string;
  line: number;
  column: number;
  requestId: number;
}

/** 查找面板打开请求（原生菜单 ⌘F -> store 信号 -> 编辑器 watcher 消费） */
export interface EditorFindRequest {
  path: string | null;
  requestId: number;
}
