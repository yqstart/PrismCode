// ==================== TypeScript 类型服务自测（node --experimental-strip-types scripts/type-service-selfcheck.ts） ====================
// 用真实 typescript 包验证 TsLanguageService 核心能力：
// 真类型感知成员补全（interface/对象字面量/跨文件 import 链）、真自动导入（sourceDisplay）、签名帮助。
// 浏览器与 node 共用同一核心，此测试即核心行为的完成证据。

import ts from "typescript";
import { TsLanguageService, isAlreadyImported, autoImportInsertPos, type FileContentSource } from "../src/features/editor/typeService/tsService.ts";

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`, detail ?? "");
  }
}

/** 内存文件源（node 直测） */
function memSource(files: Map<string, string>): FileContentSource {
  return {
    openedContent(path) {
      return files.get(path);
    },
    async readDisk(path) {
      return files.get(path) ?? null;
    },
  };
}

const ROOT = "/proj";
const files = new Map<string, string>([
  ["/proj/types.ts", [
    "export interface User {",
    "  name: string;",
    "  age: number;",
    "  greet(): string;",
    "}",
    "export const PI = 3.14;",
    "export function helper(input: string): number { return input.length; }",
    "export class Store {",
    "  private items: string[] = [];",
    "  add(item: string): void {}",
    "  list(): string[] { return this.items; }",
    "}",
  ].join("\n")],
  ["/proj/main.ts", [
    "import { User, Store } from './types'",
    "const user: User = { name: 'a', age: 1, greet: () => '' }",
    "const store = new Store()",
    "const obj = { alpha: 1, beta: 'x' }",
    "",
    "user.",
  ].join("\n")],
  // 独立文件：连续未完成语句会让 TS 解析退化，每场景一文件贴近真实输入
  ["/proj/obj.ts", "const obj = { alpha: 1, beta: 'x' }\nobj."],
  ["/proj/store.ts", "import { Store } from './types'\nconst store = new Store()\nstore."],
  ["/proj/src/lib/nav.ts", "export function goToTarget(): void {}"],
  ["/proj/src/app.ts", "import { goToTarget } from '@/lib/nav'\ngoToTarget()"],
]);

const svc = new TsLanguageService();
svc.init(ts, ROOT, memSource(files));
// 注册两个文件
svc.setFile("/proj/types.ts", files.get("/proj/types.ts")!);
svc.setFile("/proj/main.ts", files.get("/proj/main.ts")!);

// ==================== 真类型感知成员 ====================
console.log("== 类型感知成员 ==");
{
  const doc = files.get("/proj/main.ts")!;
  const pos = doc.lastIndexOf("user.") + "user.".length; // user.| 光标
  const entries = svc.completionsAt("/proj/main.ts", pos);
  const names = entries.map((e) => e.name);
  assert("interface 成员 name", names.includes("name"), names.slice(0, 15));
  assert("interface 成员 age", names.includes("age"));
  assert("interface 方法 greet", names.includes("greet"));
  assert("无对象字面量噪音（alpha 不属于 user）", !names.includes("alpha"));
}

// 对象字面量成员（类型推断，独立文件）
{
  const doc = files.get("/proj/obj.ts")!;
  svc.setFile("/proj/obj.ts", doc);
  const pos = doc.lastIndexOf("obj.") + "obj.".length;
  const entries = svc.completionsAt("/proj/obj.ts", pos);
  const names = entries.map((e) => e.name);
  assert("对象字面量成员 alpha", names.includes("alpha"), names.slice(0, 15));
  assert("对象字面量成员 beta", names.includes("beta"));
}

// class 实例成员（类型推断，独立文件）
{
  const doc = files.get("/proj/store.ts")!;
  svc.setFile("/proj/store.ts", doc);
  const pos = doc.lastIndexOf("store.") + "store.".length;
  const entries = svc.completionsAt("/proj/store.ts", pos);
  const names = entries.map((e) => e.name);
  assert("class 方法 add（类型推断）", names.includes("add"), names.slice(0, 15));
  assert("class 方法 list", names.includes("list"));
  assert("私有成员不暴露", !names.includes("items"));
}

// ==================== 真自动导入 ====================
console.log("== 自动导入 ==");
{
  // 新文件：未导入 helper，输入 hel| 应给出带 sourceDisplay 的补全
  const doc = "hel";
  svc.setFile("/proj/b.ts", doc);
  const entries = svc.completionsAt("/proj/b.ts", doc.length);
  const helper = entries.find((e) => e.name === "helper");
  assert("跨文件未导入符号可见", Boolean(helper));
  assert("自动导入来源模块 './types'", helper?.sourceDisplay === "./types", helper?.sourceDisplay);
  assert("isSnippet 标记存在", typeof helper?.isSnippet === "boolean");
}

// 已导入符号不再重复导入（sourceDisplay 为 undefined？已导入时 TS 不给 sourceDisplay）
{
  const doc = files.get("/proj/main.ts")!;
  const pos = doc.lastIndexOf("import { User, Store }") + 0; // 已有 import
  // 在 main.ts 输入 User 已导入 → 补全 entry 无 sourceDisplay（或已有 import 过滤由前端做）
  const entries = svc.completionsAt("/proj/main.ts", doc.indexOf("const user") + 6);
  const userEntry = entries.find((e) => e.name === "User");
  // TS 对已导入符号返回 sourceDisplay=undefined（无需导入）
  assert("已导入符号无 sourceDisplay", !userEntry?.sourceDisplay, userEntry?.sourceDisplay);
}

// ==================== 签名帮助 ====================
console.log("== 签名帮助 ==");
{
  const doc = [
    "function greet(name: string, age: number): string {",
    "  return name + age",
    "}",
    "greet(",
    "",
  ].join("\n");
  svc.setFile("/proj/sig.ts", doc);
  const pos = doc.lastIndexOf("greet(") + "greet(".length; // greet(| 括号内
  const help = svc.signatureHelpAt("/proj/sig.ts", pos);
  assert("签名帮助存在", Boolean(help));
  assert("签名包含参数 name", help?.signatures[0]?.label.includes("name"), help?.signatures[0]?.label);
  assert("签名包含参数 age", help?.signatures[0]?.label.includes("age"));
  assert("激活参数索引 0", help?.activeParameter === 0, help?.activeParameter);
  assert("applicableSpan 存在（popup 显示范围）", help !== null && help.applicableSpan.length > 0, help?.applicableSpan);
}

// 括号外无签名帮助
{
  const doc = "greet";
  svc.setFile("/proj/sig2.ts", doc);
  const help = svc.signatureHelpAt("/proj/sig2.ts", doc.length);
  assert("括号外无签名帮助", help === null);
}

// ==================== 定义 / 引用 / hover / 诊断 / 重命名 ====================
console.log("== 语言服务符号能力 ==");
{
  const doc = files.get("/proj/main.ts")!;
  const userPos = doc.indexOf("user: User") + 6;
  const definitions = svc.definitionsAt("/proj/main.ts", userPos);
  assert("类型定义可跳转", definitions.some((item) => item.fileName === "/proj/types.ts"), definitions);
  const refs = svc.referencesAt("/proj/main.ts", doc.lastIndexOf("user.") + 1);
  assert("引用集合包含当前文件", refs.some((item) => item.fileName === "/proj/main.ts"), refs);
  const quick = svc.quickInfoAt("/proj/main.ts", doc.lastIndexOf("user.") + 1);
  assert("hover quick info 有类型签名", Boolean(quick?.displayString), quick);
  const rename = svc.renameLocationsAt("/proj/main.ts", doc.lastIndexOf("user.") + 1);
  assert("重命名位置非空", rename.length > 0, rename);

  const bad = "const count: number = 'wrong'";
  svc.setFile("/proj/bad.ts", bad);
  const diagnostics = svc.diagnosticsFor("/proj/bad.ts");
  assert("语义诊断捕获类型错误", diagnostics.some((item) => item.severity === "error"), diagnostics);

  const aliasTarget = files.get("/proj/src/lib/nav.ts")!;
  const aliasImporter = files.get("/proj/src/app.ts")!;
  svc.setFile("/proj/src/lib/nav.ts", aliasTarget);
  svc.setFile("/proj/src/app.ts", aliasImporter);
  const aliasDefinitions = svc.definitionsAt(
    "/proj/src/app.ts",
    aliasImporter.lastIndexOf("goToTarget") + 2,
  );
  assert(
    "@/* 路径别名可跳到真实声明",
    aliasDefinitions.some((item) => item.fileName === "/proj/src/lib/nav.ts"),
    aliasDefinitions,
  );
}

// ==================== 自动导入判定（纯函数） ====================
// buildAutoImportApply 随 Monaco 迁移移除（自动导入由 Monaco TS worker 的补全承担，
// 不再有编辑器 view 适配层），这里只保留仍有实现的纯函数判定。
console.log("== 自动导入判定 ==");
{
  const doc = "const x = 1\n";
  assert("已导入判定", !isAlreadyImported(doc, "helper"));
  assert("已导入判定（存在 import）", isAlreadyImported("import { helper } from './a'\nconst x = 1", "helper"));
  assert("导入插入点：无 import → 文件开头", autoImportInsertPos("const x = 1\n") === 0);
  assert("导入插入点：首个 import 行尾", autoImportInsertPos("import a from 'b'\nconst x = 1"), "import a from 'b'\n".length);
}

// ==================== release：查找引用后释放第二套编译器 ====================
console.log("== release ==");
{
  const doc = files.get("/proj/obj.ts")!;
  const pos = doc.lastIndexOf("obj.") + "obj.".length;
  const fresh = new TsLanguageService();
  fresh.init(ts, ROOT, memSource(files));
  fresh.setFile("/proj/obj.ts", doc);
  assert("release 前 ready", fresh.ready);
  assert("release 前有类型感知补全", fresh.completionsAt("/proj/obj.ts", pos).length > 0);

  fresh.release();
  assert("release 后 ready 为 false", !fresh.ready);
  assert("release 后 root 清空", fresh.currentRoot === "");
  assert("release 后查询返回空数组", fresh.completionsAt("/proj/obj.ts", pos).length === 0);

  // 同一模块可再次 init（下一次查找引用会重建，不需要重新加载 typescript）
  fresh.init(ts, ROOT, memSource(files));
  fresh.setFile("/proj/obj.ts", doc);
  assert(
    "重新 init 后恢复补全",
    fresh.ready && fresh.completionsAt("/proj/obj.ts", pos).length > 0,
  );
}

// ==================== 汇总 ====================
console.log(`\n通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exit(1);
