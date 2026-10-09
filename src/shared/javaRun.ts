export type JavaBuildTool = "maven-wrapper" | "maven" | "gradle-wrapper" | "gradle" | "none";

export interface JavaRunCommand {
  id: "test" | "build" | "clean" | "runFile";
  labelKey: string;
  command: string;
}

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
