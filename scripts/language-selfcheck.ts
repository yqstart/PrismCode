// ==================== 语言高亮自测 ====================
// 验证 Env 自定义流式解析器与 YAML 语言包确实产生语法树节点。

import { yaml } from "@codemirror/lang-yaml";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { envLanguage, isEnvFileName } from "../src/features/editor/envLanguage.ts";

let failed = 0;

function assert(name: string, condition: boolean, detail?: unknown): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}`, detail ?? "");
  }
}

assert("识别 .env", isEnvFileName(".env"));
assert("识别 .env.local", isEnvFileName(".env.local"));
assert("文件名大小写不敏感", isEnvFileName(".ENV.PRODUCTION"));
assert("不误判普通文件", !isEnvFileName("settings.yml"));

const envState = EditorState.create({
  doc: 'export APP_NAME=PrismCode\nAPP_ENV="dev" # 当前环境\nEMPTY=\n',
  extensions: [envLanguage],
});
const envTree = syntaxTree(envState).toString();
assert("Env 键高亮节点", envTree.includes("variableName.definition"), envTree);
assert("Env export 高亮节点", envTree.includes("keyword"), envTree);
assert("Env 值高亮节点", envTree.includes("string"), envTree);
assert("Env 注释高亮节点", envTree.includes("comment"), envTree);

const yamlState = EditorState.create({
  doc: "app:\n  name: Prism Code\nfeatures:\n  - search\nenabled: true\n",
  extensions: [yaml()],
});
const yamlTree = syntaxTree(yamlState).toString();
assert("YML/YAML 结构高亮节点", yamlTree.includes("BlockMapping") && yamlTree.includes("Pair"), yamlTree);
assert("YML/YAML 序列高亮节点", yamlTree.includes("BlockSequence"), yamlTree);

console.log(`\n通过 ${10 - failed}，失败 ${failed}`);
if (failed > 0) process.exit(1);
