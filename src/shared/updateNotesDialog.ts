export type UpdateNotesAction = "install" | "later" | "close";

export interface UpdateNotesDialogOptions {
  version: string;
  notesMarkdown: string;
  /** 是否在底部展示「立即更新 / 稍后」 */
  showInstallActions?: boolean;
}

type UpdateNotesHandler = (
  options: UpdateNotesDialogOptions,
) => Promise<UpdateNotesAction | null>;

let handler: UpdateNotesHandler | null = null;

export function registerUpdateNotesHandler(next: UpdateNotesHandler | null) {
  handler = next;
}

export async function openUpdateNotesDialog(
  options: UpdateNotesDialogOptions,
): Promise<UpdateNotesAction | null> {
  if (!handler) {
    console.warn("[prismcode] UpdateNotesDialog 未挂载");
    return null;
  }
  return handler(options);
}
