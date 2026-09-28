//! 工作区 Prettier 集成：调用项目本地 npx（需已安装依赖）

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

fn npx_cmd() -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut c = Command::new("cmd");
        c.arg("/C").arg("npx");
        c
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("npx")
    }
}

/// 用项目 Prettier 格式化文件内容；失败时返回错误信息
#[tauri::command]
pub async fn format_with_prettier(
    root: String,
    rel_path: String,
    content: String,
    range_start: Option<usize>,
    range_end: Option<usize>,
) -> Result<String, String> {
    // npx --no-install 首次启动可能联网探测/较慢，wait_with_output 无超时，
    // 放 spawn_blocking + 超时兜底，避免主线程冻结
    let handle = tokio::task::spawn_blocking(move || {
        format_with_prettier_blocking(&root, &rel_path, &content, range_start, range_end)
    });
    match tokio::time::timeout(std::time::Duration::from_secs(30), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("Prettier 任务失败: {join}")),
        Err(_) => Err("Prettier 执行超时（30s），已回退内置格式化引擎".into()),
    }
}

fn format_with_prettier_blocking(
    root: &str,
    rel_path: &str,
    content: &str,
    range_start: Option<usize>,
    range_end: Option<usize>,
) -> Result<String, String> {
    if !Path::new(&root).is_dir() {
        return Err("工作区无效".into());
    }
    let mut args = vec![
        "--no-install".to_string(),
        "prettier".to_string(),
        "--stdin-filepath".to_string(),
        rel_path.to_string(),
    ];
    if let (Some(start), Some(end)) = (range_start, range_end) {
        args.extend([
            "--range-start".to_string(),
            start.to_string(),
            "--range-end".to_string(),
            end.to_string(),
        ]);
    }

    let mut child = npx_cmd()
        .args(args)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动 Prettier（请确认已安装 Node 与项目 prettier）: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(content.as_bytes())
            .map_err(|e| format!("写入 Prettier stdin 失败: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("等待 Prettier 失败: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "Prettier 执行失败（项目可能未安装 prettier）".into()
        } else {
            err
        });
    }

    String::from_utf8(output.stdout).map_err(|e| format!("Prettier 输出非 UTF-8: {e}"))
}

/// ESLint 单文件诊断结果（前端映射到编辑器 marker）
#[derive(serde::Serialize)]
pub struct EslintMessage {
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    /// 1 = warning，2 = error（与 ESLint / Monaco 的 MarkerSeverity 一致）
    pub severity: u8,
    pub message: String,
    pub rule_id: Option<String>,
}

/// 项目 ESLint 不可用时返回的固定错误串，前端据此静默禁用而非报错
pub const ESLINT_NOT_AVAILABLE: &str = "eslint-not-available";

/// 用项目本地 ESLint 检查单文件内容（走 stdin，不落盘临时文件）
#[tauri::command]
pub async fn lint_with_eslint(
    root: String,
    rel_path: String,
    content: String,
) -> Result<Vec<EslintMessage>, String> {
    let handle = tokio::task::spawn_blocking(move || {
        lint_with_eslint_blocking(&root, &rel_path, &content)
    });
    match tokio::time::timeout(std::time::Duration::from_secs(20), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("ESLint 任务失败: {join}")),
        Err(_) => Err(ESLINT_NOT_AVAILABLE.into()),
    }
}

fn lint_with_eslint_blocking(
    root: &str,
    rel_path: &str,
    content: &str,
) -> Result<Vec<EslintMessage>, String> {
    if !Path::new(&root).is_dir() {
        return Err("工作区无效".into());
    }

    let mut child = npx_cmd()
        .args([
            "--no-install",
            "eslint",
            "--stdin",
            "--stdin-filename",
            rel_path,
            "--format",
            "json",
        ])
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| ESLINT_NOT_AVAILABLE.to_string())?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(content.as_bytes())
            .map_err(|e| format!("写入 ESLint stdin 失败: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("等待 ESLint 失败: {e}"))?;

    // ESLint 用退出码 1 表示「存在 lint 错误」，属于正常结果
    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let lower = stderr.to_lowercase();
        if lower.contains("not found")
            || lower.contains("cannot find module")
            || lower.contains("couldn't find")
            || lower.contains("command not found")
        {
            return Err(ESLINT_NOT_AVAILABLE.into());
        }
        return Err(if stderr.trim().is_empty() {
            ESLINT_NOT_AVAILABLE.into()
        } else {
            stderr.trim().to_string()
        });
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|e| format!("ESLint 输出解析失败: {e}"))?;
    Ok(eslint_messages_from_json(&parsed))
}

/// 从 ESLint JSON 报告里提取消息（纯函数便于单测）
pub fn eslint_messages_from_json(report: &serde_json::Value) -> Vec<EslintMessage> {
    let mut out = Vec::new();
    let files = match report.as_array() {
        Some(files) => files,
        None => return out,
    };
    for file in files {
        let messages = match file.get("messages").and_then(|value| value.as_array()) {
            Some(messages) => messages,
            None => continue,
        };
        for message in messages {
            let line = message.get("line").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
            let column = message.get("column").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
            out.push(EslintMessage {
                line,
                column,
                end_line: message
                    .get("endLine")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(line as u64) as u32,
                end_column: message
                    .get("endColumn")
                    .and_then(|v| v.as_u64())
                    .unwrap_or((column + 1) as u64) as u32,
                severity: message.get("severity").and_then(|v| v.as_u64()).unwrap_or(1) as u8,
                message: message
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                rule_id: message
                    .get("ruleId")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_eslint_messages_with_position_and_rule() {
        let report = serde_json::json!([{
            "filePath": "/tmp/a.ts",
            "messages": [
                {
                    "ruleId": "no-unused-vars",
                    "severity": 2,
                    "message": "'x' is defined but never used.",
                    "line": 3,
                    "column": 7,
                    "endLine": 3,
                    "endColumn": 8
                },
                {
                    "ruleId": null,
                    "severity": 1,
                    "message": "Parsing error",
                    "line": 9,
                    "column": 1
                }
            ],
            "errorCount": 1,
            "warningCount": 1
        }]);
        let messages = eslint_messages_from_json(&report);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].line, 3);
        assert_eq!(messages[0].end_column, 8);
        assert_eq!(messages[0].severity, 2);
        assert_eq!(messages[0].rule_id.as_deref(), Some("no-unused-vars"));
        // 缺 endLine/endColumn 时回退到单列范围
        assert_eq!(messages[1].end_line, 9);
        assert_eq!(messages[1].end_column, 2);
        assert!(messages[1].rule_id.is_none());
    }

    #[test]
    fn parses_empty_and_malformed_reports() {
        assert!(eslint_messages_from_json(&serde_json::json!([])).is_empty());
        assert!(eslint_messages_from_json(&serde_json::json!({})).is_empty());
        assert!(
            eslint_messages_from_json(&serde_json::json!([{ "messages": [] }])).is_empty()
        );
    }
}
