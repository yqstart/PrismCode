// 主题展示元数据（与编辑器内核无关，供状态栏与设置面板使用）
import type { ThemeId } from "@/shared/types";

export const THEME_LABELS: Record<ThemeId, string> = {
  "intellij-dark": "IntelliJ Dark",
  "intellij-light": "IntelliJ Light",
  "prism-dark": "Prism Dark",
  dawn: "Prism Light",
  midnight: "Prism Midnight",
  cyberpunk: "Prism Cyberpunk",
};

/** 状态栏快捷切换顺序 */
export const THEME_ORDER: ThemeId[] = [
  "intellij-dark",
  "intellij-light",
  "prism-dark",
  "dawn",
  "midnight",
  "cyberpunk",
];
