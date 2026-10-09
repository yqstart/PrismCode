//! Maven 反应堆语义：只读声明式模块图 + mvn 输出诊断。
//!
//! 只解析 pom.xml 文本与命令行输出，不启动 Maven、不起 daemon、不下载依赖。
//! 模块图以 `<modules>` 声明为准：Maven 的模块可能落在共享扫描会剪掉的目录
//! （例如 `build/`、`out/`），而图外的野生 pom.xml 根本不是模块。

use crate::commands::path_util::{canonical_workspace_root, existing_workspace_root};
use quick_xml::events::Event;
use quick_xml::{Reader, XmlVersion};
use regex::Regex;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

/// 文本解析与输出解析都是纯 CPU 工作，超时只用于兜住异常输入
const MAVEN_TIMEOUT: Duration = Duration::from_secs(10);
const PARSE_FAILED_MESSAGE: &str = "pom.xml 解析失败";
use crate::commands::path_util::WORKSPACE_MISSING;

#[derive(Debug, Default)]
/// 反应堆发现与运行配置判定所需的 POM 字段
struct Descriptor {
    artifact_id: Option<String>,
    packaging: String,
    module_paths: Vec<String>,
    profiles: Vec<String>,
    plugins: Vec<String>,
}

/// 声明式模块图中的一格，根模块保持在首位。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclaredModule {
    /// 项目相对路径，正斜杠，根模块为 `.`
    pub relative_path: String,
    pub artifact_id: String,
    pub packaging: String,
    /// 该模块在 `<build><plugins>` 里直接声明的插件 artifactId
    pub plugins: Vec<String>,
}

impl DeclaredModule {
    /// 该模块是否直接应用了某个构建插件
    pub fn applies_plugin(&self, artifact_id: &str) -> bool {
        self.plugins.iter().any(|value| value == artifact_id)
    }

    /// `pom` 打包是聚合器：本身不产出可运行构件，插件只用来配置子模块
    pub fn is_aggregator(&self) -> bool {
        self.packaging == "pom"
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MavenModule {
    pub relative_path: String,
    pub artifact_id: String,
    pub packaging: String,
    pub plugins: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MavenProfile {
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MavenDiagnostic {
    pub path: String,
    /// 消息带行列时用实际值；pom.xml 解析失败只有摘不到位置的 1
    pub line: u32,
    pub column: Option<u32>,
    pub message: String,
    pub severity: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MavenScanResult {
    pub modules: Vec<MavenModule>,
    pub profiles: Vec<MavenProfile>,
    pub diagnostics: Vec<MavenDiagnostic>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MavenDiagnosticsResult {
    pub diagnostics: Vec<MavenDiagnostic>,
}

fn diagnostic(path: impl Into<String>, message: impl Into<String>, severity: &str) -> MavenDiagnostic {
    MavenDiagnostic {
        path: path.into(),
        line: 1,
        column: None,
        message: message.into(),
        severity: severity.to_string(),
    }
}

async fn run_blocking<T, F>(label: &'static str, job: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    let handle = tauri::async_runtime::spawn_blocking(job);
    match tokio::time::timeout(MAVEN_TIMEOUT, handle).await {
        Ok(joined) => joined.map_err(|error| format!("{label}失败: {error}"))?,
        Err(_) => Err(format!("{label}超时")),
    }
}

/// 只读根 pom.xml 的 `<modules>` 声明式图；根在首位。非 Maven 根返回空数组。
#[tauri::command]
pub async fn maven_scan(root: String, paths: Vec<String>) -> Result<MavenScanResult, String> {
    run_blocking("Maven 反应堆扫描", move || scan_blocking(&root, &paths)).await
}

/// 把 mvn 输出里的 `[ERROR] 路径:[行,列] 消息` 整理成诊断；解析失败返回空数组。
#[tauri::command]
pub async fn maven_diagnostics(root: String, output: String) -> Result<MavenDiagnosticsResult, String> {
    run_blocking("Maven 诊断解析", move || {
        existing_workspace_root(&root)?;
        Ok(MavenDiagnosticsResult {
            diagnostics: parse_diagnostics(&output),
        })
    })
    .await
}

fn scan_blocking(root: &str, paths: &[String]) -> Result<MavenScanResult, String> {
    let workspace = existing_workspace_root(root)?;
    let scan = scan_reactor(&workspace, paths)?;
    Ok(MavenScanResult {
        modules: scan
            .modules
            .into_iter()
            .map(|module| MavenModule {
                relative_path: module.relative_path,
                artifact_id: module.artifact_id,
                packaging: module.packaging,
                plugins: module.plugins,
            })
            .collect(),
        profiles: scan
            .profiles
            .into_iter()
            .map(|id| MavenProfile { id })
            .collect(),
        diagnostics: scan.diagnostics,
    })
}

/// 一次反应堆扫描的全部产物。运行配置生成走同一入口，保证两条链路读到同一张模块图。
#[derive(Debug, Clone, Default)]
pub struct ReactorScan {
    /// 反应堆根（已归一化）
    pub root: PathBuf,
    /// 反应堆根相对工作区的项目相对路径，`.` 表示就在工作区根
    pub root_relative: String,
    /// 声明式模块图，根在首位，`relative_path` 相对反应堆根
    pub modules: Vec<DeclaredModule>,
    pub profiles: Vec<String>,
    pub diagnostics: Vec<MavenDiagnostic>,
}

impl ReactorScan {
    /// 模块相对路径 → 声明信息，供运行配置判定插件与打包方式
    pub fn module(&self, relative_path: &str) -> Option<&DeclaredModule> {
        self.modules
            .iter()
            .find(|module| module.relative_path == relative_path)
    }
}

/// 工作区 → 声明式反应堆模块图。非 Maven 工作区返回空扫描（不报错）；
/// pom.xml 存在但畸形时只给一条诊断。
pub fn scan_reactor(workspace: &Path, paths: &[String]) -> Result<ReactorScan, String> {
    // 归一化放在入口：调用方给的可能是带 `..` 或经 `/var` → `/private/var` 软链的
    // 等价路径，只有先归一化，后面所有 strip_prefix 才能算出项目相对路径。
    let workspace = canonical_workspace_root(workspace)?;
    let workspace = workspace.as_path();
    let mut scan = ReactorScan::default();
    let Some((reactor, descriptor)) = resolve_reactor_root(workspace, paths)? else {
        return Ok(scan);
    };
    let root_pom = reactor.join("pom.xml");
    scan.root_relative = relative_dir(workspace, &reactor);
    scan.root = reactor.clone();
    let root_descriptor = match descriptor {
        Ok(descriptor) => descriptor,
        Err(message) => {
            scan.diagnostics
                .push(diagnostic(relative_pom(workspace, &root_pom), message, "error"));
            return Ok(scan);
        }
    };
    scan.profiles = root_descriptor.profiles.clone();

    let mut visited = vec![reactor.clone()];
    collect_modules(
        workspace,
        &reactor,
        &reactor,
        root_descriptor,
        &mut scan.modules,
        &mut visited,
        &mut scan.diagnostics,
    );
    Ok(scan)
}

fn relative_dir(workspace: &Path, directory: &Path) -> String {
    directory
        .strip_prefix(workspace)
        .ok()
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| ".".to_string())
}

fn relative_pom(workspace: &Path, pom: &Path) -> String {
    pom.strip_prefix(workspace)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| "pom.xml".to_string())
}

/// 从可见路径及其祖先里挑出唯一可解析的 Maven 根：最浅者胜，同级按字典序确定。
///
/// 打开子模块时工作区根未必是反应堆根；这里与 Lithe 的选择规则一致，
/// 保证同一工程在任何入口下都得到同一张模块图。返回根目录与它的描述符结果：
/// 描述符失败说明 pom.xml 存在但畸形，调用方据此报诊断而不是当成非 Maven 工程。
#[allow(clippy::type_complexity)]
fn resolve_reactor_root(
    workspace: &Path,
    paths: &[String],
) -> Result<Option<(PathBuf, Result<Descriptor, String>)>, String> {
    let canonical_root = workspace
        .canonicalize()
        .map_err(|_| WORKSPACE_MISSING.to_string())?;
    let mut candidates: Vec<PathBuf> = vec![PathBuf::new()];
    for relative in paths.iter().filter_map(|path| normalize_relative_path(path)) {
        let mut directory = Path::new(&relative).parent();
        while let Some(current) = directory {
            candidates.push(current.to_path_buf());
            if current.as_os_str().is_empty() {
                break;
            }
            directory = current.parent();
        }
    }
    candidates.sort_by(|left, right| {
        left.components()
            .count()
            .cmp(&right.components().count())
            .then_with(|| left.cmp(right))
    });
    candidates.dedup();

    let mut broken: Option<(PathBuf, String)> = None;
    for candidate in candidates {
        let directory = workspace.join(&candidate);
        let pom = directory.join("pom.xml");
        if !pom.is_file() {
            continue;
        }
        // 越界拦截：候选目录 canonicalize 之后必须仍在工作区内
        let Ok(resolved) = directory.canonicalize() else {
            continue;
        };
        if !resolved.starts_with(&canonical_root) {
            continue;
        }
        match descriptor(&pom) {
            Ok(Some(descriptor)) => return Ok(Some((resolved, Ok(descriptor)))),
            Ok(None) => {}
            Err(message) => {
                if broken.is_none() {
                    broken = Some((resolved, message));
                }
            }
        }
    }
    Ok(broken.map(|(directory, message)| (directory, Err(message))))
}

/// 深度优先摊平模块图。已访问路径不释放：能被两条父路径到达的模块仍是一个模块，
/// 重复发射会为同一个服务生成两份运行配置。
#[allow(clippy::too_many_arguments)]
fn collect_modules(
    workspace: &Path,
    reactor: &Path,
    directory: &Path,
    current: Descriptor,
    modules: &mut Vec<DeclaredModule>,
    visited: &mut Vec<PathBuf>,
    diagnostics: &mut Vec<MavenDiagnostic>,
) {
    let relative_path = directory
        .strip_prefix(reactor)
        .ok()
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| ".".to_string());
    modules.push(DeclaredModule {
        relative_path,
        artifact_id: current.artifact_id.unwrap_or_else(|| {
            directory
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("module")
                .to_string()
        }),
        packaging: current.packaging,
        plugins: current.plugins,
    });
    for raw_path in &current.module_paths {
        let Some(relative) = normalize_relative_path(raw_path) else {
            continue;
        };
        let child = directory.join(&relative).clean();
        if visited.iter().any(|path| path == &child) || !child.starts_with(reactor) {
            continue;
        }
        let child_pom = child.join("pom.xml");
        let child_descriptor = match descriptor(&child_pom) {
            Ok(Some(descriptor)) => descriptor,
            // 缺失的子 pom 说明声明与磁盘不一致，不报错（Maven 自己会失败）
            Ok(None) => continue,
            Err(_) => {
                diagnostics.push(diagnostic(
                    relative_pom(workspace, &child_pom),
                    PARSE_FAILED_MESSAGE,
                    "error",
                ));
                continue;
            }
        };
        visited.push(child.clone());
        collect_modules(
            workspace,
            reactor,
            &child,
            child_descriptor,
            modules,
            visited,
            diagnostics,
        );
    }
}


/// 解析 `[ERROR] 路径:[行,列] 消息`；无法识别的行直接跳过。
pub fn parse_diagnostics(output: &str) -> Vec<MavenDiagnostic> {
    let expression = Regex::new(r"\[(ERROR|WARNING)]\s+(.*?):\[(\d+)(?:,(\d+))?]\s+(.*)")
        .expect("静态 Maven 诊断表达式恒有效");
    let mut seen = HashSet::new();
    output
        .lines()
        .filter_map(|line| {
            let captures = expression.captures(line)?;
            let path = captures.get(2)?.as_str().trim().to_string();
            let line_number = captures.get(3)?.as_str().parse().ok()?;
            let column = captures.get(4).and_then(|value| value.as_str().parse().ok());
            let severity = captures.get(1)?.as_str().to_lowercase();
            let message = captures.get(5)?.as_str().trim().to_string();
            let key = (path.clone(), line_number, column, severity.clone(), message.clone());
            seen.insert(key).then_some(MavenDiagnostic {
                path,
                line: line_number,
                column,
                message,
                severity,
            })
        })
        .collect()
}

/// 读取一个 pom.xml。文件不存在或不可读返回 `Ok(None)`；XML 畸形返回 `Err`。
fn descriptor(path: &Path) -> Result<Option<Descriptor>, String> {
    let Ok(data) = fs::read(path) else {
        return Ok(None);
    };
    let mut reader = Reader::from_reader(data.as_slice());
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut stack: Vec<(String, String)> = Vec::new();
    let mut value = Descriptor {
        packaging: "jar".to_string(),
        ..Descriptor::default()
    };
    let mut profile_id: Option<String> = None;

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) => {
                stack.push((local_name(event.name().as_ref()), String::new()));
                if stack.last().is_some_and(|(name, _)| name == "profile") {
                    profile_id = None;
                }
            }
            Ok(Event::Text(event)) => {
                if let Some((_, text)) = stack.last_mut() {
                    let decoded = event
                        .xml_content(XmlVersion::Implicit1_0)
                        .map_err(|_| PARSE_FAILED_MESSAGE.to_string())?;
                    text.push_str(&decoded);
                }
            }
            Ok(Event::End(event)) => {
                let name = local_name(event.name().as_ref());
                let Some((open_name, raw_text)) = stack.pop() else {
                    return Err(PARSE_FAILED_MESSAGE.to_string());
                };
                // 标签错配在 quick-xml 里不是错误事件，得自己比对：
                // 少写一个尖括号的 pom.xml 必须被判为畸形，而不是静悄悄少读一个字段。
                if open_name != name {
                    return Err(PARSE_FAILED_MESSAGE.to_string());
                }
                let text = raw_text.trim().to_string();
                let path = stack
                    .iter()
                    .map(|(part, _)| part.as_str())
                    .chain(std::iter::once(name.as_str()))
                    .collect::<Vec<_>>()
                    .join("/");
                match path.as_str() {
                    "project/artifactId" => value.artifact_id = non_empty(text),
                    "project/packaging" => {
                        value.packaging = non_empty(text).unwrap_or_else(|| "jar".to_string())
                    }
                    "project/modules/module" => {
                        if let Some(module) = non_empty(text) {
                            value.module_paths.push(module);
                        }
                    }
                    // 只认 `<build><plugins>`：`<pluginManagement>` 下的插件只是给子模块
                    // 定版本而不会执行，`<reporting>` 下的更不会跑。
                    "project/build/plugins/plugin/artifactId" => {
                        if let Some(artifact) = non_empty(text) {
                            value.plugins.push(artifact);
                        }
                    }
                    "project/profiles/profile/id" => profile_id = non_empty(text),
                    "project/profiles/profile" => {
                        if let Some(id) = profile_id.take() {
                            if !value.profiles.iter().any(|profile| profile == &id) {
                                value.profiles.push(id);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => return Err(PARSE_FAILED_MESSAGE.to_string()),
            _ => {}
        }
        buffer.clear();
    }
    if stack.is_empty() {
        Ok(Some(value))
    } else {
        Err(PARSE_FAILED_MESSAGE.to_string())
    }
}

/// 相对路径归一：空、绝对路径、含 `..`/根/盘符前缀的一律拒绝（越界直接跳过）。
pub fn normalize_relative_path(value: &str) -> Option<String> {
    let path = Path::new(value.trim());
    if path.as_os_str().is_empty() || path.is_absolute() {
        return None;
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return None;
    }
    let value = path.to_string_lossy().replace('\\', "/");
    let trimmed = value.trim_matches('/').to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn local_name(value: &[u8]) -> String {
    String::from_utf8_lossy(value)
        .rsplit(':')
        .next()
        .unwrap_or_default()
        .to_string()
}

fn non_empty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

trait CleanPath {
    fn clean(self) -> PathBuf;
}

impl CleanPath for PathBuf {
    fn clean(self) -> PathBuf {
        let mut result = PathBuf::new();
        for component in self.components() {
            match component {
                Component::CurDir => {}
                Component::ParentDir => {
                    result.pop();
                }
                other => result.push(other.as_os_str()),
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("创建目录");
        }
        let mut file = fs::File::create(path).expect("创建文件");
        file.write_all(contents.as_bytes()).expect("写入文件");
    }

    fn reactor_fixture(root: &Path) {
        write(
            &root.join("pom.xml"),
            r#"<project><artifactId>demo</artifactId><packaging>pom</packaging>
               <modules><module>app</module><module>lib/core</module></modules>
               <profiles><profile><id>dev</id></profile></profiles>
            </project>"#,
        );
        write(
            &root.join("app/pom.xml"),
            r#"<project><artifactId>app</artifactId>
               <build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build>
               <parent><groupId>demo</groupId></parent>
            </project>"#,
        );
        write(
            &root.join("lib/core/pom.xml"),
            r#"<project><artifactId>core</artifactId></project>"#,
        );
    }

    #[test]
    fn scan_flattens_declared_graph_with_root_first() {
        let dir = tempfile::tempdir().expect("临时目录");
        reactor_fixture(dir.path());
        let result = scan_blocking(dir.path().to_str().unwrap(), &[]).expect("扫描成功");
        let paths: Vec<&str> = result
            .modules
            .iter()
            .map(|module| module.relative_path.as_str())
            .collect();
        assert_eq!(paths, vec![".", "app", "lib/core"]);
        assert_eq!(result.modules[0].packaging, "pom");
        assert_eq!(result.modules[1].artifact_id, "app");
        assert!(result.modules[1].plugins.contains(&"spring-boot-maven-plugin".to_string()));
        assert!(result.diagnostics.is_empty());
        assert_eq!(
            result.profiles.iter().map(|profile| profile.id.as_str()).collect::<Vec<_>>(),
            vec!["dev"]
        );
    }

    #[test]
    fn scan_reports_broken_child_pom_without_failing() {
        let dir = tempfile::tempdir().expect("临时目录");
        reactor_fixture(dir.path());
        write(
            &dir.path().join("app/pom.xml"),
            r#"<project><artifactId>app</item></project>"#,
        );
        let result = scan_blocking(dir.path().to_str().unwrap(), &[]).expect("扫描成功");
        let paths: Vec<&str> = result
            .modules
            .iter()
            .map(|module| module.relative_path.as_str())
            .collect();
        assert_eq!(paths, vec![".", "lib/core"]);
        assert_eq!(result.diagnostics.len(), 1);
        assert_eq!(result.diagnostics[0].path, "app/pom.xml");
        assert_eq!(result.diagnostics[0].message, PARSE_FAILED_MESSAGE);
    }

    #[test]
    fn scan_reports_broken_root_pom_without_failing() {
        let dir = tempfile::tempdir().expect("临时目录");
        write(&dir.path().join("pom.xml"), "<project><artifactId>");
        let result = scan_blocking(dir.path().to_str().unwrap(), &[]).expect("扫描成功");
        assert!(result.modules.is_empty());
        assert_eq!(result.diagnostics.len(), 1);
        assert_eq!(result.diagnostics[0].path, "pom.xml");
    }

    #[test]
    fn scan_returns_empty_for_non_maven_root() {
        let dir = tempfile::tempdir().expect("临时目录");
        write(&dir.path().join("package.json"), "{}");
        let result = scan_blocking(dir.path().to_str().unwrap(), &[]).expect("扫描成功");
        assert!(result.modules.is_empty());
        assert!(result.profiles.is_empty());
        assert!(result.diagnostics.is_empty());
    }

    #[test]
    fn scan_rejects_missing_workspace() {
        let error = scan_blocking("/definitely/missing/workspace", &[]).expect_err("必须报错");
        assert_eq!(error, WORKSPACE_MISSING);
    }

    #[test]
    fn scan_promotes_nested_reactor_root_from_visible_paths() {
        let dir = tempfile::tempdir().expect("临时目录");
        reactor_fixture(&dir.path().join("backend"));
        let result = scan_blocking(
            dir.path().to_str().unwrap(),
            &["backend/app/src/Application.java".to_string()],
        )
        .expect("扫描成功");
        assert_eq!(result.modules[0].relative_path, ".");
        assert_eq!(result.modules[0].artifact_id, "demo");
    }

    #[test]
    fn reactor_scan_is_reusable_outside_the_command() {
        let dir = tempfile::tempdir().expect("临时目录");
        reactor_fixture(dir.path());
        let scan = scan_reactor(dir.path(), &[]).expect("扫描成功");
        assert!(scan.diagnostics.is_empty());
        assert_eq!(scan.root_relative, ".");
        assert_eq!(scan.modules.len(), 3);
        assert!(scan.modules[1].applies_plugin("spring-boot-maven-plugin"));
        assert!(!scan.modules[2].is_aggregator());
        assert!(scan.module("app").is_some());
        assert!(scan.module("missing").is_none());
    }

    #[test]
    fn normalize_relative_path_blocks_traversal() {
        assert_eq!(normalize_relative_path("app/pom.xml").as_deref(), Some("app/pom.xml"));
        assert_eq!(normalize_relative_path("/etc/passwd"), None);
        assert_eq!(normalize_relative_path("../secrets"), None);
        assert_eq!(normalize_relative_path("app/../../secrets"), None);
        assert_eq!(normalize_relative_path("   "), None);
    }

    #[test]
    fn diagnostics_parse_mvn_output_and_drop_unparsable_lines() {
        let output = "[INFO] Building\n\
                      [ERROR] /repo/app/src/App.java:[12,5] cannot find symbol\n\
                      [WARNING] /repo/app/src/App.java:[12,5] unused import\n\
                      [ERROR] /repo/app/src/App.java:[12,5] cannot find symbol\n\
                      [ERROR] no location here\n";
        let parsed = parse_diagnostics(output);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].path, "/repo/app/src/App.java");
        assert_eq!(parsed[0].line, 12);
        assert_eq!(parsed[0].column, Some(5));
        assert_eq!(parsed[0].severity, "error");
        assert_eq!(parsed[0].message, "cannot find symbol");
        assert_eq!(parsed[1].severity, "warning");
    }

    #[test]
    fn diagnostics_accept_lines_without_column() {
        let parsed = parse_diagnostics("[ERROR] /repo/pom.xml:[7] Non-resolvable parent POM");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].line, 7);
        assert_eq!(parsed[0].column, None);
        assert_eq!(parsed[0].message, "Non-resolvable parent POM");
    }
}
