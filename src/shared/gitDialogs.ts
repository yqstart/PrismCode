export interface PushDialogResult {
  force: boolean;
}

type PushHandler = () => Promise<PushDialogResult | null>;

let pushHandler: PushHandler | null = null;

export function registerPushDialogHandler(next: PushHandler | null) {
  pushHandler = next;
}

/** 打开 Push 对话框；取消返回 null */
export async function openPushDialog(): Promise<PushDialogResult | null> {
  if (!pushHandler) {
    console.warn("[prismcode] PushDialog 未挂载");
    return null;
  }
  return pushHandler();
}

export type UpdateStrategy = "merge" | "rebase";

type UpdateHandler = () => Promise<UpdateStrategy | null>;

let updateHandler: UpdateHandler | null = null;

export function registerUpdateDialogHandler(next: UpdateHandler | null) {
  updateHandler = next;
}

export async function openUpdateProjectDialog(): Promise<UpdateStrategy | null> {
  if (!updateHandler) {
    console.warn("[prismcode] UpdateProjectDialog 未挂载");
    return null;
  }
  return updateHandler();
}
