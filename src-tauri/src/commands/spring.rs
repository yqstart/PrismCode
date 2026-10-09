//! Spring 索引：配置键、取值、Bean、注入、HTTP 端点与诊断。
//!
//! 全部用正则有界扫描：不解析 Java 语法树、不起额外进程、不联网。依赖元数据只读
//! `~/.m2` 里 jar 的 `spring-configuration-metadata.json`，进程内缓存，扫描有预算。

use crate::commands::path_util::{existing_workspace_root, walk_files};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use zip::ZipArchive;

/// 依赖元数据的 jar 数量上限（与 Lithe 一致）
const MAX_METADATA_ARCHIVES: usize = 20_000;
/// 单次索引里收集的配置键上限：元数据 jar 全量扫下来可达数万条，取满即停
const MAX_METADATA_KEYS: usize = 20_000;
/// 依赖元数据扫描的时间预算：超时就返回已扫到的部分，不把界面卡在冷启动上
const METADATA_BUDGET: Duration = Duration::from_millis(3000);
/// 项目内参与索引的 Java 文件与配置文件上限
const MAX_JAVA_FILES: usize = 3_000;
const MAX_CONFIG_FILES: usize = 500;
/// 单个源文件读取上限：更大的文件只可能是生成物
const MAX_SOURCE_BYTES: u64 = 512 * 1024;
/// 前端传入的未保存正文：文件数与单文件体积上限
const MAX_OVERRIDE_FILES: usize = 50;
const MAX_OVERRIDE_BYTES: usize = 256 * 1024;
/// 单条元数据 JSON 的读取上限
const MAX_METADATA_BYTES: u64 = 8 * 1024 * 1024;

const METADATA_ENTRIES: [&str; 2] = [
    "META-INF/spring-configuration-metadata.json",
    "META-INF/additional-spring-configuration-metadata.json",
];

static REPOSITORY_CACHE: LazyLock<Mutex<HashMap<PathBuf, Vec<SpringProperty>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpringIndexRequest {
    pub root: String,
    /// 候选文件（工作区相对路径）；为空时由后端按忽略规则遍历工作区
    #[serde(default)]
    pub paths: Vec<String>,
    /// 依赖元数据仓库；为空时用默认仓 `~/.m2/repository`
    #[serde(default)]
    pub metadata_repositories: Vec<String>,
    /// 强制重扫依赖元数据；交互式更新保持 false 以复用进程内快照
    #[serde(default)]
    pub refresh_dependency_metadata: bool,
    /// 未保存的编辑器正文（工作区相对路径 → 内容），优先于磁盘内容
    #[serde(default)]
    pub text_overrides: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpringProperty {
    pub name: String,
    pub default_value: Option<String>,
    /// 来源：`project` 或提供元数据的 jar 文件名
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpringValue {
    pub path: String,
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpringBean {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub path: String,
    pub line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpringInjection {
    pub path: String,
    pub line: u32,
    pub bean: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpringEndpoint {
    /// 声明所在文件
    pub path: String,
    /// HTTP 方法
    pub method: String,
    pub route: String,
    /// 映射注解所在行（1 起）
    pub line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpringIndexDiagnostic {
    pub path: String,
    pub line: u32,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpringIndexResult {
    pub properties: Vec<SpringProperty>,
    pub values: Vec<SpringValue>,
    pub beans: Vec<SpringBean>,
    pub injections: Vec<SpringInjection>,
    pub endpoints: Vec<SpringEndpoint>,
    pub diagnostics: Vec<SpringIndexDiagnostic>,
}

#[tauri::command]
pub async fn spring_index(request: SpringIndexRequest) -> Result<SpringIndexResult, String> {
    let handle = tauri::async_runtime::spawn_blocking(move || index(request));
    match tokio::time::timeout(Duration::from_secs(20), handle).await {
        Ok(joined) => joined.map_err(|error| format!("Spring 索引失败: {error}"))?,
        Err(_) => Err("Spring 索引超时".to_string()),
    }
}

/// 项目 → 一份跨文件 Spring 索引。空项目（没有 Spring 注解/依赖）返回全空数组。
pub fn index(request: SpringIndexRequest) -> Result<SpringIndexResult, String> {
    let workspace = existing_workspace_root(&request.root)?;
    let sanitized = sanitize_overrides(&request.text_overrides);
    let overrides = sanitized.files;
    let mut diagnostics = Vec::new();
    if sanitized.dropped > 0 {
        diagnostics.push(SpringIndexDiagnostic {
            path: ".".to_string(),
            line: 1,
            message: format!(
                "有 {} 个未保存文件超出索引上限（{} 个文件）被跳过",
                sanitized.dropped, MAX_OVERRIDE_FILES
            ),
        });
    }
    if sanitized.truncated > 0 {
        diagnostics.push(SpringIndexDiagnostic {
            path: ".".to_string(),
            line: 1,
            message: format!(
                "有 {} 个未保存文件超过 {} KB，索引只看了前半部分",
                sanitized.truncated,
                MAX_OVERRIDE_BYTES / 1024
            ),
        });
    }

    let candidates = candidate_files(&workspace, &request.paths, &mut diagnostics);
    let mut properties = Vec::new();
    for path in &candidates.metadata {
        if let Some(content) = read_source(&workspace, path, &overrides) {
            append_metadata_json(
                &content,
                &file_name(path),
                MAX_METADATA_KEYS,
                &mut properties,
            );
        }
    }
    for repository in metadata_repositories(&request.metadata_repositories) {
        let (scanned, complete) = repository_metadata(
            &repository,
            request.refresh_dependency_metadata,
            MAX_METADATA_KEYS.saturating_sub(properties.len()),
        );
        if !complete {
            diagnostics.push(SpringIndexDiagnostic {
                path: "pom.xml".to_string(),
                line: 1,
                message: format!(
                    "依赖元数据索引未完成（超过 {} 秒或超出上限），配置补全可能不完整",
                    METADATA_BUDGET.as_secs()
                ),
            });
        }
        properties.extend(scanned);
    }
    deduplicate_properties(&mut properties);

    let mut values = Vec::new();
    for path in &candidates.config {
        let Some(content) = read_source(&workspace, path, &overrides) else {
            continue;
        };
        let relative = relative_slash(&workspace, path);
        if relative.ends_with(".properties") {
            values.extend(parse_properties(&relative, &content));
        } else {
            values.extend(parse_yaml(&relative, &content));
        }
    }

    let mut beans = Vec::new();
    let mut endpoints = Vec::new();
    let mut injections = Vec::new();
    let mut references = Vec::new();
    for path in &candidates.java {
        let Some(content) = read_source(&workspace, path, &overrides) else {
            continue;
        };
        let facts = parse_java(&relative_slash(&workspace, path), &content);
        beans.extend(facts.beans);
        endpoints.extend(facts.endpoints);
        injections.extend(facts.injections);
        references.extend(facts.references);
    }
    resolve_injections(&mut injections, &beans);
    for reference in &references {
        let known = values.iter().any(|value| value.name == reference.key)
            || properties.iter().any(|property| property.name == reference.key);
        if known || is_environment_style(&reference.key) {
            continue;
        }
        diagnostics.push(SpringIndexDiagnostic {
            path: reference.path.clone(),
            line: reference.line,
            message: format!("未找到配置项 {}", reference.key),
        });
    }

    values.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.name.cmp(&right.name))
    });
    values.dedup_by(|left, right| left.path == right.path && left.name == right.name);
    endpoints.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.line.cmp(&right.line))
    });
    beans.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.line.cmp(&right.line))
    });
    injections.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.line.cmp(&right.line))
    });

    Ok(SpringIndexResult {
        properties,
        values,
        beans,
        injections,
        endpoints,
        diagnostics,
    })
}

/// 未保存正文的上限：超出的文件丢弃、超长的正文截断。
/// 前端已按编辑器预算裁剪过一次，这里是最后一道防线；两种裁剪都要报诊断，
/// 否则用户只会看到「补全少了一些」，无从判断是被截掉了。
fn sanitize_overrides(overrides: &HashMap<String, String>) -> SanitizedOverrides {
    let mut kept = HashMap::new();
    let mut dropped = 0usize;
    let mut truncated = 0usize;
    for (path, content) in overrides {
        if kept.len() >= MAX_OVERRIDE_FILES {
            dropped += 1;
            continue;
        }
        let Some(relative) = normalize_relative(path) else {
            dropped += 1;
            continue;
        };
        if content.len() > MAX_OVERRIDE_BYTES {
            truncated += 1;
        }
        kept.insert(relative, content.clone());
    }
    SanitizedOverrides {
        files: kept,
        dropped,
        truncated,
    }
}

struct SanitizedOverrides {
    files: HashMap<String, String>,
    dropped: usize,
    truncated: usize,
}

#[derive(Debug, Default)]
struct Candidates {
    config: Vec<PathBuf>,
    java: Vec<PathBuf>,
    metadata: Vec<PathBuf>,
}

/// 候选文件：调用方给清单时按清单过滤，否则按忽略规则遍历工作区。
fn candidate_files(
    workspace: &Path,
    paths: &[String],
    diagnostics: &mut Vec<SpringIndexDiagnostic>,
) -> Candidates {
    let listed = paths
        .iter()
        .filter_map(|path| normalize_relative(path))
        .collect::<Vec<_>>();
    let files = if listed.is_empty() {
        match walk_files(workspace, &[]) {
            Ok(files) => files,
            Err(error) => {
                diagnostics.push(SpringIndexDiagnostic {
                    path: ".".to_string(),
                    line: 1,
                    message: format!("遍历工作区失败: {error}"),
                });
                return Candidates::default();
            }
        }
    } else {
        listed.iter().map(|path| workspace.join(path)).collect()
    };

    let mut candidates = Candidates::default();
    let mut java_capped = false;
    let mut config_capped = false;
    for path in files {
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name == "spring-configuration-metadata.json" || name == "additional-spring-configuration-metadata.json" {
            candidates.metadata.push(path);
        } else if is_spring_config_file(name) {
            if candidates.config.len() >= MAX_CONFIG_FILES {
                config_capped = true;
                continue;
            }
            candidates.config.push(path);
        } else if path.extension().and_then(|value| value.to_str()) == Some("java") {
            if candidates.java.len() >= MAX_JAVA_FILES {
                java_capped = true;
                continue;
            }
            candidates.java.push(path);
        }
    }
    candidates.metadata.sort();
    candidates.config.sort();
    candidates.java.sort();
    if java_capped {
        diagnostics.push(SpringIndexDiagnostic {
            path: ".".to_string(),
            line: 1,
            message: format!("Java 文件超过 {MAX_JAVA_FILES} 个，索引已截断"),
        });
    }
    if config_capped {
        diagnostics.push(SpringIndexDiagnostic {
            path: ".".to_string(),
            line: 1,
            message: format!("配置文件超过 {MAX_CONFIG_FILES} 个，索引已截断"),
        });
    }
    candidates
}

/// Spring Boot 的配置文件名：`application.properties` / `application-dev.yml` 等
fn is_spring_config_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let base = lower.split('.').next().unwrap_or_default();
    if !base.starts_with("application") && !base.starts_with("bootstrap") {
        return false;
    }
    lower.ends_with(".properties") || lower.ends_with(".yml") || lower.ends_with(".yaml")
}

fn read_source(
    workspace: &Path,
    path: &Path,
    overrides: &HashMap<String, String>,
) -> Option<String> {
    if let Some(relative) = path
        .strip_prefix(workspace)
        .ok()
        .map(|value| value.to_string_lossy().replace('\\', "/"))
    {
        if let Some(content) = overrides.get(&relative) {
            return Some(truncate_override(content));
        }
    }
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_SOURCE_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn truncate_override(content: &str) -> String {
    if content.len() <= MAX_OVERRIDE_BYTES {
        return content.to_string();
    }
    // 按字符边界截断，避免把多字节字符切成非法 UTF-8
    let mut end = MAX_OVERRIDE_BYTES;
    while end > 0 && !content.is_char_boundary(end) {
        end -= 1;
    }
    content[..end].to_string()
}

/// 依赖元数据仓库：默认 `~/.m2/repository`
fn metadata_repositories(configured: &[String]) -> Vec<PathBuf> {
    let mut repositories = configured
        .iter()
        .filter_map(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(PathBuf::from(trimmed))
            }
        })
        .collect::<Vec<_>>();
    if repositories.is_empty() {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            repositories.push(PathBuf::from(home).join(".m2").join("repository"));
        }
    }
    repositories.retain(|path| path.is_dir());
    repositories
}

/// 扫仓库里所有 jar 的元数据。`refresh=false` 时复用进程内快照。
/// 返回（键列表, 是否扫完）：没扫完的结果不写缓存，下一次调用会重试。
fn repository_metadata(
    repository: &Path,
    refresh: bool,
    budget_keys: usize,
) -> (Vec<SpringProperty>, bool) {
    let key = repository
        .canonicalize()
        .unwrap_or_else(|_| repository.to_path_buf());
    let cache = &REPOSITORY_CACHE;
    if !refresh {
        if let Some(properties) = cache
            .lock()
            .ok()
            .and_then(|values| values.get(&key).cloned())
        {
            return (properties, true);
        }
    }
    let (properties, complete) = scan_repository(repository, budget_keys);
    if complete {
        if let Ok(mut values) = cache.lock() {
            values.insert(key, properties.clone());
        }
    }
    (properties, complete)
}

fn scan_repository(repository: &Path, budget_keys: usize) -> (Vec<SpringProperty>, bool) {
    let deadline = Instant::now() + METADATA_BUDGET;
    let mut properties = Vec::new();
    let mut pending = vec![repository.to_path_buf()];
    let mut archives = 0usize;
    while let Some(directory) = pending.pop() {
        if Instant::now() >= deadline {
            return (properties, false);
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            if path.extension().and_then(|value| value.to_str()) != Some("jar") {
                continue;
            }
            archives += 1;
            if archives > MAX_METADATA_ARCHIVES || properties.len() >= budget_keys {
                return (properties, false);
            }
            append_archive_metadata(&path, budget_keys, &mut properties);
        }
    }
    (properties, true)
}

fn append_archive_metadata(path: &Path, budget_keys: usize, properties: &mut Vec<SpringProperty>) {
    let Ok(file) = File::open(path) else {
        return;
    };
    let Ok(mut archive) = ZipArchive::new(file) else {
        return;
    };
    for name in METADATA_ENTRIES {
        let Ok(mut entry) = archive.by_name(name) else {
            continue;
        };
        if entry.size() > MAX_METADATA_BYTES {
            continue;
        }
        let mut content = String::new();
        if entry.read_to_string(&mut content).is_err() {
            continue;
        }
        append_metadata_json(&content, &file_name(path), budget_keys, properties);
    }
}

/// `spring-configuration-metadata.json` 只取 `properties[].name/defaultValue`
fn append_metadata_json(
    content: &str,
    source: &str,
    budget_keys: usize,
    properties: &mut Vec<SpringProperty>,
) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(content) else {
        return;
    };
    let Some(items) = value.get("properties").and_then(|value| value.as_array()) else {
        return;
    };
    for item in items {
        if properties.len() >= budget_keys {
            return;
        }
        let Some(name) = item.get("name").and_then(|value| value.as_str()) else {
            continue;
        };
        properties.push(SpringProperty {
            name: name.to_string(),
            default_value: item
                .get("defaultValue")
                .and_then(|value| value.as_str().map(str::to_string)),
            source: source.to_string(),
        });
    }
}

/// 同名键只留第一条：先到的来源更贴近项目（项目元数据在 jar 之前入列）
fn deduplicate_properties(properties: &mut Vec<SpringProperty>) {
    let mut seen = BTreeSet::new();
    properties.retain(|property| seen.insert(property.name.clone()));
}

/// `.properties`：支持 `=`、`:` 与行尾续行，忽略 `#`/`!` 注释
fn parse_properties(path: &str, content: &str) -> Vec<SpringValue> {
    let mut values = Vec::new();
    let mut pending = String::new();
    for raw in content.lines() {
        let line = pending.clone() + raw.trim_start();
        pending.clear();
        if line.trim_start().starts_with('#') || line.trim_start().starts_with('!') {
            continue;
        }
        if ends_with_continuation(&line) {
            pending = line[..line.len() - 1].to_string();
            continue;
        }
        let Some((name, value)) = split_property_line(&line) else {
            continue;
        };
        values.push(SpringValue {
            path: path.to_string(),
            name,
            value,
        });
    }
    values
}

fn ends_with_continuation(line: &str) -> bool {
    let trimmed = line.trim_end();
    trimmed.ends_with('\\') && !trimmed.ends_with("\\\\")
}

fn split_property_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let separator = trimmed
        .char_indices()
        .find(|(_, character)| matches!(character, '=' | ':' | ' ' | '\t'))
        .map(|(index, character)| (index, character))?;
    let name = trimmed[..separator.0].trim();
    if name.is_empty() {
        return None;
    }
    // 分隔符本身不参与取值；`key:` 与 `key:` 后面的空白一并跳过
    let rest = trimmed[separator.0 + separator.1.len_utf8()..].trim_start();
    let rest = rest.strip_prefix(['=', ':']).unwrap_or(rest).trim_start();
    Some((name.to_string(), rest.trim_end().to_string()))
}

/// `.yml` / `.yaml`：只做缩进层级的键路径展开，不解析锚点、列表与多行块。
fn parse_yaml(path: &str, content: &str) -> Vec<SpringValue> {
    let mut values = Vec::new();
    let mut stack: Vec<(usize, String)> = Vec::new();
    for raw in content.lines() {
        let line = strip_comment(raw);
        if line.trim().is_empty() || line.trim_start().starts_with('-') {
            continue;
        }
        if line.trim() == "---" {
            stack.clear();
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let body = line.trim();
        let Some(colon) = body.find(':') else {
            continue;
        };
        let key = body[..colon].trim().trim_matches(['"', '\'']).to_string();
        if key.is_empty() {
            continue;
        }
        let raw_value = body[colon + 1..].trim();
        while stack.last().is_some_and(|(level, _)| *level >= indent) {
            stack.pop();
        }
        let mut path_parts = stack
            .iter()
            .map(|(_, part)| part.as_str())
            .collect::<Vec<_>>();
        path_parts.push(key.as_str());
        let name = path_parts.join(".");
        if raw_value.is_empty() {
            stack.push((indent, key));
            continue;
        }
        values.push(SpringValue {
            path: path.to_string(),
            name,
            value: unquote(raw_value),
        });
    }
    values
}

fn strip_comment(line: &str) -> String {
    // 只在空白之后的 `#` 才当注释，避免切掉 `jdbc:mysql://host#fragment`
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'#' && (index == 0 || bytes[index - 1].is_ascii_whitespace()) {
            return line[..index].to_string();
        }
        index += 1;
    }
    line.to_string()
}

fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    for quote in ['"', '\''] {
        if trimmed.len() >= 2 && trimmed.starts_with(quote) && trimmed.ends_with(quote) {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

#[derive(Debug, Default)]
struct JavaFacts {
    beans: Vec<SpringBean>,
    injections: Vec<SpringInjection>,
    endpoints: Vec<SpringEndpoint>,
    references: Vec<PropertyReference>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PropertyReference {
    pub key: String,
    pub path: String,
    pub line: u32,
}

/// 注入点先记类型，等所有 Bean 收齐后再解析成 Bean 名
#[derive(Debug)]
struct InjectionCandidate {
    path: String,
    line: u32,
    type_name: String,
}

#[derive(Debug)]
struct Pending {
    name: String,
    argument: Option<String>,
    line: u32,
}

/// 单文件 Java 事实：类级注解、成员注解与 `@Value` 引用。
/// 逐行状态机：注解入队，遇到声明行才消费。不处理跨行的注解参数。
fn parse_java(path: &str, content: &str) -> JavaFacts {
    let mut facts = JavaFacts::default();
    let mut injections: Vec<InjectionCandidate> = Vec::new();
    let mut pending: Vec<Pending> = Vec::new();
    let mut class_route: Option<String> = None;
    let mut block_comment = false;

    for (index, raw) in content.lines().enumerate() {
        let line_number = (index + 1) as u32;
        let line = strip_java_comments(raw, &mut block_comment);
        // 一行可以既是注解又是声明（`@Value("${x}") private String x;`），
        // 所以按「剥掉注解 → 再看剩下的」循环，而不是整行当成注解丢掉。
        let mut remainder = line.trim();
        loop {
            if remainder.is_empty() {
                break;
            }
            if let Some((name, argument, consumed)) = annotation_of(remainder) {
                if name == "Value" {
                    if let Some(argument) = &argument {
                        for key in reference_keys(argument) {
                            facts.references.push(PropertyReference {
                                key,
                                path: path.to_string(),
                                line: line_number,
                            });
                        }
                    }
                }
                pending.push(Pending {
                    name,
                    argument,
                    line: line_number,
                });
                remainder = remainder[consumed..].trim_start();
                continue;
            }
            if pending.is_empty() {
                break;
            }
            if let Some(class_name) = class_declaration(remainder) {
                if pending
                    .iter()
                    .any(|annotation| stereotype_of(&annotation.name).is_some())
                {
                    facts.beans.push(SpringBean {
                        name: decapitalize(&class_name),
                        type_name: class_name.clone(),
                        path: path.to_string(),
                        line: pending
                            .iter()
                            .map(|annotation| annotation.line)
                            .min()
                            .unwrap_or(line_number),
                    });
                }
                class_route = pending
                    .iter()
                    .find(|annotation| annotation.name == "RequestMapping")
                    .and_then(|annotation| annotation.argument.clone())
                    .map(|value| normalize_route(&value));
                pending.clear();
                break;
            }
            if let Some((return_type, method_name)) = method_declaration(remainder) {
                for annotation in &pending {
                    if let Some((http_method, route)) = mapping_of(&annotation.name, annotation.argument.as_deref())
                    {
                        let base = class_route.clone().unwrap_or_default();
                        facts.endpoints.push(SpringEndpoint {
                            path: path.to_string(),
                            method: http_method,
                            route: join_route(&base, &route),
                            line: annotation.line,
                        });
                    }
                    if annotation.name == "Bean" {
                        facts.beans.push(SpringBean {
                            name: method_name.clone(),
                            type_name: return_type.clone(),
                            path: path.to_string(),
                            line: annotation.line,
                        });
                    }
                }
                pending.clear();
                break;
            }
            if let Some((type_name, _)) = field_declaration(remainder) {
                if pending.iter().any(|annotation| annotation.name == "Autowired") {
                    injections.push(InjectionCandidate {
                        path: path.to_string(),
                        line: pending
                            .iter()
                            .map(|annotation| annotation.line)
                            .min()
                            .unwrap_or(line_number),
                        type_name,
                    });
                }
                pending.clear();
                break;
            }
            break;
        }
    }

    facts.injections = injections
        .into_iter()
        .map(|candidate| SpringInjection {
            path: candidate.path,
            line: candidate.line,
            bean: candidate.type_name,
        })
        .collect();
    facts
}

/// 逐行状态机里保留的注入点类型信息；解析 Bean 名时用
fn resolve_injections(injections: &mut Vec<SpringInjection>, beans: &[SpringBean]) {
    injections.retain_mut(|injection| {
        let wanted = injection.bean.clone();
        let Some(bean) = beans
            .iter()
            .find(|bean| bean.name == decapitalize(&wanted) || bean.type_name.ends_with(&wanted))
        else {
            // 外部依赖（仓库里的 Bean）解析不到：不猜名字，直接不报
            return false;
        };
        injection.bean = bean.name.clone();
        true
    });
}

fn strip_java_comments(line: &str, block_comment: &mut bool) -> String {
    let mut out = String::with_capacity(line.len());
    let bytes = line.as_bytes();
    let mut index = 0;
    let mut in_string: Option<u8> = None;
    while index < bytes.len() {
        let byte = bytes[index];
        if *block_comment {
            if byte == b'*' && bytes.get(index + 1) == Some(&b'/') {
                *block_comment = false;
                index += 2;
                continue;
            }
            index += 1;
            continue;
        }
        match in_string {
            Some(quote) => {
                out.push(byte as char);
                if byte == b'\\' {
                    if let Some(next) = bytes.get(index + 1) {
                        out.push(*next as char);
                        index += 2;
                        continue;
                    }
                } else if byte == quote {
                    in_string = None;
                }
                index += 1;
            }
            None => {
                if byte == b'"' || byte == b'\'' {
                    in_string = Some(byte);
                    out.push(byte as char);
                    index += 1;
                } else if byte == b'/' && bytes.get(index + 1) == Some(&b'/') {
                    break;
                } else if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
                    *block_comment = true;
                    index += 2;
                } else {
                    out.push(byte as char);
                    index += 1;
                }
            }
        }
    }
    out
}

/// `@Foo` / `@Foo("bar")` / `@Foo(value = "bar")`。
/// 返回（注解名, 第一个字符串实参, 这一行被消耗的字节数），便于处理同行声明。
fn annotation_of(line: &str) -> Option<(String, Option<String>, usize)> {
    let rest = line.strip_prefix('@')?;
    let name = rest
        .chars()
        .take_while(|character| character.is_alphanumeric() || *character == '_')
        .collect::<String>();
    if name.is_empty() {
        return None;
    }
    let mut consumed = 1 + name.len();
    let after_name = &rest[name.len()..];
    let mut argument = None;
    if let Some(open) = after_name.find('(') {
        let from_open = &after_name[open..];
        if let Some(close) = from_open.find(')') {
            argument = argument_of(&from_open[..=close]);
            consumed += open + close + 1;
        }
    }
    Some((name, argument, consumed))
}

/// 取注解第一个字符串实参：`("a")` → `a`，`(value = "a")` → `a`，`(method = RequestMethod.GET)` → None
fn argument_of(text: &str) -> Option<String> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    if close <= open {
        return None;
    }
    let inner = &text[open + 1..close];
    let quoted = inner.find(['"', '\''])?;
    let quote = inner.as_bytes()[quoted] as char;
    let rest = &inner[quoted + 1..];
    let end = rest.find(quote)?;
    Some(rest[..end].to_string())
}

fn stereotype_of(annotation: &str) -> Option<&'static str> {
    match annotation {
        "Component" => Some("Component"),
        "Service" => Some("Service"),
        "Repository" => Some("Repository"),
        "Controller" => Some("Controller"),
        "RestController" => Some("RestController"),
        "Configuration" => Some("Configuration"),
        _ => None,
    }
}

/// 类声明：取类名；`record`/`interface`/`enum` 同样算一个声明边界
fn class_declaration(line: &str) -> Option<String> {
    let captures = CLASS_DECLARATION.captures(line)?;
    captures.get(2).map(|value| value.as_str().to_string())
}

static CLASS_DECLARATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:public\s+|final\s+|abstract\s+)*(class|interface|enum|record)\s+(\w+)")
        .expect("静态类声明表达式恒有效")
});

/// 方法声明：返回（返回类型, 方法名）。排除赋值与调用
fn method_declaration(line: &str) -> Option<(String, String)> {
    let open = line.find('(')?;
    if line[..open].contains('=') {
        return None;
    }
    let head = line[..open].trim();
    let captures = METHOD_DECLARATION.captures(head)?;
    let name = captures.get(2)?.as_str();
    if matches!(name, "if" | "for" | "while" | "switch" | "catch" | "return" | "new") {
        return None;
    }
    let return_type = strip_modifiers(captures.get(1)?.as_str());
    if return_type.is_empty() {
        return None;
    }
    Some((return_type, name.to_string()))
}

static METHOD_DECLARATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([\w<>\[\],.?\s]+)\s+(\w+)\s*$").expect("静态方法声明表达式恒有效")
});

/// 去掉声明前的修饰符，只留类型本身（`public static String` → `String`）
fn strip_modifiers(value: &str) -> String {
    let mut rest = value.trim();
    loop {
        let mut advanced = false;
        for modifier in [
            "public", "private", "protected", "static", "final", "abstract", "synchronized",
            "default", "native", "strictfp",
        ] {
            if let Some(next) = rest.strip_prefix(modifier) {
                if next.starts_with([' ', '\t']) {
                    rest = next.trim_start();
                    advanced = true;
                    break;
                }
            }
        }
        if !advanced {
            return rest.to_string();
        }
    }
}

/// 字段声明：`private final Foo bar` → （Foo, bar）
fn field_declaration(line: &str) -> Option<(String, String)> {
    if line.contains('(') || line.contains(')') {
        return None;
    }
    let body = line.trim_end_matches(';').trim();
    if !body.ends_with(|character: char| character.is_alphanumeric() || character == '_') {
        return None;
    }
    let captures = FIELD_DECLARATION.captures(body)?;
    let modifiers = captures.get(1)?.as_str();
    if !["private", "protected", "public", "final", "static"]
        .iter()
        .any(|modifier| modifiers.contains(modifier))
    {
        return None;
    }
    Some((
        captures.get(2)?.as_str().to_string(),
        captures.get(3)?.as_str().to_string(),
    ))
}

static FIELD_DECLARATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^((?:[\w]+\s+)*)([\w<>\[\],.?]+)\s+(\w+)$").expect("静态字段声明表达式恒有效")
});

fn mapping_of(annotation: &str, argument: Option<&str>) -> Option<(String, String)> {
    let method = match annotation {
        "GetMapping" => "GET",
        "PostMapping" => "POST",
        "PutMapping" => "PUT",
        "DeleteMapping" => "DELETE",
        "PatchMapping" => "PATCH",
        "RequestMapping" => "ANY",
        _ => return None,
    };
    // 类级 @RequestMapping 只提供前缀，方法级才是端点
    Some((method.to_string(), argument.unwrap_or("").to_string()))
}

fn normalize_route(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

fn join_route(base: &str, route: &str) -> String {
    let base = normalize_route(base);
    let route = normalize_route(route);
    let joined = format!("{base}{route}");
    if joined.is_empty() {
        "/".to_string()
    } else {
        joined
    }
}

/// Java Beans 的变量名规则：前两个字母都大写时保持原样（`URL` → `URL`）
fn decapitalize(value: &str) -> String {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return String::new();
    };
    let rest = characters.as_str();
    if first.is_uppercase() && rest.chars().next().is_some_and(char::is_uppercase) {
        return value.to_string();
    }
    let mut out: String = first.to_lowercase().collect();
    out.push_str(rest);
    out
}

/// `${key}` / `${key:default}` 里的键；`@Value("#{...}")` 不是配置项，跳过
fn reference_keys(text: &str) -> Vec<String> {
    REFERENCE
        .captures_iter(text)
        .filter_map(|captures| captures.get(1).map(|value| value.as_str().to_string()))
        .collect()
}

static REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\$\{\s*([^}:\s]+)(?::[^}]*)?\s*\}").expect("静态引用表达式恒有效")
});

/// 全大写加下划线的键按环境变量处理，Spring 会从环境里取，不做未知键诊断
fn is_environment_style(key: &str) -> bool {
    key.chars()
        .all(|character| character.is_ascii_uppercase() || character == '_' || character.is_ascii_digit())
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn relative_slash(workspace: &Path, path: &Path) -> String {
    path.strip_prefix(workspace)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| file_name(path))
}

fn normalize_relative(value: &str) -> Option<String> {
    let path = Path::new(value.trim());
    if path.as_os_str().is_empty() || path.is_absolute() {
        return None;
    }
    if path.components().any(|component| {
        matches!(
            component,
            std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_)
        )
    }) {
        return None;
    }
    let value = path.to_string_lossy().replace('\\', "/");
    let trimmed = value.trim_matches('/').to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::path_util::WORKSPACE_MISSING;

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("创建目录");
        }
        fs::write(path, contents).expect("写入文件");
    }

    fn request(root: &Path) -> SpringIndexRequest {
        SpringIndexRequest {
            root: root.display().to_string(),
            paths: Vec::new(),
            metadata_repositories: Vec::new(),
            refresh_dependency_metadata: false,
            text_overrides: HashMap::new(),
        }
    }

    #[test]
    fn empty_project_yields_empty_index() {
        let dir = tempfile::tempdir().expect("临时目录");
        write(&dir.path().join("README.md"), "# nothing");
        let mut request = request(dir.path());
        request.metadata_repositories = vec![dir.path().join("missing-repo").display().to_string()];
        let result = index(request).expect("索引成功");
        assert!(result.properties.is_empty());
        assert!(result.values.is_empty());
        assert!(result.beans.is_empty());
        assert!(result.endpoints.is_empty());
        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    }

    #[test]
    fn missing_workspace_is_reported_in_chinese() {
        let error = index(SpringIndexRequest {
            root: "/definitely/missing/workspace".to_string(),
            ..Default::default()
        })
        .expect_err("必须报错");
        assert_eq!(error, WORKSPACE_MISSING);
    }

    #[test]
    fn properties_parsing_handles_separators_and_continuations() {
        let values = parse_properties(
            "app/src/main/resources/application.properties",
            "# 注释\nserver.port=8081\napp.greeting: 你好\nspaced = value\nlong=one\\\n  two\n! 感叹号注释\n",
        );
        let pairs: Vec<(&str, &str)> = values
            .iter()
            .map(|value| (value.name.as_str(), value.value.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("server.port", "8081"),
                ("app.greeting", "你好"),
                ("spaced", "value"),
                ("long", "onetwo"),
            ]
        );
    }

    #[test]
    fn yaml_parsing_flattens_nested_keys_and_skips_lists() {
        let values = parse_yaml(
            "app/src/main/resources/application.yml",
            "server:\n  port: 8081\nspring:\n  application:\n    name: demo\n  profiles:\n    - dev\napp:\n  greeting: \"hi\"  # 注释\n",
        );
        let pairs: Vec<(&str, &str)> = values
            .iter()
            .map(|value| (value.name.as_str(), value.value.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("server.port", "8081"),
                ("spring.application.name", "demo"),
                ("app.greeting", "hi"),
            ]
        );
    }

    #[test]
    fn java_scan_finds_value_references_and_unknown_keys() {
        let facts = parse_java(
            "app/src/main/java/com/example/App.java",
            r#"package com.example;

import org.springframework.beans.factory.annotation.Value;

class App {
    // 说明文字 @Value("${ignored.in.comment}")
    @Value("${app.greeting}")
    private String greeting;

    @Value("${app.missing:fallback}")
    private String missing;

    public String hello() {
        String url = "http://example.com/${not.a.reference}";
        return url;
    }
}
"#,
        );
        let keys: Vec<&str> = facts
            .references
            .iter()
            .map(|reference| reference.key.as_str())
            .collect();
        assert_eq!(keys, vec!["app.greeting", "app.missing"]);
        assert_eq!(facts.references[0].line, 7);
    }

    #[test]
    fn java_scan_collects_beans_endpoints_and_injections() {
        let facts = parse_java(
            "app/src/main/java/com/example/HelloController.java",
            r#"package com.example;

@RestController
@RequestMapping("/api")
class HelloController {
    @Autowired
    private GreetingService greetings;

    @GetMapping("/hello")
    public String hello() {
        return greetings.text();
    }

    @PostMapping(value = "/echo")
    public String echo(String body) {
        return body;
    }
}
"#,
        );
        assert_eq!(facts.beans.len(), 1);
        assert_eq!(facts.beans[0].name, "helloController");
        assert!(facts.beans[0].type_name.contains("HelloController"));
        let routes: Vec<(&str, &str)> = facts
            .endpoints
            .iter()
            .map(|endpoint| (endpoint.method.as_str(), endpoint.route.as_str()))
            .collect();
        assert_eq!(routes, vec![("GET", "/api/hello"), ("POST", "/api/echo")]);
        assert_eq!(facts.injections.len(), 1);
        assert_eq!(facts.injections[0].bean, "GreetingService");
    }

    #[test]
    fn java_scan_handles_service_beans_and_bean_methods() {
        let facts = parse_java(
            "app/src/main/java/com/example/GreetingService.java",
            r#"package com.example;

import org.springframework.context.annotation.Bean;

@Service
class GreetingService {
    @Bean
    public Greeting greeting() {
        return new Greeting();
    }
}
"#,
        );
        let names: Vec<&str> = facts.beans.iter().map(|bean| bean.name.as_str()).collect();
        assert_eq!(names, vec!["greetingService", "greeting"]);
    }

    #[test]
    fn injections_split_into_type_matches_and_external_beans() {
        let mut injections = vec![
            SpringInjection {
                path: "a.java".to_string(),
                line: 3,
                bean: "GreetingService".to_string(),
            },
            SpringInjection {
                path: "a.java".to_string(),
                line: 4,
                bean: "JdbcTemplate".to_string(),
            },
        ];
        let beans = vec![SpringBean {
            name: "greetingService".to_string(),
            type_name: "GreetingService".to_string(),
            path: "b.java".to_string(),
            line: 6,
        }];
        resolve_injections(&mut injections, &beans);
        assert_eq!(injections.len(), 1);
        assert_eq!(injections[0].bean, "greetingService");
    }

    #[test]
    fn index_reports_unknown_value_keys_but_keeps_known_and_env_ones() {
        let dir = tempfile::tempdir().expect("临时目录");
        write(
            &dir.path().join("app/src/main/resources/application.properties"),
            "app.greeting=hi\n",
        );
        write(
            &dir.path().join("app/src/main/java/com/example/App.java"),
            r#"package com.example;

class App {
    @Value("${app.greeting}")
    private String greeting;

    @Value("${app.missing}")
    private String missing;

    @Value("${JAVA_HOME}")
    private String home;
}
"#,
        );
        let result = index(request(dir.path())).expect("索引成功");
        assert_eq!(result.values.len(), 1);
        assert_eq!(result.diagnostics.len(), 1, "{:?}", result.diagnostics);
        assert_eq!(result.diagnostics[0].message, "未找到配置项 app.missing");
        assert_eq!(result.diagnostics[0].line, 7);
        assert_eq!(result.diagnostics[0].path, "app/src/main/java/com/example/App.java");
    }

    #[test]
    fn project_metadata_feeds_completion() {
        let dir = tempfile::tempdir().expect("临时目录");
        let empty_repo = tempfile::tempdir().expect("空仓库");
        write(
            &dir.path().join("app/src/main/resources/spring-configuration-metadata.json"),
            r#"{"properties":[{"name":"app.custom","defaultValue":"off"},{"name":"app.greeting"}]}"#,
        );
        let mut request = request(dir.path());
        request.metadata_repositories =
            vec![empty_repo.path().display().to_string()];
        let result = index(request).expect("索引成功");
        let names: Vec<&str> = result
            .properties
            .iter()
            .map(|property| property.name.as_str())
            .collect();
        assert_eq!(names, vec!["app.custom", "app.greeting"]);
        assert_eq!(result.properties[0].default_value.as_deref(), Some("off"));
        assert_eq!(result.properties[0].source, "spring-configuration-metadata.json");
    }

    #[test]
    fn dependency_jars_feed_completion_from_a_repository() {
        use std::io::Write;
        use zip::write::{SimpleFileOptions, ZipWriter};
        use zip::CompressionMethod;

        let dir = tempfile::tempdir().expect("临时目录");
        let repository = tempfile::tempdir().expect("临时仓库");
        let jar = repository
            .path()
            .join("org/example/demo-spring-boot-starter/1.0.0/demo-spring-boot-starter-1.0.0.jar");
        fs::create_dir_all(jar.parent().expect("父目录")).expect("建目录");
        {
            let file = File::create(&jar).expect("建 jar");
            let mut writer = ZipWriter::new(file);
            let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            writer
                .start_file("META-INF/spring-configuration-metadata.json", options)
                .expect("写入条目");
            writer
                .write_all(br#"{"properties":[{"name":"demo.enabled","defaultValue":"true"}]}"#)
                .expect("写入正文");
            writer.finish().expect("收尾");
        }
        // 同目录再放一个不是 zip 的假 jar：必须被安静跳过
        write(&repository.path().join("broken.jar"), "not a zip");

        let mut request = request(dir.path());
        request.metadata_repositories = vec![repository.path().display().to_string()];
        let result = index(request).expect("索引成功");
        assert_eq!(result.properties.len(), 1, "{:?}", result.properties);
        assert_eq!(result.properties[0].name, "demo.enabled");
        assert_eq!(result.properties[0].default_value.as_deref(), Some("true"));
        assert_eq!(result.properties[0].source, "demo-spring-boot-starter-1.0.0.jar");
    }

    #[test]
    fn default_repository_scan_caches_and_completes_on_this_machine() {
        let Some(home) = std::env::var_os("HOME") else {
            return;
        };
        let repository = PathBuf::from(home).join(".m2").join("repository");
        if !repository.is_dir() {
            return;
        }
        let first = repository_metadata(&repository, true, MAX_METADATA_KEYS);
        assert!(first.1, "本地仓库规模应当在预算内扫完");
        if first.0.is_empty() {
            // 机器上还没有 Spring 依赖：不算失败，只是没有可断言的输入
            return;
        }
        assert!(first.0.iter().all(|property| !property.name.is_empty()));
        let cached = repository_metadata(&repository, false, MAX_METADATA_KEYS);
        assert_eq!(cached.0, first.0, "refresh=false 必须复用进程内快照");
    }

    #[test]
    fn text_overrides_win_over_disk_and_are_bounded() {
        let dir = tempfile::tempdir().expect("临时目录");
        let path = dir.path().join("app/src/main/java/com/example/App.java");
        write(&path, "class App {}\n");
        let mut request = request(dir.path());
        request.text_overrides.insert(
            "app/src/main/java/com/example/App.java".to_string(),
            "class App {\n  @Value(\"${unsaved.key}\")\n  private String x;\n}\n".to_string(),
        );
        let result = index(request).expect("索引成功");
        assert_eq!(result.diagnostics.len(), 1);
        assert_eq!(result.diagnostics[0].message, "未找到配置项 unsaved.key");

        // 超过上限的正文按字符边界截断，不产生半截 UTF-8（诊断见下一个用例）
        let oversized = "a".repeat(MAX_OVERRIDE_BYTES + 10);
        let truncated = truncate_override(&oversized);
        assert_eq!(truncated.len(), MAX_OVERRIDE_BYTES);
        let multi = "你".repeat(MAX_OVERRIDE_BYTES);
        let truncated = truncate_override(&multi);
        assert!(truncated.len() <= MAX_OVERRIDE_BYTES);
        assert!(truncated.chars().all(|character| character == '你'));
    }

    #[test]
    fn text_overrides_reject_traversal_and_extra_files() {
        let mut overrides = HashMap::new();
        overrides.insert("../outside.properties".to_string(), "a=1".to_string());
        overrides.insert("/etc/passwd".to_string(), "a=1".to_string());
        for index in 0..(MAX_OVERRIDE_FILES + 5) {
            overrides.insert(format!("app/src/main/resources/application-{index}.properties"), "a=1".to_string());
        }
        let kept = sanitize_overrides(&overrides);
        assert_eq!(kept.files.len(), MAX_OVERRIDE_FILES);
        assert!(!kept.files.keys().any(|key| key.starts_with("..")));
        assert!(!kept.files.keys().any(|key| key.starts_with('/')));
        assert!(kept.dropped >= 5, "超出上限与被拒绝的路径都要计数");
    }

    #[test]
    fn oversized_overrides_are_reported_not_silently_cut() {
        let dir = tempfile::tempdir().expect("临时目录");
        let mut request = request(dir.path());
        request.metadata_repositories = vec![dir.path().join("missing-repo").display().to_string()];
        request.text_overrides.insert(
            "app/src/main/resources/application.properties".to_string(),
            format!("app.greeting={}\n", "x".repeat(MAX_OVERRIDE_BYTES + 10)),
        );
        let result = index(request).expect("索引成功");
        assert!(
            result
                .diagnostics
                .iter()
                .any(|item| item.message.contains("超过 256 KB")),
            "{:?}",
            result.diagnostics
        );
    }

    #[test]
    fn candidate_walk_ignores_build_output_and_caps_source_count() {
        let dir = tempfile::tempdir().expect("临时目录");
        write(&dir.path().join("target/classes/Stale.java"), "class Stale {}");
        write(&dir.path().join("app/src/App.java"), "class App {}");
        write(
            &dir.path().join("app/src/main/resources/application.properties"),
            "a=1\n",
        );
        let mut diagnostics = Vec::new();
        let candidates = candidate_files(dir.path(), &[], &mut diagnostics);
        assert_eq!(candidates.java.len(), 1);
        assert_eq!(candidates.config.len(), 1);
        assert!(candidates.java[0].ends_with("App.java"));
        assert!(diagnostics.is_empty());
    }

    #[test]
    fn spring_config_file_names_are_recognised() {
        for name in [
            "application.properties",
            "application-dev.yml",
            "application-prod.yaml",
            "bootstrap.properties",
        ] {
            assert!(is_spring_config_file(name), "{name}");
        }
        for name in ["application.txt", "myapplication.properties", "config.yaml"] {
            assert!(!is_spring_config_file(name), "{name}");
        }
    }

    #[test]
    fn unreadable_archive_is_skipped_quietly() {
        let dir = tempfile::tempdir().expect("临时目录");
        write(&dir.path().join("not-a-jar.jar"), "definitely not a zip");
        let (properties, complete) = scan_repository(dir.path(), MAX_METADATA_KEYS);
        assert!(properties.is_empty());
        assert!(complete);
    }

    #[test]
    fn routes_are_normalised_and_joined() {
        assert_eq!(join_route("/api/", "hello"), "/api/hello");
        assert_eq!(join_route("", "/hello"), "/hello");
        assert_eq!(join_route("/", ""), "/");
        assert_eq!(normalize_route("api"), "/api");
    }

    #[test]
    fn environment_style_keys_are_skipped() {
        assert!(is_environment_style("JAVA_HOME"));
        assert!(is_environment_style("PORT_2"));
        assert!(!is_environment_style("app.greeting"));
    }
}
