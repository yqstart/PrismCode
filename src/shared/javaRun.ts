export type JavaBuildTool = "maven-wrapper" | "maven" | "gradle-wrapper" | "gradle" | "none";

export interface JavaRunCommand {
  id: "test" | "build" | "clean" | "runFile";
  labelKey: string;
  command: string;
}

/** 终端顶栏芯片上的动作；与运行配置的 kind 正交（一条配置归一个动作） */
export type JavaRunAction = "test" | "package" | "clean" | "run";

export function detectJavaBuildTool(exists: (relPath: string) => boolean): JavaBuildTool {
  if (exists("mvnw") || exists("mvnw.cmd")) return "maven-wrapper";
  if (exists("pom.xml")) return "maven";
  if (exists("gradlew") || exists("gradlew.bat")) return "gradle-wrapper";
  if (exists("build.gradle") || exists("build.gradle.kts")) return "gradle";
  return "none";
}

function quote(path: string, sep: "/" | "\\"): string {
  const normalized = sep === "\\" ? path.replace(/\//g, "\\") : path.replace(/\\/g, "/");
  return /\s/.test(normalized) ? `"${normalized}"` : normalized;
}

function toolBin(tool: JavaBuildTool, sep: "/" | "\\"): string {
  if (tool === "maven-wrapper") return sep === "\\" ? ".\\mvnw.cmd" : "./mvnw";
  if (tool === "maven") return "mvn";
  if (tool === "gradle-wrapper") return sep === "\\" ? ".\\gradlew.bat" : "./gradlew";
  return "gradle";
}

export function javaRunCommands(
  tool: JavaBuildTool,
  opts: {
    className: string | null;
    filePath: string | null;
    javaBin: string | null;
    sep: "/" | "\\";
  },
): JavaRunCommand[] {
  if (tool === "maven-wrapper" || tool === "maven") {
    const bin = toolBin(tool, opts.sep);
    const testFilter = opts.className ? ` -Dtest=${opts.className}` : "";
    return [
      { id: "test", labelKey: "java.action.test", command: `${bin} -q test${testFilter}` },
      { id: "build", labelKey: "java.action.build", command: `${bin} -q -DskipTests package` },
      { id: "clean", labelKey: "java.action.clean", command: `${bin} -q clean` },
    ];
  }
  if (tool === "gradle-wrapper" || tool === "gradle") {
    const bin = toolBin(tool, opts.sep);
    const testFilter = opts.className ? ` --tests ${opts.className}` : "";
    return [
      { id: "test", labelKey: "java.action.test", command: `${bin} test${testFilter}` },
      { id: "build", labelKey: "java.action.build", command: `${bin} build` },
      { id: "clean", labelKey: "java.action.clean", command: `${bin} clean` },
    ];
  }
  if (tool === "none" && opts.javaBin && opts.filePath) {
    return [
      {
        id: "runFile",
        labelKey: "java.action.runFile",
        command: `${quote(opts.javaBin, opts.sep)} ${quote(opts.filePath, opts.sep)}`,
      },
    ];
  }
  return [];
}

/**
 * 把一条运行配置归到芯片动作上。判定只看 kind 与最后一段任务/目标名，
 * 不看 label：label 是给人看的，可能被项目层改掉。
 */
export function runActionOf(configuration: { kind: string; args: readonly string[] }): JavaRunAction | null {
  const goal = configuration.args.length ? configuration.args[configuration.args.length - 1] : "";
  // Maven 的 goal 与 Gradle 的任务名都可能带模块前缀（`:app:test`），取最后一段
  const segments = goal.split(":");
  const name = segments[segments.length - 1] ?? goal;
  switch (configuration.kind) {
    case "java.current-file":
    case "spring-boot.maven":
      return "run";
    case "maven.module":
      if (name === "test") return "test";
      if (name === "package") return "package";
      if (name === "clean") return "clean";
      return null;
    case "gradle.task":
      if (name === "test") return "test";
      if (name === "build" || name === "assemble" || name === "bootJar") return "package";
      if (name === "clean") return "clean";
      if (name === "bootRun" || name === "quarkusDev" || name === "run") return "run";
      return null;
    default:
      return null;
  }
}

/** 启动计划：与 Rust `runconfig_launch_plan` 的返回同形 */
export interface JavaLaunchPlan {
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  debugPort: number | null;
}

/** 当前平台是否是 Windows：本地终端用 PowerShell，环境变量前缀与 POSIX 不同 */
export function isWindowsPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Windows/i.test(navigator.platform || navigator.userAgent);
}

/**
 * 终端命令行的单个片段：只在必要时加引号。
 * 双引号在 POSIX shell 与 PowerShell 里都成立；内部的双引号与反斜杠转义。
 * 不给 `-Dfoo=a,b` 这类参数加引号，用户从终端复制出来的命令才跟界面一致。
 */
export function quoteArg(value: string): string {
  if (!value) return '""';
  if (!/[\s"'\\$`!&|;<>()*?[\]{}]/.test(value)) return value;
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

/**
 * 把启动计划拼成一行终端命令。环境变量走行内赋值前缀：
 * POSIX 是 `KEY=值 命令`，PowerShell 是 `$env:KEY='值'; 命令`。
 * 两种写法都只影响这一条命令，不会把调试参数留在用户 shell 里。
 */
export function launchCommandLine(
  plan: Pick<JavaLaunchPlan, "command" | "args" | "env">,
  windows = isWindowsPlatform(),
): string {
  const entries = Object.entries(plan.env ?? {});
  const command = [quoteArg(plan.command), ...(plan.args ?? []).map(quoteArg)].join(" ");
  if (!entries.length) return command;
  if (windows) {
    const assignments = entries
      .map(([key, value]) => `$env:${key}='${value.replace(/'/g, "''")}'`)
      .join("; ");
    return `${assignments}; ${command}`;
  }
  return `${entries.map(([key, value]) => `${key}=${quoteArg(value)}`).join(" ")} ${command}`;
}
