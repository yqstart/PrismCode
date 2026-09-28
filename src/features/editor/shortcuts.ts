// ==================== 编辑器快捷键清单 ====================
// 仅供设置页展示与键位对照使用；实际绑定由编辑器内核的 keymap 注册。
// 命令注册表落地后，本表将由注册表生成。

/** 编辑器应用层快捷键的唯一键名来源（设置页展示与键位解析共用）。 */
export const EDITOR_KEYS = {
  goToDefinition: "Mod-b",
  goToDefinitionLegacy: "Mod-Enter",
  goToDefinitionF12: "F12",
  goBack: "Mod-[",
  goForward: "Mod-]",
  recentFiles: "Mod-e",
  rename: "F2",
  references: "Shift-F12",
  openFind: "Mod-f",
  openReplaceMac: "Mod-Alt-f",
  openReplace: "Mod-h",
  formatDocument: "Shift-Alt-f",
  reformatCode: "Mod-Alt-l",
  formatSelection: "Mod-k Mod-f",
  nextDiagnostic: "F8",
  previousDiagnostic: "Shift-F8",
  emmet: "Tab",
} as const;

export type ShortcutToken = "mod" | "alt" | "shift" | string;
export type ShortcutStroke = ShortcutToken[];

export interface EditorShortcutDescriptor {
  id: string;
  /** 规范键位写法；chord 用空格分隔。 */
  key: string;
  /** 设置页使用的跨平台展示形式。一个元素代表一个 chord stroke。 */
  strokes: ShortcutStroke[];
  labelKey: string;
}

/**
 * 设置页与编辑器 keymap 共用的快捷键说明。
 * 这里只登记编辑器内的高频操作；文件、终端、侧栏等工作台快捷键仍由设置页维护。
 */
export const EDITOR_SHORTCUTS: EditorShortcutDescriptor[] = [
  {
    id: "goToDefinition",
    key: EDITOR_KEYS.goToDefinition,
    strokes: [["mod", "B"]],
    labelKey: "settings.shortcutGoToDef",
  },
  {
    id: "goToDefinitionF12",
    key: EDITOR_KEYS.goToDefinitionF12,
    strokes: [["F12"]],
    labelKey: "settings.shortcutGoToDef",
  },
  {
    id: "goBack",
    key: EDITOR_KEYS.goBack,
    strokes: [["mod", "["]],
    labelKey: "settings.shortcutGoBack",
  },
  {
    id: "goForward",
    key: EDITOR_KEYS.goForward,
    strokes: [["mod", "]"]],
    labelKey: "settings.shortcutGoForward",
  },
  {
    id: "recentFiles",
    key: EDITOR_KEYS.recentFiles,
    strokes: [["mod", "E"]],
    labelKey: "settings.shortcutRecentFiles",
  },
  {
    id: "rename",
    key: EDITOR_KEYS.rename,
    strokes: [["F2"]],
    labelKey: "settings.shortcutRename",
  },
  {
    id: "references",
    key: EDITOR_KEYS.references,
    strokes: [["shift", "F12"]],
    labelKey: "settings.shortcutReferences",
  },
  {
    id: "formatDocument",
    key: EDITOR_KEYS.reformatCode,
    strokes: [["mod", "alt", "L"]],
    labelKey: "settings.shortcutFormat",
  },
  {
    id: "formatSelection",
    key: EDITOR_KEYS.formatSelection,
    strokes: [["mod", "K"], ["mod", "F"]],
    labelKey: "settings.shortcutFormatSelection",
  },
  {
    id: "selectNextOccurrence",
    key: "Mod-d",
    strokes: [["mod", "D"]],
    labelKey: "settings.shortcutSelectNextOccurrence",
  },
  {
    id: "selectAllOccurrences",
    key: "Mod-Shift-l",
    strokes: [["mod", "shift", "L"]],
    labelKey: "settings.shortcutSelectAllOccurrences",
  },
  {
    id: "moveLineUp",
    key: "Alt-ArrowUp",
    strokes: [["alt", "↑"]],
    labelKey: "settings.shortcutMoveLineUp",
  },
  {
    id: "moveLineDown",
    key: "Alt-ArrowDown",
    strokes: [["alt", "↓"]],
    labelKey: "settings.shortcutMoveLineDown",
  },
  {
    id: "copyLineUp",
    key: "Shift-Alt-ArrowUp",
    strokes: [["shift", "alt", "↑"]],
    labelKey: "settings.shortcutCopyLineUp",
  },
  {
    id: "copyLineDown",
    key: "Shift-Alt-ArrowDown",
    strokes: [["shift", "alt", "↓"]],
    labelKey: "settings.shortcutCopyLineDown",
  },
  {
    id: "addCursorAbove",
    key: "Mod-Alt-ArrowUp",
    strokes: [["mod", "alt", "↑"]],
    labelKey: "settings.shortcutAddCursorAbove",
  },
  {
    id: "addCursorBelow",
    key: "Mod-Alt-ArrowDown",
    strokes: [["mod", "alt", "↓"]],
    labelKey: "settings.shortcutAddCursorBelow",
  },
  {
    id: "deleteLine",
    key: "Shift-Mod-k",
    strokes: [["shift", "mod", "K"]],
    labelKey: "settings.shortcutDeleteLine",
  },
  {
    id: "toggleComment",
    key: "Mod-/",
    strokes: [["mod", "/"]],
    labelKey: "settings.shortcutToggleComment",
  },
  {
    id: "nextDiagnostic",
    key: EDITOR_KEYS.nextDiagnostic,
    strokes: [["F8"]],
    labelKey: "settings.shortcutNextDiagnostic",
  },
  {
    id: "previousDiagnostic",
    key: EDITOR_KEYS.previousDiagnostic,
    strokes: [["shift", "F8"]],
    labelKey: "settings.shortcutPreviousDiagnostic",
  },
  {
    id: "emmet",
    key: EDITOR_KEYS.emmet,
    strokes: [["Tab"]],
    labelKey: "settings.shortcutEmmet",
  },
];
