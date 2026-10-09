import { ref, watch } from "vue";
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
  isWindowsPlatform,
  javaRunCommands,
  launchCommandLine,
  type JavaBuildTool,
  type JavaLaunchPlan,
  type JavaRunCommand,
} from "@/shared/javaRun";
import { pathExists, relativeToRoot } from "@/shared/fs";
import { emptySpringIndex, formatEndpointList, type SpringIndex } from "@/shared/springIndex";
import { selectExtraLibs } from "@/features/editor/monaco/languageBudget";
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

/** 与 Rust `runconfig` 的 kind 字面量一一对应，新增必须两边同时改 */
export type RunConfigurationKind = "java.current-file" | "maven.module" | "spring-boot.maven" | "gradle.task";

export interface RunConfiguration {
  id: string;
  label: string;
  kind: RunConfigurationKind;
  /** 项目相对模块路径，`.` 表示构建根 */
  module: string;
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** `declared`：构建文件里写明的；`inferred`：按约定推断 */
  confidence: string;
  toolchain: string | null;
}

export interface RunConfigDiagnostic {
  path: string;
  message: string;
  severity: string;
}

export interface ToolchainCandidate {
  id: string;
  kind: string;
  path: string;
  version: string;
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
  const runConfigurations = ref<RunConfiguration[]>([]);
  const runDiagnostics = ref<RunConfigDiagnostic[]>([]);
  const toolchains = ref<ToolchainCandidate[]>([]);
  const runLoading = ref(false);

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
        ? (path
            .split(/[/\\]/)
            .pop()
            ?.replace(/\.java$/i, "") ?? null)
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

  /**
   * 重算运行配置：工具链探测 + 生成层/项目层合并。
   * 构建文件是构建配置的一部分，改了 pom 之后由调用方再触发一次即可。
   */
  async function refreshRunConfigurations(): Promise<void> {
    const workspace = useWorkspaceStore();
    const root = workspace.rootPath;
    if (!root) {
      runConfigurations.value = [];
      runDiagnostics.value = [];
      toolchains.value = [];
      return;
    }
    runLoading.value = true;
    try {
      const candidates = await invoke<ToolchainCandidate[]>("runconfig_toolchains", { root });
      const resolved = await invoke<{
        effective: RunConfiguration[];
        diagnostics: RunConfigDiagnostic[];
      }>("runconfig_resolve", {
        root,
        toolchainCandidates: candidates,
        localOverrides: null,
      });
      toolchains.value = candidates;
      runConfigurations.value = resolved.effective;
      runDiagnostics.value = resolved.diagnostics;
    } catch (error) {
      runConfigurations.value = [];
      runDiagnostics.value = [];
      toolchains.value = [];
      workspace.showNotice(error instanceof Error ? error.message : String(error), 4000);
    } finally {
      runLoading.value = false;
    }
  }

  /** 只准备计划不执行：调试链路要先拿到 debugPort 才能起目标进程 */
  async function prepareLaunch(configurationId: string, debug = false): Promise<JavaLaunchPlan | null> {
    const workspace = useWorkspaceStore();
    const root = workspace.rootPath;
    if (!root) return null;
    try {
      return await invoke<JavaLaunchPlan>("runconfig_launch_plan", {
        root,
        configurationId,
        currentFile: useEditorStore().activeTab?.path ?? null,
        debug,
        debugPort: null,
      });
    } catch (error) {
      workspace.showNotice(error instanceof Error ? error.message : String(error), 4000);
      return null;
    }
  }

  /** 在本地终端执行一条运行配置；忙时由 sessions store 自动新开终端 */
  async function launchConfiguration(configurationId: string, debug = false): Promise<boolean> {
    const plan = await prepareLaunch(configurationId, debug);
    if (!plan) return false;
    const workspace = useWorkspaceStore();
    useSessionsStore().runInLocalTerminal(
      launchCommandLine(plan, isWindowsPlatform()),
      plan.cwd || workspace.rootPath,
    );
    return true;
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

  // ==================== Spring 索引 ====================
  const springIndex = ref<SpringIndex>(emptySpringIndex());
  const springLoading = ref(false);
  // 一次成功索引后置位：非 Spring 项目也只在首个文件打开时扫一次，避免重复全量扫描
  const springIndexLoaded = ref(false);

  const SPRING_SOURCE_RE = /\.(java|properties|ya?ml)$/i;

  /** 打开标签里参与索引的正文（工作区相对路径 → 内容）；上限与 TS 额外库一致：32 个、单个 256KB */
  function springTextOverrides(root: string): Record<string, string> {
    const candidates = useEditorStore()
      .tabs.filter((tab) => !tab.virtual && SPRING_SOURCE_RE.test(tab.path))
      .map((tab) => ({
        path: relativeToRoot(root, tab.path).replaceAll("\\", "/"),
        content: tab.content,
      }));
    const overrides: Record<string, string> = {};
    for (const item of selectExtraLibs(candidates)) overrides[item.path] = item.content;
    return overrides;
  }

  /** 重扫 Spring 索引；失败时清空并提示。返回是否拿到了新索引 */
  async function refreshSpringIndex(): Promise<boolean> {
    const workspace = useWorkspaceStore();
    const root = workspace.rootPath;
    if (!root) {
      springIndex.value = emptySpringIndex();
      springIndexLoaded.value = false;
      return false;
    }
    springLoading.value = true;
    try {
      springIndex.value = await invoke<SpringIndex>("spring_index", {
        request: {
          root,
          paths: [],
          metadataRepositories: [],
          refreshDependencyMetadata: true,
          textOverrides: springTextOverrides(root),
        },
      });
      springIndexLoaded.value = true;
      return true;
    } catch (error) {
      springIndex.value = emptySpringIndex();
      springIndexLoaded.value = false;
      workspace.showNotice(
        t("spring.notice.indexFailed", {
          detail: error instanceof Error ? error.message : String(error),
        }),
        4000,
      );
      return false;
    } finally {
      springLoading.value = false;
    }
  }

  /** 打开文件等隐式路径：已就绪或正在加载时直接返回，避免每次打开文件都重扫 */
  async function ensureSpringIndex(): Promise<void> {
    if (springIndexLoaded.value || springLoading.value) return;
    await refreshSpringIndex();
  }

  /** 打开只读端点标签；索引未就绪时先拉取，端点为空时给提示 */
  async function openSpringEndpoints(): Promise<void> {
    const workspace = useWorkspaceStore();
    if (!workspace.rootPath) {
      workspace.showNotice(t("spring.notice.unavailable"));
      return;
    }
    if (!springIndexLoaded.value && !(await refreshSpringIndex())) return;
    const endpoints = springIndex.value.endpoints;
    if (!endpoints.length) {
      workspace.showNotice(t("spring.endpoints.empty"), 3600);
      return;
    }
    useEditorStore().openVirtualTab(
      "spring:endpoints",
      t("spring.endpoints.title"),
      formatEndpointList(endpoints),
      "markdown",
    );
  }

  // 切换工作区后旧索引的相对路径全部失效，清空等下次惰性加载
  watch(
    () => useWorkspaceStore().rootPath,
    () => {
      springIndex.value = emptySpringIndex();
      springIndexLoaded.value = false;
    },
  );

  return {
    runtime,
    buildTool,
    status: javaStatus,
    runConfigurations,
    runDiagnostics,
    toolchains,
    runLoading,
    detect,
    commands,
    run,
    refreshRunConfigurations,
    prepareLaunch,
    launchConfiguration,
    start,
    stop,
    rebuildIndex,
    viewLogs,
    springIndex,
    springLoading,
    refreshSpringIndex,
    ensureSpringIndex,
    openSpringEndpoints,
  };
});
