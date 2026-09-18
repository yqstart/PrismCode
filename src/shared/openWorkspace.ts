import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { basename } from "@/shared/fs";
import type { ExternalOpenTarget } from "@/shared/externalOpen";
import { removeBootFiles, saveBootFiles } from "@/shared/externalOpenRoute";
import { createWindowSessionId } from "@/shared/windowSession";

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

/** 在新窗口中打开指定文件夹。 */
export async function openFolderInNewWindow(
  folder: string,
  options?: { bootFiles?: readonly ExternalOpenTarget[] },
): Promise<void> {
  const windowId = createWindowSessionId();
  const url =
    `index.html?folder=${encodeURIComponent(folder)}` +
    `&windowId=${encodeURIComponent(windowId)}`;
  // 待开文件跟随窗口 ID 写入 localStorage：新窗口启动时一次性取走，
  // 避免 URL 编码长路径；写入失败只影响文件定位，不阻断窗口创建。
  if (options?.bootFiles?.length) saveBootFiles(windowId, options.bootFiles);
  const webview = new WebviewWindow(`proj-${windowId}`, {
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
      removeBootFiles(windowId);
      reject(new Error(String(event.payload ?? "创建新窗口失败")));
    });
  });
}
