import { ref } from "vue";
import { defineStore } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { t } from "@/i18n";
import {
  javaStatus,
  ensureJavaSession,
  stopJavaSession,
  currentJavaSessionId,
} from "@/features/java/javaSession";
import {
  detectJavaBuildTool,
  javaRunCommands,
  type JavaBuildTool,
  type JavaRunCommand,
} from "@/shared/javaRun";
import { pathExists } from "@/shared/fs";
import { useEditorStore } from "@/stores/editor";
import { useSessionsStore } from "@/stores/sessions";
import { useSettingsStore } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";

export interface JavaRuntimeSnapshot {
  javaVersion: string;
  jdtlsVersion: string;
  lombok: boolean;
  javaBin: string;
}

const BUILD_FILES = [
  "mvnw",
  "mvnw.cmd",
  "pom.xml",
  "gradlew",
  "gradlew.bat",
  "build.gradle",
  "build.gradle.kts",
];

export const useJavaStore = defineStore("java", () => {
  const runtime = ref<JavaRuntimeSnapshot | null>(null);
  const buildTool = ref<JavaBuildTool>("none");

  async function detect(): Promise<void> {
    const workspace = useWorkspaceStore();
    const settings = useSettingsStore();
    const root = workspace.rootPath;
    if (root) {
      const found = new Map<string, boolean>();
      await Promise.all(
        BUILD_FILES.map(async (relPath) => {
          try {
            found.set(relPath, await pathExists(root, relPath));
          } catch {
            found.set(relPath, false);
          }
        }),
      );
      buildTool.value = detectJavaBuildTool((relPath) => found.get(relPath) === true);
    }
    try {
      runtime.value = await invoke<JavaRuntimeSnapshot>("java_probe_runtime", {
        jrePath: settings.java.jrePath || null,
        jdtlsPath: settings.java.jdtlsPath || null,
      });
    } catch {
      runtime.value = null;
    }
  }

  function commands(): JavaRunCommand[] {
    const path = useEditorStore().activeTab?.path ?? null;
    const className =
      path && /\.java$/i.test(path)
        ? (path.split(/[/\\]/).pop()?.replace(/\.java$/i, "") ?? null)
        : null;
    const sep = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent) ? "\\" : "/";
    return javaRunCommands(buildTool.value, {
      className,
      filePath: path,
      javaBin: runtime.value?.javaBin ?? null,
      sep,
    });
  }

  async function run(id: JavaRunCommand["id"]): Promise<void> {
    const workspace = useWorkspaceStore();
    await detect();
    const command = commands().find((item) => item.id === id);
    if (!command || !workspace.rootPath) {
      workspace.showNotice(t("java.notice.commandMissing"));
      return;
    }
    useSessionsStore().runInLocalTerminal(command.command, workspace.rootPath);
  }

  async function start(): Promise<void> {
    await ensureJavaSession("manual");
  }

  async function stop(): Promise<void> {
    await stopJavaSession();
    useWorkspaceStore().showNotice(t("java.notice.stopped"));
  }

  async function rebuildIndex(): Promise<void> {
    const workspace = useWorkspaceStore();
    const settings = useSettingsStore();
    if (!workspace.rootPath) return;
    await stopJavaSession();
    try {
      await invoke("java_rebuild_index", {
        root: workspace.rootPath,
        jrePath: settings.java.jrePath || null,
        jdtlsPath: settings.java.jdtlsPath || null,
      });
      workspace.showNotice(t("java.notice.indexCleared"));
    } catch (error) {
      workspace.showNotice(error instanceof Error ? error.message : String(error), 3600);
    }
  }

  async function viewLogs(): Promise<void> {
    const workspace = useWorkspaceStore();
    const sessionId = currentJavaSessionId();
    if (!sessionId) {
      workspace.showNotice(t("java.notice.logsEmpty"));
      return;
    }
    try {
      const logs = await invoke<string[]>("lsp_logs", { sessionId });
      const tail = logs.slice(-30);
      workspace.showNotice(tail.length ? tail.join("\n") : t("java.notice.logsEmpty"), 6400);
    } catch {
      workspace.showNotice(t("java.notice.logsEmpty"));
    }
  }

  return {
    runtime,
    buildTool,
    status: javaStatus,
    detect,
    commands,
    run,
    start,
    stop,
    rebuildIndex,
    viewLogs,
  };
});
