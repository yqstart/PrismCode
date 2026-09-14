import type { ThemeId } from "@/shared/types";
import type { ITheme } from "@xterm/xterm";

/** 终端配色：保证 ANSI 输出在浅/深底上均可读 */
export function terminalThemeColors(theme: ThemeId): ITheme {
  if (theme === "cyberpunk") {
    return {
      background: "#090811",
      foreground: "#f6f3fc",
      cursor: "#5eead4",
      cursorAccent: "#090811",
      selectionBackground: "rgba(94,234,212,0.28)",
      selectionForeground: "#ffffff",
      black: "#171425",
      red: "#fb7185",
      green: "#34d399",
      yellow: "#f6c453",
      blue: "#5eead4",
      magenta: "#e785ff",
      cyan: "#67e8f9",
      white: "#f6f3fc",
      brightBlack: "#a09cb4",
      brightRed: "#fda4af",
      brightGreen: "#6ee7b7",
      brightYellow: "#fde68a",
      brightBlue: "#67e8f9",
      brightMagenta: "#f0abfc",
      brightCyan: "#a5f3fc",
      brightWhite: "#ffffff",
    };
  }
  if (theme === "midnight") {
    return {
      background: "#080e1b",
      foreground: "#eef4fc",
      cursor: "#5ea1ff",
      cursorAccent: "#080e1b",
      selectionBackground: "rgba(94,161,255,0.28)",
      selectionForeground: "#ffffff",
      black: "#111b30",
      red: "#f87171",
      green: "#34d399",
      yellow: "#fbbf24",
      blue: "#5ea1ff",
      magenta: "#a78bfa",
      cyan: "#22d3ee",
      white: "#eef4fc",
      brightBlack: "#96a3ba",
      brightRed: "#fca5a5",
      brightGreen: "#6ee7b7",
      brightYellow: "#fde68a",
      brightBlue: "#8ab8ff",
      brightMagenta: "#c4b5fd",
      brightCyan: "#67e8f9",
      brightWhite: "#ffffff",
    };
  }
  if (theme === "dawn") {
    // 浅底略加深，前景与 ANSI 用深色系，避免「白底 + 浅色输出」发糊
    return {
      background: "#e9edf2",
      foreground: "#1c2029",
      cursor: "#4f6fe8",
      cursorAccent: "#e9edf2",
      selectionBackground: "rgba(79,111,232,0.24)",
      selectionForeground: "#1c2029",
      black: "#1c2029",
      red: "#b91c1c",
      green: "#047857",
      yellow: "#b45309",
      blue: "#3f5fd4",
      magenta: "#7e22ce",
      cyan: "#0e7490",
      white: "#475062",
      brightBlack: "#374151",
      brightRed: "#dc2626",
      brightGreen: "#059669",
      brightYellow: "#d97706",
      brightBlue: "#2563eb",
      brightMagenta: "#9333ea",
      brightCyan: "#0891b2",
      brightWhite: "#111827",
    };
  }
  return {
    background: "#0e0f13",
    foreground: "#f4f4f5",
    cursor: "#a78bfa",
    cursorAccent: "#0e0f13",
    selectionBackground: "rgba(167,139,250,0.28)",
    selectionForeground: "#ffffff",
    black: "#1b1d22",
    red: "#f87171",
    green: "#34d399",
    yellow: "#fbbf24",
    blue: "#60a5fa",
    magenta: "#c4a7ff",
    cyan: "#22d3ee",
    white: "#f4f4f5",
    brightBlack: "#a2a7b4",
    brightRed: "#fca5a5",
    brightGreen: "#6ee7b7",
    brightYellow: "#fde68a",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#ffffff",
  };
}
