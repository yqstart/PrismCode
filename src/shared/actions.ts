// ==================== 全局动作注册表 ====================
// Search Everywhere / 命令面板的动作来源。内置动作在模块加载时一次性注册，
// run 直接调用现有 Pinia store 的方法，不复制业务逻辑；
// title / category 用惰性函数取 i18n 文案，语言切换后无需重新注册即可生效。

import { t } from "@/i18n";
import { formatShortcut } from "@/shared/platform";
import { THEME_ORDER } from "@/shared/themes";
import { useDebugStore } from "@/stores/debug";
import { useEditorStore } from "@/stores/editor";
import { useGitStore } from "@/stores/git";
import { useGitLogStore } from "@/stores/gitLog";
import { useSearchStore } from "@/stores/search";
import { useSessionsStore } from "@/stores/sessions";
import { useSettingsStore } from "@/stores/settings";
import { useSshStore } from "@/stores/ssh";
import { useUiStore } from "@/stores/ui";
import { useWorkspaceStore } from "@/stores/workspace";

export interface ActionDef {
 id: string;
 /** 惰性取当前语言下的动作名 */
 title: () => string;
 /** 惰性取当前语言下的分组名（展示在动作行右侧） */
 category?: () => string;
 /** 平台化快捷键展示串（不参与键位注册，仅展示） */
 shortcut?: string;
 run: () => void | Promise<void>;
}

const registry = new Map<string, ActionDef>();

export function registerActions(defs: ActionDef[]): void {
 for (const def of defs) registry.set(def.id, def);
}

export function getAllActions(): ActionDef[] {
 return [...registry.values()];
}

export function findAction(id: string): ActionDef | undefined {
 return registry.get(id);
}

/**
 * 执行动作：命中即触发（异步 run 挂到微任务，不阻塞 UI），返回是否命中注册表。
 * run 抛错时只记日志：store 内部已负责面向用户的提示。
 */
export function executeAction(id: string): boolean {
 const action = registry.get(id);
 if (!action) return false;
 try {
  void Promise.resolve(action.run()).catch((error) => {
   console.warn(`[actions] 动作执行失败：${id}`, error);
  });
 } catch (error) {
  console.warn(`[actions] 动作执行失败：${id}`, error);
 }
 return true;
}

/** 动作 i18n key：`actions.<id>`，点号 / 冒号 / 连字符统一转下划线 */
function actionKey(id: string): string {
 return `actions.${id.replace(/[.:-]+/g, "_")}`;
}

/** 子序列模糊匹配评分：0 = 不匹配；连续命中、词边界、前缀命中加权，长名轻微降权 */
function fuzzySubsequenceScore(text: string, query: string): number {
 const lowerText = text.toLowerCase();
 const lowerQuery = query.toLowerCase();
 let score = 0;
 let textIndex = 0;
 let lastHit = -2;
 for (const ch of lowerQuery) {
  const hit = lowerText.indexOf(ch, textIndex);
  if (hit === -1) return 0;
  let bonus = 2;
  if (hit === lastHit + 1) bonus += 8; // 连续命中
  if (hit === 0) bonus += 6; // 名称开头
  else if (/[^a-z0-9]/.test(lowerText[hit - 1])) bonus += 4; // 词边界（分隔符后）
  else if (/[A-Z]/.test(text[hit])) bonus += 3; // camelCase 词首
  score += bonus;
  lastHit = hit;
  textIndex = hit + 1;
 }
 if (lowerText.startsWith(lowerQuery)) score += 30;
 else if (lowerText.includes(lowerQuery)) score += 15;
 return score - Math.min(8, Math.floor(text.length / 6)); // 短名优先
}

/**
 * 按名称模糊搜索动作；空查询返回全部（调用方自行截断展示条数）。
 * 中文标题与英文 id 都参与匹配，方便中英混合输入。
 */
export function searchActions(query: string): ActionDef[] {
 const q = query.trim();
 const actions = getAllActions();
 if (!q) return actions;
 return actions
  .map((action) => ({
   action,
   score: Math.max(
    fuzzySubsequenceScore(action.title(), q),
    fuzzySubsequenceScore(action.id, q),
   ),
  }))
  .filter((entry) => entry.score > 0)
  .sort((left, right) => right.score - left.score)
  .map((entry) => entry.action);
}

// ==================== 内置动作集 ====================

/** 动作定义工厂：统一从 id 推导 i18n key，避免逐条手写文案 key */
function defineAction(
 id: string,
 categoryKey: string,
 run: ActionDef["run"],
 shortcut?: string,
): ActionDef {
 return {
  id,
  title: () => t(actionKey(id)),
  category: () => t(categoryKey),
  shortcut,
  run,
 };
}

/** 关闭当前编辑器标签（没有活动文件时给一次提示，与 ⌘W 行为一致） */
function closeActiveEditor(): void {
 const editor = useEditorStore();
 if (!editor.activePath) {
  useWorkspaceStore().showNotice(t("notice.noActiveFile"));
  return;
 }
 void editor.closeTab(editor.activePath);
}

/** 打开左侧 Commit 工具窗口（可选顺手刷新变更列表） */
function openCommitToolWindow(): void {
 useSettingsStore().openCommitPanel();
 if (useWorkspaceStore().rootPath) void useGitStore().scheduleRefresh();
}

/** 显示 / 隐藏编辑区 Git Log 窗口（与活动栏入口同一套行为） */
function toggleGitLogWindow(): void {
 const gitLog = useGitLogStore();
 gitLog.toggleLog();
 if (gitLog.open && useWorkspaceStore().rootPath) {
  const git = useGitStore();
  void git.scheduleRefresh();
  void git.loadLog(100);
 }
}

/** ⌘K / Ctrl+K：切换 Commit 工具窗口（与 AppShell 菜单动作一致） */
function toggleCommitToolWindow(): void {
 const settings = useSettingsStore();
 settings.toggleCommitPanel();
 if (settings.layout.left.active === "commit" && useWorkspaceStore().rootPath) {
  void useGitStore().scheduleRefresh();
 }
}

const INITIAL_ACTIONS: ActionDef[] = [
 // ---------------- 文件 ----------------
 defineAction(
  "open_folder",
  "actions.category_file",
  () => void useWorkspaceStore().openFolder(),
  formatShortcut("mod", "O"),
 ),
 defineAction(
  "save",
  "actions.category_file",
  () => void useEditorStore().saveActive(),
  formatShortcut("mod", "S"),
 ),
 defineAction("save_all", "actions.category_file", () => void useEditorStore().saveAll()),
 defineAction(
  "close_editor",
  "actions.category_file",
  closeActiveEditor,
  formatShortcut("mod", "W"),
 ),
 // ---------------- 视图 ----------------
 defineAction("panel_project", "actions.category_view", () =>
  useSettingsStore().openProjectPanel(),
 ),
 defineAction(
  "panel_commit",
  "actions.category_view",
  openCommitToolWindow,
  formatShortcut("mod", "K"),
 ),
 defineAction("panel_gitlog", "actions.category_view", toggleGitLogWindow),
 defineAction(
  "panel_problems",
  "actions.category_view",
  () => useSessionsStore().showProblems(),
  formatShortcut("mod", "6"),
 ),
 defineAction("panel_ssh", "actions.category_view", () =>
  useSshStore().toggleSsh(),
 ),
 defineAction(
  "panel_terminal",
  "actions.category_view",
  () => useSessionsStore().toggleSessions(useWorkspaceStore().rootPath),
  formatShortcut("mod", "J"),
 ),
 defineAction(
  "toggle_sidebar",
  "actions.category_view",
  () => useSettingsStore().toggleLeftWindow(),
  formatShortcut("mod", "B"),
 ),
 // ---------------- 设置 ----------------
 defineAction(
  "open_settings",
  "actions.category_settings",
  () => useUiStore().openSettings(),
  formatShortcut("mod", ","),
 ),
 // ---------------- 主题 ----------------
 // 主题清单以 THEME_ORDER 为唯一来源：新增主题自动出现在动作列表
 ...THEME_ORDER.map((theme) =>
  defineAction(`theme_set:${theme}`, "actions.category_theme", () => {
   useSettingsStore().setTheme(theme);
  }),
 ),
 // ---------------- Git ----------------
 defineAction(
  "git_commit",
  "actions.category_git",
  toggleCommitToolWindow,
  formatShortcut("mod", "K"),
 ),
 defineAction(
  "git_update",
  "actions.category_git",
  () => void useGitStore().updateProject(),
 ),
 defineAction(
  "git_push",
  "actions.category_git",
  () => void useGitStore().pushWithDialog(),
 ),
 defineAction(
  "git_fetch",
  "actions.category_git",
  () => void useGitStore().fetchRemote(),
 ),
 // ---------------- 代码格式化 ----------------
 defineAction(
  "reformat_code",
  "actions.category_format",
  () => void useEditorStore().formatDocument(),
  formatShortcut("mod", "alt", "L"),
 ),
 // ---------------- 查找与导航（对齐 IDEA 菜单结构） ----------------
 defineAction(
  "find_in_files",
  "actions.category_search",
  () => useSearchStore().openFindInFiles(),
  formatShortcut("mod", "shift", "F"),
 ),
 defineAction(
  "replace_in_files",
  "actions.category_search",
  () => useSearchStore().openFindInFiles(),
  formatShortcut("mod", "shift", "R"),
 ),
 defineAction(
  "goto_file",
  "actions.category_search",
  () => useSearchStore().openQuickOpen(),
  formatShortcut("mod", "shift", "O"),
 ),
 defineAction(
  "recent_files",
  "actions.category_navigate",
  () => useSearchStore().openQuickOpen(),
  formatShortcut("mod", "E"),
 ),
 defineAction(
  "goto_symbol",
  "actions.category_navigate",
  () => useSearchStore().openSearchEverywhere("symbols"),
  formatShortcut("mod", "alt", "O"),
 ),
 defineAction(
  "goto_line",
  "actions.category_navigate",
  () => useEditorStore().requestMonacoCommand("editor.action.gotoLine"),
  formatShortcut("mod", "L"),
 ),
 defineAction(
  "back",
  "actions.category_navigate",
  () => {
   const editor = useEditorStore();
   const target = editor.takeJumpBack();
   if (target) editor.requestOpenAt(target.path, target.line, target.column);
  },
  formatShortcut("mod", "["),
 ),
 defineAction(
  "forward",
  "actions.category_navigate",
  () => {
   const editor = useEditorStore();
   const target = editor.takeJumpForward();
   if (target) editor.requestOpenAt(target.path, target.line, target.column);
  },
  formatShortcut("mod", "]"),
 ),
 defineAction("last_edit_location", "actions.category_navigate", () => {
  const editor = useEditorStore();
  if (!editor.goToLastEditLocation()) {
   useWorkspaceStore().showNotice(t("notice.noLastEditLocation"));
  }
 }),
 // ---------------- 编辑器命令（经活动编辑器执行 Monaco 内置命令） ----------------
 defineAction(
  "toggle_line_comment",
  "actions.category_format",
  () => useEditorStore().requestMonacoCommand("editor.action.commentLine"),
  formatShortcut("mod", "/"),
 ),
 defineAction(
  "fold_all",
  "actions.category_format",
  () => useEditorStore().requestMonacoCommand("editor.foldAll"),
  formatShortcut("mod", "shift", "-"),
 ),
 defineAction(
  "unfold_all",
  "actions.category_format",
  () => useEditorStore().requestMonacoCommand("editor.unfoldAll"),
  formatShortcut("mod", "shift", "+"),
 ),
 defineAction(
  "toggle_wrap",
  "actions.category_format",
  () => useEditorStore().requestMonacoCommand("prism.editor.toggleWordWrap"),
  formatShortcut("alt", "Z"),
 ),
 // ---------------- 调试 / 版本控制 / 关于 ----------------
 defineAction(
  "toggle_breakpoint",
  "actions.category_view",
  () => {
   const tab = useEditorStore().activeTab;
   if (tab) void useDebugStore().toggleBreakpoint(tab.path, tab.cursor.line);
  },
  formatShortcut("mod", "F8"),
 ),
 defineAction(
  "git_branches",
  "actions.category_git",
  () => useGitStore().requestBranches(),
 ),
 defineAction(
  "about",
  "actions.category_settings",
  () => useUiStore().openSettings("system"),
 ),
];

registerActions(INITIAL_ACTIONS);
