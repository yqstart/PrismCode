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

/** 创建窗口并等待 `tauri://created`；失败时清掉随窗口写入的待开文件。 */
async function spawnWindow(
  windowId: string,
  url: string,
  title: string,
): Promise<void> {
  const webview = new WebviewWindow(`proj-${windowId}`, {
    title,
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
  await spawnWindow(windowId, url, `Prism Code — ${basename(folder)}`);
}

/**
 * 在新窗口以 light 模式打开独立文件：窗口不绑定任何工作区，只展示这些文件，
 * 因此「用 Prism Code 打开文件」不会把文件所在目录当成项目。
 */
export async function openLightInNewWindow(
  targets: readonly ExternalOpenTarget[],
): Promise<void> {
  const files = targets.filter((target) => !target.isDir && target.path.trim());
  if (!files.length) return;
  const windowId = createWindowSessionId();
  saveBootFiles(windowId, files);
  const title =
    files.length > 1
      ? `Prism Code — ${basename(files[0]!.path)} 等 ${files.length} 个文件`
      : `Prism Code — ${basename(files[0]!.path)}`;
  await spawnWindow(
    windowId,
    `index.html?windowId=${encodeURIComponent(windowId)}`,
    title,
  );
}
