// ==================== Java 语言服务纯逻辑自测 ====================
import assert from "node:assert/strict";
import { LspClient, LspRequestError } from "../src/features/editor/lsp/client.ts";
import type { LspTransport } from "../src/features/editor/lsp/transport.ts";
import {
  MARKER_SEVERITY,
  completionKindToMonaco,
  pathToUri,
  symbolKindToMonaco,
  toMonacoMarker,
  uriToPath,
} from "../src/features/editor/lsp/convert.ts";
import { planCompareTabEviction, MAX_COMPARE_TABS } from "../src/features/git/compareTabs.ts";
import {
  DidOpenQueue,
  applyLspTextEdits,
  isJavaWatchedPath,
  isServiceReady,
  javaConfigurationForSection,
  toDidChangeParams,
  workspaceEditBlockReason,
} from "../src/features/java/jdtls.ts";
import {
  detectJavaBuildTool,
  javaRunCommands,
  launchCommandLine,
  quoteArg,
  runActionOf,
} from "../src/shared/javaRun.ts";
import {
  completionItems,
  emptySpringIndex,
  formatEndpointList,
  isSpringConfigPath,
  springMarkerInputs,
  type SpringIndex,
} from "../src/shared/springIndex.ts";

assert.equal(pathToUri("/Users/me/Hello World.java"), "file:///Users/me/Hello%20World.java");
assert.equal(pathToUri("C:\\src\\中文.java"), "file:///C:/src/%E4%B8%AD%E6%96%87.java");
assert.equal(uriToPath("file:///C:/src/A.java"), "C:/src/A.java");
assert.equal(uriToPath("file:///tmp/a%20b.java"), "/tmp/a b.java");

const marker = toMonacoMarker({
  range: { start: { line: 0, character: 4 }, end: { line: 0, character: 8 } },
  severity: 1,
  message: "类型不匹配",
});
assert.equal(marker.severity, MARKER_SEVERITY.error);
assert.equal(marker.source, "Java");
assert.equal(marker.startLineNumber, 1);
assert.equal(completionKindToMonaco(2), 0, "LSP Method → Monaco Method");
assert.equal(completionKindToMonaco(15), 28, "LSP Snippet → Monaco Snippet");
assert.equal(symbolKindToMonaco(1), 0);
assert.equal(symbolKindToMonaco(99), 25);

const sent: string[] = [];
const transport: LspTransport = {
  async send(message) {
    sent.push(message);
  },
  async close() {},
};
const notes: string[] = [];
const client = new LspClient({
  transport,
  requestTimeoutMs: 20,
  onNotification(method) {
    notes.push(method);
  },
  onServerRequest() {
    return Promise.reject(new Error("未实现"));
  },
});
const pending = client.request("textDocument/hover", { textDocument: { uri: "file:///A.java" } });
client.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 999, result: "ignored" }));
client.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
const hover = await pending;
assert.equal(hover, null);
client.handleMessage(JSON.stringify({ jsonrpc: "2.0", method: "window/logMessage", params: {} }));
assert.deepEqual(notes, ["window/logMessage"]);
client.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "client/registerCapability" }));
await new Promise((resolve) => setTimeout(resolve, 0));
const serverReply = JSON.parse(sent.at(-1) ?? "{}") as { error?: { code?: number } };
assert.equal(serverReply.error?.code, -32601);
client.dispose();
await assert.rejects(client.request("shutdown"), (error: unknown) => {
  assert.ok(error instanceof LspRequestError);
  assert.equal(error.code, -32800);
  return true;
});

const queue = new DidOpenQueue();
queue.push({ uri: "file:///A.java", languageId: "java", version: 1, text: "a" });
queue.push({ uri: "file:///B.java", languageId: "java", version: 1, text: "b" });
queue.push({ uri: "file:///A.java", languageId: "java", version: 2, text: "aa" });
assert.deepEqual(
  queue.drain().map((item) => item.uri),
  ["file:///A.java", "file:///B.java"],
);
assert.equal(isServiceReady({ type: "ServiceReady" }), true);
assert.notEqual(javaConfigurationForSection("java"), null);
assert.equal(javaConfigurationForSection("other"), null);
assert.equal(isJavaWatchedPath("src/Hello.java"), true);
assert.equal(isJavaWatchedPath("pom.xml"), true);
assert.equal(isJavaWatchedPath("README.md"), false);
const change = toDidChangeParams("file:///A.java", 3, [
  {
    range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
    text: "x",
  },
]);
assert.equal(change.contentChanges[0]?.range.start.line, 0);
assert.equal(applyLspTextEdits("ab", [{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, newText: "c" }]), "ac");
assert.equal(workspaceEditBlockReason({ changes: { "jdt://contents/A.class": [] } }), "不能把编辑写到反编译类");
assert.equal(workspaceEditBlockReason({ documentChanges: [{ kind: "rename" }] }), "暂不应用文件创建、重命名或删除");

assert.equal(detectJavaBuildTool((path) => path === "pom.xml"), "maven");
assert.equal(detectJavaBuildTool((path) => path === "mvnw"), "maven-wrapper");
assert.equal(detectJavaBuildTool((path) => path === "build.gradle.kts"), "gradle");
assert.equal(detectJavaBuildTool(() => false), "none");
const maven = javaRunCommands("maven", { className: "Hello", filePath: null, javaBin: null, sep: "/" });
assert.equal(maven.find((item) => item.id === "test")?.command, "mvn -q test -Dtest=Hello");
const standalone = javaRunCommands("none", {
  className: "Hello",
  filePath: "/tmp/My Class.java",
  javaBin: "/opt/java",
  sep: "/",
});
assert.equal(standalone[0]?.command, '/opt/java "/tmp/My Class.java"');

const kept = planCompareTabEviction(["a", "b", "c", "d", "e", "f"], "f", "g");
assert.equal(kept.length, MAX_COMPARE_TABS);
assert.equal(kept.includes("g"), true);
assert.equal(kept.includes("f"), true);
assert.equal(kept.includes("a"), false);

// ==================== 运行配置芯片：动作归类与命令行拼装 ====================
assert.equal(runActionOf({ kind: "spring-boot.maven", args: ["-B", "spring-boot:run"] }), "run");
assert.equal(runActionOf({ kind: "java.current-file", args: [] }), "run");
assert.equal(runActionOf({ kind: "maven.module", args: ["-B", "-ntp", "-pl", "app", "test"] }), "test");
assert.equal(runActionOf({ kind: "maven.module", args: ["-B", "-DskipTests", "package"] }), "package");
assert.equal(runActionOf({ kind: "maven.module", args: ["-B", "clean"] }), "clean");
assert.equal(runActionOf({ kind: "gradle.task", args: [":app:bootRun"] }), "run");
assert.equal(runActionOf({ kind: "gradle.task", args: [":app:quarkusDev"] }), "run");
assert.equal(runActionOf({ kind: "gradle.task", args: [":app:build"] }), "package");
assert.equal(runActionOf({ kind: "gradle.task", args: [":app:jar"] }), null);

const jdwp = "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:5005";
assert.equal(quoteArg("./mvnw"), "./mvnw");
assert.equal(quoteArg(jdwp), jdwp, "无空格的 JVM 参数不加引号");
assert.equal(quoteArg("/tmp/My Class.java"), '"/tmp/My Class.java"');
assert.equal(quoteArg(""), '""');
assert.equal(launchCommandLine({ command: "./mvnw", args: ["-B", "test"], env: {} }), "./mvnw -B test");
assert.equal(
  launchCommandLine({ command: "./mvnw", args: ["-B", "test"], env: { MAVEN_OPTS: jdwp } }, false),
  `MAVEN_OPTS=${jdwp} ./mvnw -B test`,
);
assert.equal(
  launchCommandLine({ command: "./gradlew", args: [":app:test"], env: { JAVA_TOOL_OPTIONS: jdwp } }, true),
  `$env:JAVA_TOOL_OPTIONS='${jdwp}'; ./gradlew :app:test`,
);
assert.equal(
  launchCommandLine({
    command: "./mvnw",
    args: ["-B", "-Dspring-boot.run.jvmArguments=" + jdwp, "spring-boot:run"],
    env: {},
  }),
  `./mvnw -B -Dspring-boot.run.jvmArguments=${jdwp} spring-boot:run`,
);

// ==================== Spring 索引：补全 / 诊断 / 端点文本 ====================
const springIndex: SpringIndex = {
  properties: [
    { name: "server.port", defaultValue: "8080", source: "project" },
    {
      name: "spring.datasource.url",
      defaultValue: null,
      source: "spring-boot-autoconfigure.jar",
    },
    { name: "server.port", defaultValue: "9090", source: "重复项应被去重" },
  ],
  values: [
    { path: "src/main/resources/application.properties", name: "server.port", value: "8081" },
    { path: "src/main/resources/application.yml", name: "custom.flag", value: "on" },
  ],
  beans: [],
  injections: [],
  endpoints: [
    { path: "src/main/java/app/BController.java", method: "POST", route: "/b", line: 10 },
    { path: "src/main/java/app/AController.java", method: "GET", route: "/hello", line: 30 },
    { path: "src/main/java/app/AController.java", method: "GET", route: "/ping", line: 12 },
  ],
  diagnostics: [{ path: "src/main/java/app/App.java", line: 7, message: "未找到配置项 app.missing" }],
};
assert.deepEqual(emptySpringIndex(), {
  properties: [],
  values: [],
  beans: [],
  injections: [],
  endpoints: [],
  diagnostics: [],
});

assert.equal(isSpringConfigPath("src/main/resources/application.properties"), true);
assert.equal(isSpringConfigPath("application-dev.yml"), true);
assert.equal(isSpringConfigPath("bootstrap.yaml"), true);
assert.equal(isSpringConfigPath("bootstrap-test.properties"), true);
assert.equal(isSpringConfigPath("myapplication.properties"), false);
assert.equal(isSpringConfigPath("application.json"), false);
assert.equal(isSpringConfigPath("src/main/java/App.java"), false);

const candidates = completionItems(springIndex, "serv", "src/main/resources/application.properties");
assert.deepEqual(
  candidates.map((item) => item.name),
  ["server.port", "spring.datasource.url", "custom.flag"],
  "元数据键在前、项目值键去重补漏",
);
assert.equal(candidates[0]?.detail, "8080", "detail 用默认值");
assert.equal(candidates[1]?.detail, "spring-boot-autoconfigure.jar", "无默认值时用来源");
assert.equal(candidates[2]?.detail, "src/main/resources/application.yml", "项目键用声明文件");
assert.deepEqual(
  completionItems(springIndex, "server.port=8081", "src/main/resources/application.properties").map(
    (item) => item.name,
  ),
  ["spring.datasource.url", "custom.flag"],
  "当前行已写完整键名时同名候选被过滤",
);
assert.deepEqual(
  completionItems(springIndex, "custom.flag: on", "src/main/resources/application.yml").map(
    (item) => item.name,
  ),
  ["server.port", "spring.datasource.url"],
  "yml 按冒号切分已写键名",
);

const endpointList = formatEndpointList(springIndex.endpoints);
assert.equal(endpointList.split("\n")[0], "# Spring 端点（3）");
assert.deepEqual(endpointList.split("\n").slice(1), [
  "GET  /ping  src/main/java/app/AController.java:12",
  "GET  /hello  src/main/java/app/AController.java:30",
  "POST  /b  src/main/java/app/BController.java:10",
]);
assert.equal(formatEndpointList([]), "未找到 Spring 端点");

assert.deepEqual(springMarkerInputs(springIndex), [
  { path: "src/main/java/app/App.java", line: 7, message: "未找到配置项 app.missing" },
]);
const springMarker = toMonacoMarker(
  {
    range: { start: { line: 6, character: 0 }, end: { line: 6, character: 10 } },
    severity: 2,
    message: "未找到配置项 app.missing",
  },
  "Spring",
);
assert.equal(springMarker.source, "Spring");
assert.equal(springMarker.severity, MARKER_SEVERITY.warning);

console.log("java-selfcheck ok");
