//! Prism Code 命令行入口。
//!
//! CLI 与 GUI 共用同一个 Tauri 可执行文件：无路径参数时正常启动窗口，
//! 带路径参数时把文件/目录交给外部打开桥接。这样发布后的
//! `Contents/MacOS/prismcode` 既是应用二进制，也是可安装到 PATH 的 CLI。

use crate::external_open::ExternalOpenTarget;
use std::{
    ffi::OsString,
    fs,
    path::{Component, Path, PathBuf},
};

pub enum CliAction {
    Run(Vec<ExternalOpenTarget>),
    Help,
    Version,
}

pub fn parse_args<I>(args: I, cwd: &Path) -> Result<CliAction, String>
where
    I: IntoIterator<Item = OsString>,
{
    let mut targets = Vec::new();
    let mut positional_only = false;
    let mut goto_next = false;

    for raw in args {
        let value = raw.to_string_lossy();
        if !positional_only {
            match value.as_ref() {
                "--" => {
                    positional_only = true;
                    continue;
                }
                "-h" | "--help" => return Ok(CliAction::Help),
                "-v" | "--version" => return Ok(CliAction::Version),
                "--goto" => {
                    // 与 VS Code / Zed 兼容：位置本身仍使用 path:line:column，
                    // `--goto` 只表示后面的目标需要按定位目标处理。
                    goto_next = true;
                    continue;
                }
                option if option.starts_with('-') => {
                    return Err(format!(
                        "未知命令行选项：{option}\n使用 `prismcode --help` 查看用法"
                    ));
                }
                _ => {}
            }
        }

        let target = parse_target_spec(&value, cwd)?;
        targets.push(target);
        goto_next = false;
    }

    if goto_next {
        return Err("`--goto` 后缺少文件路径".into());
    }

    Ok(CliAction::Run(targets))
}

pub fn help_text() -> &'static str {
    "用法：prismcode [选项] [文件[:行[:列]] ...]\n\n选项：\n  --goto <文件[:行[:列]]>  打开并定位到指定位置\n  -h, --help               显示帮助\n  -v, --version            显示版本\n  --                       后续参数全部按路径处理"
}

fn parse_target_spec(raw: &str, cwd: &Path) -> Result<ExternalOpenTarget, String> {
    let (path, line, column) = split_location_suffix(raw);
    if path.is_empty() {
        return Err("命令行路径不能为空".into());
    }
    let resolved = resolve_path(path, cwd);
    Ok(ExternalOpenTarget::from_path(resolved, line, column))
}

/// 支持 `file.ts:42` 与 `file.ts:42:10`，只从末尾识别数字段，
/// 因此包含冒号的普通路径仍可作为路径传入。
fn split_location_suffix(raw: &str) -> (&str, Option<u32>, Option<u32>) {
    let mut parts = raw.rsplitn(3, ':');
    let last = parts.next();
    let middle = parts.next();
    let first = parts.next();

    if let (Some(column), Some(line), Some(path)) = (last, middle, first) {
        if let (Some(line), Some(column)) = (positive_number(line), positive_number(column)) {
            return (path, Some(line), Some(column));
        }
    }

    let mut parts = raw.rsplitn(2, ':');
    let last = parts.next();
    let first = parts.next();
    if let (Some(line), Some(path)) = (last, first) {
        if let Some(line) = positive_number(line) {
            return (path, Some(line), Some(1));
        }
    }

    (raw, None, None)
}

fn positive_number(value: &str) -> Option<u32> {
    let number = value.parse::<u32>().ok()?;
    (number > 0).then_some(number)
}

fn resolve_path(raw: &str, cwd: &Path) -> PathBuf {
    let input = Path::new(raw);
    let candidate = if input.is_absolute() {
        input.to_path_buf()
    } else {
        cwd.join(input)
    };

    if let Ok(canonical) = fs::canonicalize(&candidate) {
        return canonical;
    }
    lexical_normalize(&candidate)
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let _ = normalized.pop();
            }
            Component::RootDir | Component::Prefix(_) | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_file_line_and_column() {
        let action = parse_args(args(&["src/main.ts:12:4"]), Path::new("/tmp/project"))
            .expect("CLI 应解析成功");
        let CliAction::Run(targets) = action else {
            panic!("应返回运行目标");
        };
        assert_eq!(targets[0].path, "/tmp/project/src/main.ts");
        assert_eq!(targets[0].line, Some(12));
        assert_eq!(targets[0].column, Some(4));
    }

    #[test]
    fn parses_line_without_column() {
        let action =
            parse_args(args(&["README.md:8"]), Path::new("/tmp/project")).expect("CLI 应解析成功");
        let CliAction::Run(targets) = action else {
            panic!("应返回运行目标");
        };
        assert_eq!(targets[0].line, Some(8));
        assert_eq!(targets[0].column, Some(1));
    }

    #[test]
    fn preserves_colon_path_when_suffix_is_not_numeric() {
        let action = parse_args(args(&["folder:name.txt"]), Path::new("/tmp/project"))
            .expect("CLI 应解析成功");
        let CliAction::Run(targets) = action else {
            panic!("应返回运行目标");
        };
        assert_eq!(targets[0].path, "/tmp/project/folder:name.txt");
        assert_eq!(targets[0].line, None);
    }

    #[test]
    fn supports_goto_and_help_version() {
        assert!(matches!(
            parse_args(args(&["--goto", "main.ts:3:2"]), Path::new("/tmp")),
            Ok(CliAction::Run(_))
        ));
        assert!(matches!(
            parse_args(args(&["--help"]), Path::new("/tmp")),
            Ok(CliAction::Help)
        ));
        assert!(matches!(
            parse_args(args(&["--version"]), Path::new("/tmp")),
            Ok(CliAction::Version)
        ));
    }
}
