import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { basename } from "@/shared/fs";
import {
  createWindowSessionId,
  removeWindowSession,
  saveWindowSession,
  windowLabel,
} from "@/shared/windowSession";

export interface BootWindowState {
  folder: string | null;
  windowId: string | null;
}

/** 从启动 URL 读取窗口要打开的工作区和稳定窗口 ID。 */
export function readBootState(): BootWindowState {
  try {
    const params = new URLSearchParams(window.location.search);
    const folder = params.get("folder");
    const windowId = params.get("windowId");
    return {
      folder: folder?.trim() ? folder : null,
      windowId: windowId?.trim() ? windowId : null,
    };
  } catch {
    return { folder: null, windowId: null };
  }
}

/** 从启动 URL 读取新窗口要打开的文件夹（兼容旧调用方）。 */
export function readBootFolder(): string | null {
  return readBootState().folder;
}

/** 在新窗口中打开指定文件夹；restoreId 用于重启后复用原窗口身份。 */
export async function openFolderInNewWindow(
  folder: string,
  options?: { windowId?: string },
): Promise<void> {
  const windowId = options?.windowId ?? createWindowSessionId();
  const label = windowLabel(windowId);
  const url =
    `index.html?folder=${encodeURIComponent(folder)}` +
    `&windowId=${encodeURIComponent(windowId)}`;
  // 先注册再创建，确保极短的启动/退出窗口内也不会丢失这条记录；创建失败
  // 时回滚，避免下次启动反复尝试不存在的动态窗口。
  saveWindowSession(folder, windowId);
  const webview = new WebviewWindow(label, {
    title: `Prism Code — ${basename(folder)}`,
    url,
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    focus: true,
    titleBarStyle: "overlay",
    hiddenTitle: true,
    acceptFirstMouse: true,
  });

  await new Promise<void>((resolve, reject) => {
    void webview.once("tauri://created", () => resolve());
    void webview.once("tauri://error", (event) => {
      removeWindowSession(windowId);
      reject(new Error(String(event.payload ?? "创建新窗口失败")));
    });
  });
}
