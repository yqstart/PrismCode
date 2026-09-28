// ==================== 路径 → Monaco 语言 id ====================
// Monaco 未内置 vue/env，两者由 vueProvider.ts / envProvider.ts 自行注册；
// 其余 id 与 monaco-editor 0.57 的语言定义一致。

import { basename } from "@/shared/fs";

/** 文件扩展名 → Monaco 语言 id；未知返回 plaintext */
export function languageIdForPath(path: string): string {
  const name = basename(path).toLowerCase();

  if (name.endsWith(".vue")) return "vue";
  if (name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".mts") || name.endsWith(".cts")) {
    return "typescript";
  }
  if (name.endsWith(".js") || name.endsWith(".jsx") || name.endsWith(".mjs") || name.endsWith(".cjs")) {
    return "javascript";
  }
  if (name.endsWith(".json") || name === ".babelrc" || name === ".eslintrc" || name.endsWith(".jsonc")) {
    return "json";
  }
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "markdown";
  if (name.endsWith(".html") || name.endsWith(".htm")) return "html";
  if (name.endsWith(".less")) return "less";
  if (name.endsWith(".scss") || name.endsWith(".sass")) return "scss";
  if (name.endsWith(".css")) return "css";
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return "yaml";
  if (name.endsWith(".xml") || name.endsWith(".svg") || name.endsWith(".xhtml")) return "xml";
  if (name === ".env" || name.startsWith(".env.") || name.endsWith(".env")) return "env";
  if (name.endsWith(".graphql") || name.endsWith(".gql")) return "graphql";
  if (name.endsWith(".sh") || name.endsWith(".bash") || name.endsWith(".zsh")) return "shell";
  if (name.endsWith(".py")) return "python";
  if (name.endsWith(".rs")) return "rust";
  if (name.endsWith(".go")) return "go";
  if (name.endsWith(".java")) return "java";
  if (name.endsWith(".toml")) return "ini";
  if (name.endsWith(".ini") || name.endsWith(".cfg") || name.endsWith(".conf")) return "ini";
  if (name.endsWith(".sql")) return "sql";
  if (name.endsWith(".dockerfile") || name === "dockerfile") return "dockerfile";
  return "plaintext";
}
