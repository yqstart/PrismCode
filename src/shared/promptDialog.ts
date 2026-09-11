export interface PromptDialogOptions {
  title: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
}

type PromptHandler = (options: PromptDialogOptions) => Promise<string | null>;

let handler: PromptHandler | null = null;

/** 由 PromptDialog 组件挂载时注册 */
export function registerPromptHandler(next: PromptHandler | null) {
  handler = next;
}

/**
 * 应用内输入框（替代 window.prompt）。
 * Tauri WebView 通常不支持 window.prompt，会直接返回 null。
 */
export async function promptInput(
  options: PromptDialogOptions,
): Promise<string | null> {
  if (!handler) {
    console.warn("[prismcode] PromptDialog 未挂载，无法弹出输入框");
    return null;
  }
  return handler(options);
}
