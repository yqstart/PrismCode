// ==================== 编辑器命令与键位预设 ====================
// Monaco 的内置 action 已经覆盖绝大多数编辑操作，这里只做两件事：
// 1) 按预设给内置 action 重新绑定键位（monaco.editor.addKeybindingRules）
// 2) 注册内置没有的自研命令（editor.addAction）
//
// 修饰键映射（macOS 语义，Windows/Linux 上 CtrlCmd 即 Ctrl）：
//   ⌘ → KeyMod.CtrlCmd   ⌃ → KeyMod.WinCtrl   ⌥ → KeyMod.Alt   ⇧ → KeyMod.Shift
import type { editor as MonacoEditorApi } from "monaco-editor/editor";
import { monaco } from "./setup";

export type KeymapPreset = "webstorm" | "vscode";

const { KeyMod, KeyCode } = monaco;

const CMD = KeyMod.CtrlCmd;
const CTRL = KeyMod.WinCtrl;
const ALT = KeyMod.Alt;
const SHIFT = KeyMod.Shift;

export interface Binding {
 /** Monaco 内置 action id */
 id: string;
 webstorm?: number;
 vscode?: number;
 /** WebStorm 预设下的附加键位（同一命令多个绑定） */
 webstormExtra?: number[];
 vscodeExtra?: number[];
}

/** 内置 action 的预设键位（对齐 WebStorm / VS Code 官方默认）；
 *  导出供自检逐条核对 action id 是否真实存在。 */
export const KEYMAP_BINDINGS: Binding[] = [
 // 导航
 { id: "editor.action.revealDefinition", webstorm: CMD | KeyCode.KeyB, webstormExtra: [KeyCode.F12], vscode: KeyCode.F12 },
 { id: "editor.action.goToTypeDefinition", webstorm: SHIFT | CMD | KeyCode.KeyB, vscode: undefined },
 { id: "editor.action.goToImplementation", webstorm: ALT | CMD | KeyCode.KeyB, vscode: CMD | KeyCode.F12 },
 { id: "editor.action.referenceSearch.trigger", webstorm: ALT | KeyCode.F7, vscode: SHIFT | ALT | KeyCode.F12 },
  { id: "editor.action.goToLocations", webstorm: CMD | KeyCode.F7, vscode: SHIFT | KeyCode.F12 },
 { id: "editor.action.rename", webstorm: SHIFT | KeyCode.F6, vscode: KeyCode.F2 },
 { id: "editor.action.quickFix", webstorm: ALT | KeyCode.Enter, vscode: CMD | KeyCode.Period },
 { id: "editor.action.showHover", webstorm: KeyCode.F1, vscode: undefined },
 { id: "editor.action.triggerParameterHints", webstorm: CMD | KeyCode.KeyP, vscode: SHIFT | CMD | KeyCode.Space },
 { id: "editor.action.triggerSuggest", webstorm: CTRL | KeyCode.Space, vscode: CTRL | KeyCode.Space },
 { id: "editor.action.marker.next", webstorm: KeyCode.F2, vscode: KeyCode.F8 },
 { id: "editor.action.marker.prev", webstorm: SHIFT | KeyCode.F2, vscode: SHIFT | KeyCode.F8 },
 { id: "editor.action.gotoLine", webstorm: CMD | KeyCode.KeyL, vscode: CTRL | KeyCode.KeyG },

 // 编辑
 { id: "editor.action.commentLine", webstorm: CMD | KeyCode.Slash, vscode: CMD | KeyCode.Slash },
 { id: "editor.action.blockComment", webstorm: ALT | CMD | KeyCode.Slash, vscode: SHIFT | ALT | KeyCode.KeyA },
 { id: "editor.action.transformToUppercase", webstorm: SHIFT | CMD | KeyCode.KeyU, vscode: undefined },
 { id: "editor.action.copyLinesDownAction", webstorm: CMD | KeyCode.KeyD, vscode: SHIFT | ALT | KeyCode.DownArrow },
 { id: "editor.action.deleteLines", webstorm: CMD | KeyCode.Backspace, vscode: SHIFT | CMD | KeyCode.KeyK },
 { id: "editor.action.moveLinesUpAction", webstorm: ALT | SHIFT | KeyCode.UpArrow, vscode: ALT | KeyCode.UpArrow },
 { id: "editor.action.moveLinesDownAction", webstorm: ALT | SHIFT | KeyCode.DownArrow, vscode: ALT | KeyCode.DownArrow },
 { id: "editor.action.joinLines", webstorm: CTRL | SHIFT | KeyCode.KeyJ, vscode: CTRL | KeyCode.KeyJ },
 { id: "editor.action.insertLineAfter", webstorm: SHIFT | KeyCode.Enter, vscode: CMD | KeyCode.Enter },
 { id: "editor.action.insertLineBefore", webstorm: ALT | CMD | KeyCode.Enter, vscode: SHIFT | CMD | KeyCode.Enter },
 { id: "editor.action.formatDocument", webstorm: ALT | CMD | KeyCode.KeyL, vscode: SHIFT | ALT | KeyCode.KeyF },
 { id: "editor.action.formatSelection", webstorm: ALT | CMD | KeyCode.KeyL, vscode: undefined },

 // 选择与多光标
 { id: "editor.action.smartSelect.expand", webstorm: ALT | KeyCode.UpArrow, vscode: CTRL | SHIFT | CMD | KeyCode.RightArrow },
 { id: "editor.action.smartSelect.shrink", webstorm: ALT | KeyCode.DownArrow, vscode: CTRL | SHIFT | CMD | KeyCode.LeftArrow },
 { id: "editor.action.addSelectionToNextFindMatch", webstorm: CTRL | KeyCode.KeyG, vscode: CMD | KeyCode.KeyD },
 { id: "editor.action.selectHighlights", webstorm: CMD | CTRL | KeyCode.KeyG, vscode: SHIFT | CMD | KeyCode.KeyL },
 { id: "editor.action.insertCursorAbove", webstorm: ALT | CMD | KeyCode.UpArrow, vscode: ALT | CMD | KeyCode.UpArrow },
 { id: "editor.action.insertCursorBelow", webstorm: ALT | CMD | KeyCode.DownArrow, vscode: ALT | CMD | KeyCode.DownArrow },
 { id: "editor.action.insertCursorAtEndOfEachLineSelected", webstorm: ALT | SHIFT | KeyCode.KeyG, vscode: SHIFT | ALT | KeyCode.KeyI },

 // 代码折叠与括号
 { id: "editor.fold", webstorm: CMD | KeyCode.Minus, vscode: ALT | CMD | KeyCode.BracketLeft },
 { id: "editor.unfold", webstorm: CMD | KeyCode.Equal, vscode: ALT | CMD | KeyCode.BracketRight },
 { id: "editor.foldAll", webstorm: SHIFT | CMD | KeyCode.Minus, vscode: undefined },
 { id: "editor.unfoldAll", webstorm: SHIFT | CMD | KeyCode.Equal, vscode: undefined },
 { id: "editor.action.jumpToBracket", webstorm: CTRL | KeyCode.KeyM, vscode: SHIFT | CMD | KeyCode.Backslash },
];

/** WebStorm 预设必须让位的 Monaco 内置默认键位 */
const DISABLED_DEFAULTS: Record<KeymapPreset, number[]> = {
 webstorm: [
  // 内置 ⌘D 是「选择下一个匹配」，WebStorm 的 ⌘D 是复制行
  CMD | KeyCode.KeyD,
  // 内置 ⌥↑/⌥↓ 是移动行，WebStorm 是扩展/收缩选择
  ALT | KeyCode.UpArrow,
  ALT | KeyCode.DownArrow,
  // 内置 ⌥⇧↑/⌥⇧↓ 是复制行，WebStorm 是移动行
  ALT | SHIFT | KeyCode.UpArrow,
  ALT | SHIFT | KeyCode.DownArrow,
  // 内置 F2 是重命名，WebStorm 的 F2 是下一个问题
  KeyCode.F2,
  // 内置 ⇧⌥A 是块注释，WebStorm 用 ⌥⌘/
  SHIFT | ALT | KeyCode.KeyA,
  // 内置 ⌘K 前缀（保持行）会吞掉 WebStorm 的 ⌘K 组合
  CMD | KeyCode.KeyK,
 ],
 vscode: [],
};

export interface EditorCommandOptions {
 /** 下一个 / 上一个 git 改动（自研命令） */
 onNextChange?: () => void;
 onPrevChange?: () => void;
 onToggleWordWrap?: () => void;
 onOpenProblems?: () => void;
}

const OWN_COMMAND_IDS = {
 nextChange: "prism.git.nextChange",
 prevChange: "prism.git.prevChange",
 toggleWordWrap: "prism.editor.toggleWordWrap",
 openProblems: "prism.workbench.problems",
} as const;

/**
 * 应用键位预设：撤销上一次注册的规则，再按当前预设重新绑定。
 * 返回 dispose 供切换预设 / 卸载时调用。
 */
export function applyKeymapPreset(preset: KeymapPreset): { dispose(): void } {
 const disposables: monaco.IDisposable[] = [];

 for (const keybinding of DISABLED_DEFAULTS[preset]) {
  disposables.push(monaco.editor.addKeybindingRule({ keybinding, command: null }));
 }

 for (const binding of KEYMAP_BINDINGS) {
  const primary = preset === "webstorm" ? binding.webstorm : binding.vscode;
  const extra = (preset === "webstorm" ? binding.webstormExtra : binding.vscodeExtra) ?? [];
  for (const keybinding of [...(primary !== undefined ? [primary] : []), ...extra]) {
   disposables.push(monaco.editor.addKeybindingRule({ keybinding, command: binding.id }));
  }
 }

 // WebStorm 的「选择下一个匹配」是 ⌃G；VS Code 的 ⌃G 是跳行，
 // 两者都已在上表中按预设绑定，无需额外处理。
 return {
  dispose() {
   for (const disposable of disposables) disposable.dispose();
   disposables.length = 0;
  },
 };
}

/** 注册内置没有的编辑器命令（幂等）；返回 dispose */
export function registerOwnCommands(
 editor: MonacoEditorApi.IStandaloneCodeEditor,
 options: EditorCommandOptions,
): { dispose(): void } {
 const disposables: monaco.IDisposable[] = [];
 const preset = () => editor; // 占位：键位由 applyKeymapPreset 统一绑定

 disposables.push(
  editor.addAction({
   id: OWN_COMMAND_IDS.nextChange,
   label: "下一个改动",
   run: () => {
    options.onNextChange?.();
   },
  }),
  editor.addAction({
   id: OWN_COMMAND_IDS.prevChange,
   label: "上一个改动",
   run: () => {
    options.onPrevChange?.();
   },
  }),
  editor.addAction({
   id: OWN_COMMAND_IDS.toggleWordWrap,
   label: "切换自动换行",
   keybindings: [ALT | KeyCode.KeyZ],
   run: () => {
    options.onToggleWordWrap?.();
   },
  }),
 );
 void preset;

 return {
  dispose() {
   for (const disposable of disposables) disposable.dispose();
   disposables.length = 0;
  },
 };
}

export const OWN_COMMANDS = OWN_COMMAND_IDS;
