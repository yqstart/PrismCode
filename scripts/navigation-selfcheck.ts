// ==================== 导航自测 ====================
// 验证 Prism Code 自己定义的声明导航目标：组件、函数/class、模板绑定和 CSS class。

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";

const root = process.cwd();
const server = await createServer({
  configFile: false,
  root,
  logLevel: "error",
  appType: "custom",
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  resolve: { alias: { "@": resolve(root, "src") } },
});

try {
  const navigationSource = await readFile(
    resolve(root, "src/features/editor/navigation.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    navigationSource,
    /EditorView\.domEventHandlers\(\{\s*click\(event,\s*view\)/s,
    "普通鼠标点击不应直接触发声明跳转",
  );

  const {
    findNavigationSourceAtPos,
    findTargetAtPos,
    findVueComponentAtPos,
  } = await server.ssrLoadModule("/src/features/editor/navigation.ts");

  const vueFile = "/workspace/demo/src/Parent.vue";
  const vueDoc = [
    '<script setup lang="ts">',
    'import ChildCard from "./ChildCard.vue";',
    "class Store {}",
    "function openChild() {}",
    "</script>",
    "",
    "<template>",
    '  <ChildCard class="card" @click="openChild" />',
    '  <div :class="{ panel: Store }" />',
    "</template>",
    "",
    "<style>",
    ".card, .panel { color: red; }",
    "</style>",
  ].join("\n");

  const componentPos = vueDoc.indexOf("ChildCard", vueDoc.indexOf("<template>")) + 2;
  const component = findVueComponentAtPos(vueDoc, componentPos);
  assert.equal(component?.tagName, "ChildCard", "Vue 组件标签应被识别");
  assert.equal(
    findNavigationSourceAtPos(vueDoc, componentPos, null, vueFile)?.kind,
    "component",
    "已导入的 Vue 组件引用应是可点击目标",
  );

  const functionPos = vueDoc.lastIndexOf("openChild") + 2;
  assert.equal(
    findNavigationSourceAtPos(vueDoc, functionPos, null, vueFile)?.kind,
    "symbol",
    "模板事件函数引用应是可点击目标",
  );
  const functionTarget = findTargetAtPos(vueDoc, functionPos, null, vueFile);
  assert.deepEqual(
    functionTarget && { line: functionTarget.line, column: functionTarget.column },
    { line: 4, column: 10 },
    "模板函数引用应落到函数定义",
  );

  const classPos = vueDoc.indexOf('class="card"') + 'class="'.length + 1;
  assert.equal(
    findNavigationSourceAtPos(vueDoc, classPos, null, vueFile)?.kind,
    "style",
    "静态 CSS class 引用应是可点击目标",
  );
  const classTarget = findTargetAtPos(vueDoc, classPos, null, vueFile);
  assert.deepEqual(
    classTarget && { line: classTarget.line, column: classTarget.column },
    { line: 13, column: 2 },
    "CSS class 应落到第一个选择器名称",
  );

  const dynamicClassPos = vueDoc.indexOf("panel:") + 1;
  assert.equal(
    findNavigationSourceAtPos(vueDoc, dynamicClassPos, null, vueFile)?.kind,
    "style",
    "动态 class 对象 key 也应支持导航",
  );

  const asyncComponentDoc = [
    '<script setup lang="ts">',
    'import { defineAsyncComponent } from "vue";',
    'const LazyCard = defineAsyncComponent(() => import("./LazyCard.vue"));',
    "</script>",
    "<template>",
    "  <lazy-card />",
    "</template>",
  ].join("\n");
  const asyncComponentPos = asyncComponentDoc.indexOf("lazy-card") + 2;
  assert.equal(
    findNavigationSourceAtPos(
      asyncComponentDoc,
      asyncComponentPos,
      null,
      vueFile,
    )?.kind,
    "component",
    "defineAsyncComponent 的 Vue 组件引用也应可导航",
  );

  const nestedTemplateDoc = [
    '<script setup>import ChildCard from "./ChildCard.vue";</script>',
    "<template>",
    '  <template v-if="ready"><span /></template>',
    "  <ChildCard />",
    "</template>",
  ].join("\n");
  const nestedComponentPos = nestedTemplateDoc.lastIndexOf("ChildCard") + 2;
  assert.equal(
    findVueComponentAtPos(nestedTemplateDoc, nestedComponentPos)?.tagName,
    "ChildCard",
    "嵌套 template 结束后仍应识别后续组件",
  );

  const scriptDoc = [
    "class UserStore {}",
    "function loadUser() {}",
    "const store = new UserStore();",
    "loadUser();",
  ].join("\n");
  const scriptFile = "/workspace/demo/src/main.ts";
  const classRefPos = scriptDoc.indexOf("UserStore", scriptDoc.indexOf("new ")) + 2;
  assert.equal(
    findNavigationSourceAtPos(scriptDoc, classRefPos, null, scriptFile)?.kind,
    "symbol",
    "TypeScript class 引用应是可点击目标",
  );
  const classRefTarget = findTargetAtPos(scriptDoc, classRefPos, null, scriptFile);
  assert.deepEqual(
    classRefTarget && { line: classRefTarget.line, column: classRefTarget.column },
    { line: 1, column: 7 },
    "class 引用应落到 class 定义",
  );

  const functionRefPos = scriptDoc.lastIndexOf("loadUser") + 2;
  const functionRefTarget = findTargetAtPos(scriptDoc, functionRefPos, null, scriptFile);
  assert.deepEqual(
    functionRefTarget && { line: functionRefTarget.line, column: functionRefTarget.column },
    { line: 2, column: 10 },
    "函数引用应落到函数定义",
  );
} finally {
  await server.close();
}

console.log("导航自测通过");
