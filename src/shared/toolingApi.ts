import { invoke } from "@tauri-apps/api/core";

export interface PrettierFormatOptions {
  rangeStart?: number;
  rangeEnd?: number;
}

/** 用项目 Prettier 格式化；失败抛错 */
export async function formatWithPrettier(
  root: string,
  relPath: string,
  content: string,
  options: PrettierFormatOptions = {},
): Promise<string> {
  return invoke("format_with_prettier", { root, relPath, content, ...options });
}

export interface EslintMessage {
  line: number;
  column: number;
  end_line: number;
  end_column: number;
  /** 1 = warning，2 = error */
  severity: number;
  message: string;
  rule_id: string | null;
}

/** 项目未安装 ESLint 时后端返回的固定错误串 */
export const ESLINT_NOT_AVAILABLE = "eslint-not-available";

/** 用项目本地 ESLint 检查单文件内容；ESLint 不可用时抛 ESLINT_NOT_AVAILABLE */
export async function lintWithEslint(
  root: string,
  relPath: string,
  content: string,
): Promise<EslintMessage[]> {
  return invoke("lint_with_eslint", { root, relPath, content });
}
