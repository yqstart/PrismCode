import type { GitRebaseStep } from "@/shared/gitApi";

export interface InteractiveRebaseOptions {
  /** onto 提交或分支（不包含在重放列表中） */
  onto: string;
  title?: string;
}

type Handler = (options: InteractiveRebaseOptions) => Promise<boolean>;

let handler: Handler | null = null;

export function registerInteractiveRebaseHandler(next: Handler | null) {
  handler = next;
}

/** 打开交互式 Rebase 对话框；返回是否已开始执行 */
export async function openInteractiveRebase(
  options: InteractiveRebaseOptions,
): Promise<boolean> {
  if (!handler) {
    console.warn("[prismcode] InteractiveRebaseDialog 未挂载");
    return false;
  }
  return handler(options);
}

export type { GitRebaseStep };
