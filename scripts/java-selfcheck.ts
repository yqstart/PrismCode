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
import { detectJavaBuildTool, javaRunCommands } from "../src/shared/javaRun.ts";

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

console.log("java-selfcheck ok");
