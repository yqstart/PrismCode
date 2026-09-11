export interface ChoiceOption {
  id: string;
  label: string;
  /** primary | danger | ghost，默认 ghost */
  variant?: "primary" | "danger" | "ghost";
}

export interface ChoiceDialogOptions {
  title: string;
  message: string;
  choices: ChoiceOption[];
  /** 点遮罩 / Esc 时返回的 id，默认 null */
  dismissId?: string | null;
}

type ChoiceHandler = (options: ChoiceDialogOptions) => Promise<string | null>;

let handler: ChoiceHandler | null = null;

/** 由 ChoiceDialog 组件挂载时注册 */
export function registerChoiceHandler(next: ChoiceHandler | null) {
  handler = next;
}

/**
 * 应用内多选项确认框（替代只能 OK/Cancel 的 window.confirm）。
 */
export async function promptChoice(
  options: ChoiceDialogOptions,
): Promise<string | null> {
  if (!handler) {
    console.warn("[prismcode] ChoiceDialog 未挂载，无法弹出确认框");
    return null;
  }
  return handler(options);
}
