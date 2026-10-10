export type ThemeId =
  | "intellij-dark"
  | "intellij-light"
  | "prism-dark"
  | "dawn"
  | "midnight"
  | "cyberpunk";

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

/** 左侧工具窗口（IDEA 工具窗口条上组）：项目 / Commit */
export type LeftToolWindowId = "project" | "commit";

/** 底部工具窗口（IDEA 工具窗口条下组）：终端 / 问题 / 调试 */
export type BottomToolWindowId = "terminal" | "problems" | "debug";

/** 全部工具窗口 ID */
export type ToolWindowId = LeftToolWindowId | BottomToolWindowId;

export type UpdateImportsOnMove = "always" | "prompt" | "never";

export function isUpdateImportsOnMove(
  value: unknown,
): value is UpdateImportsOnMove {
  return value === "always" || value === "prompt" || value === "never";
}

export type KeymapPreset = "webstorm" | "vscode";

export function isKeymapPreset(value: unknown): value is KeymapPreset {
  return value === "webstorm" || value === "vscode";
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
  /** 粘性滚动：当前作用域表头固定在编辑区顶部 */
  stickyScroll: boolean;
  /** 小地图 */
  minimap: boolean;
  /** 相对行号（当前行显示绝对值） */
  relativeLineNumbers: boolean;
  /** 垂直标尺列（按字符宽度；空数组表示不显示） */
  rulers: number[];
  /** 编辑器键位预设：WebStorm 或 VS Code 默认键位 */
  keymap: KeymapPreset;
  /** 使用项目本地 ESLint 做实时诊断（需项目已安装 eslint） */
  eslintEnabled: boolean;
  /** 移动文件/文件夹后如何更新相对 import 引用 */
  updateImportsOnMove: UpdateImportsOnMove;
}

/** 历史兼容：曾用底栏 Git Log 高度；现 Git Log 为编辑区标签，open 不再驱动布局 */
export interface GitLogWindowState {
  open: boolean;
  height: number;
}

/** 左侧工具窗口列：编辑器左侧的垂直工具窗口区（IDEA 布局） */
export interface LeftAreaState {
  /** 当前显示的工具窗口；null = 收起 */
  active: LeftToolWindowId | null;
  /** 收起前显示的工具窗口，再次展开时恢复 */
  lastActive: LeftToolWindowId;
  /** 列宽（px） */
  width: number;
}

/** 底部工具窗口区：编辑器下方的水平工具窗口区（IDEA 布局） */
export interface BottomAreaState {
  /** 当前显示的工具窗口；null = 收起 */
  active: BottomToolWindowId | null;
  /** 收起前显示的工具窗口，再次展开时恢复 */
  lastActive: BottomToolWindowId;
  /** 区高（px） */
  height: number;
}

export interface LayoutState {
  left: LeftAreaState;
  bottom: BottomAreaState;
  /** 历史兼容：曾用底栏 Git Log 高度；现 Git Log 为编辑区标签，open 不再驱动布局 */
  gitLogWindow: GitLogWindowState;
}

export interface JavaPreferences {
  /** 启用 Java 语言服务 */
  enabled: boolean;
  /** 语言服务 JVM 堆上限，512..4096 */
  serverMemoryMb: number;
  /** 无 Java 文件且窗口不活跃时自动停止的分钟数，0 表示不停 */
  idleStopMinutes: number;
  /** 覆盖内置运行时，留空用内置 */
  jrePath: string;
  /** 覆盖内置 JDTLS，留空用内置 */
  jdtlsPath: string;
  /** 覆盖内置调试适配器（java-debug 插件 jar 或它所在的目录），留空用内置 */
  adapterPath: string;
}

export interface AppSettings {
  theme: ThemeId;
  locale: "zh-CN" | "en-US";
  editor: EditorPreferences;
  layout: LayoutState;
  java: JavaPreferences;
  /** 启动时自动检查 GitHub Release 更新 */
  autoCheckUpdates: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "intellij-dark",
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
    stickyScroll: true,
    minimap: false,
    relativeLineNumbers: false,
    rulers: [100],
    keymap: "webstorm",
    eslintEnabled: false,
    updateImportsOnMove: "prompt",
  },
  layout: {
    left: {
      active: "project",
      lastActive: "project",
      width: 300,
    },
    bottom: {
      active: null,
      lastActive: "terminal",
      height: 240,
    },
    gitLogWindow: {
      open: false,
      height: 280,
    },
  },
  java: {
    enabled: true,
    serverMemoryMb: 1024,
    idleStopMinutes: 10,
    jrePath: "",
    jdtlsPath: "",
    adapterPath: "",
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
