import type { ImportPatch } from "@/shared/importReferences";

export interface MoveReferencesDialogOptions {
  title: string;
  hint: string;
  confirmText: string;
  cancelText: string;
  patches: ImportPatch[];
}

type MoveReferencesHandler = (
  options: MoveReferencesDialogOptions,
) => Promise<ImportPatch[] | null>;

let handler: MoveReferencesHandler | null = null;

export function registerMoveReferencesHandler(next: MoveReferencesHandler | null) {
  handler = next;
}

/** 预览并确认要应用的 import 引用变更；取消返回 null */
export async function showMoveReferencesDialog(
  options: MoveReferencesDialogOptions,
): Promise<ImportPatch[] | null> {
  if (!handler) {
    console.warn("[prismcode] MoveReferencesDialog 未挂载");
    return null;
  }
  return handler(options);
}
