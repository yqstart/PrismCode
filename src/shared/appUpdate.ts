import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { t } from "@/i18n";
import { resolveUpdateNotes } from "@/shared/changelog";
import { promptChoice } from "@/shared/choiceDialog";
import { openUpdateNotesDialog } from "@/shared/updateNotesDialog";
import { useAppUpdateStore } from "@/stores/appUpdate";
import { pinia } from "@/stores/pinia";

export type CheckUpdateMode = "auto" | "manual";

export type CheckUpdateResult =
  | "updated"
  | "available"
  | "deferred"
  | "latest"
  | "skipped"
  | "error";

type NotifyFn = (message: string, ms?: number) => void;

/** Tauri Update 资源，不能放进 Pinia */
let pendingUpdate: Update | null = null;

let checking = false;
let installing = false;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 读取壳内版本号；纯 Vite 预览回退到 package 版本占位 */
export async function getAppVersion(): Promise<string> {
  if (!isTauriRuntime()) return "0.4.0";
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return "0.4.0";
  }
}

/** 在 await 前取得 store，避免异步上下文丢失 active Pinia */
function updateStore() {
  return useAppUpdateStore(pinia);
}

/** 打开新版本更新说明弹窗 */
export async function showAvailableUpdateNotes(
  showInstallActions = true,
): Promise<"install" | "later" | "close" | null> {
  const store = updateStore();
  const version = store.availableVersion;
  if (!version) return null;
  let notes = store.releaseNotes;
  if (!notes.trim() && pendingUpdate) {
    notes = await resolveUpdateNotes(version, pendingUpdate.body ?? "");
    store.setAvailable(version, store.currentVersion ?? "", notes);
  }
  return openUpdateNotesDialog({
    version,
    notesMarkdown: notes,
    showInstallActions: showInstallActions && Boolean(pendingUpdate),
  });
}

/**
 * 检查 GitHub Release 上的 latest.json。
 * - auto：有更新时仅点亮右上角「更新」（不打断）
 * - manual：弹出「稍后 / 立即更新」；稍后仍保留右上角入口
 */
export async function checkForAppUpdate(
  mode: CheckUpdateMode,
  notify?: NotifyFn,
): Promise<CheckUpdateResult> {
  const store = updateStore();

  if (!isTauriRuntime()) {
    if (mode === "manual") notify?.(t("update.browserPreview"));
    return "skipped";
  }
  if (import.meta.env.DEV) {
    if (mode === "manual") notify?.(t("update.devBuild"));
    return "skipped";
  }
  if (checking || installing) {
    if (mode === "manual") notify?.(t("update.checking"));
    return "skipped";
  }
  checking = true;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      if (pendingUpdate) {
        void pendingUpdate.close().catch(() => undefined);
        pendingUpdate = null;
      }
      store.clearAvailable();
      if (mode === "manual") notify?.(t("update.latest"));
      return "latest";
    }

    pendingUpdate = update;
    const notes = await resolveUpdateNotes(update.version, update.body ?? "");
    store.setAvailable(update.version, update.currentVersion, notes);

    // 启动静默检查：点亮入口并提示可查看更新内容
    if (mode === "auto") {
      notify?.(
        t("update.autoFoundHint", { version: update.version }),
        6200,
      );
      return "available";
    }

    const choice = await promptChoice({
      title: t("update.foundTitle"),
      message: t("update.foundMessage", {
        version: update.version,
        current: update.currentVersion,
      }),
      choices: [
        { id: "notes", label: t("update.viewNotes"), variant: "ghost" },
        { id: "later", label: t("update.later"), variant: "ghost" },
        { id: "install", label: t("update.installNow"), variant: "primary" },
      ],
      dismissId: "later",
    });

    if (choice === "notes") {
      const action = await showAvailableUpdateNotes(true);
      if (action === "install") {
        return await installPendingUpdate(notify);
      }
      notify?.(
        t("update.foundHint", { version: update.version }),
        4800,
      );
      return "available";
    }

    if (choice !== "install") {
      notify?.(
        t("update.foundHint", {
          version: update.version,
        }),
        4800,
      );
      return "available";
    }

    return await installPendingUpdate(notify);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (mode === "manual") {
      notify?.(t("update.checkFailed", { message: msg }), 4200);
    } else {
      console.warn("[prismcode] 自动检查更新失败", error);
    }
    return "error";
  } finally {
    checking = false;
  }
}

/**
 * 下载并安装已发现的更新：展示进度 → 询问是否立即重启。
 * 取消则下次启动应用更新；确认则立即 relaunch。
 */
export async function installPendingUpdate(
  notify?: NotifyFn,
): Promise<CheckUpdateResult> {
  const store = updateStore();

  if (!isTauriRuntime()) {
    notify?.(t("update.browserPreview"));
    return "skipped";
  }
  if (!pendingUpdate) {
    notify?.(t("update.noPending"), 3200);
    return "skipped";
  }
  if (installing) {
    notify?.(t("update.downloading"), 3200);
    return "skipped";
  }

  installing = true;
  const update = pendingUpdate;
  try {
    store.beginDownload();
    await update.downloadAndInstall((event: DownloadEvent) => {
      store.onDownloadEvent(event);
    });
    store.endDownload();

    const choice = await promptChoice({
      title: t("update.readyTitle"),
      message: t("update.readyMessage", { version: update.version }),
      choices: [
        { id: "later", label: t("common.cancel"), variant: "ghost" },
        { id: "now", label: t("common.ok"), variant: "primary" },
      ],
      dismissId: "later",
    });

    pendingUpdate = null;
    store.clearAvailable();
    void update.close().catch(() => undefined);

    if (choice === "now") {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
      return "updated";
    }

    notify?.(t("update.willApplyOnNextLaunch"), 4800);
    return "deferred";
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    notify?.(t("update.installFailed", { message: msg }), 4800);
    return "error";
  } finally {
    store.endDownload();
    installing = false;
  }
}
