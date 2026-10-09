//! 运行配置：生成、分层合并、启动计划。
//!
//! 三层文档在这里只保留两层真正需要的：生成层（每次现算，不落盘）与项目层
//! `.prismcode/run/project.json`（团队共享的覆盖）。机器本地的覆盖由前端传入，
//! 不落盘、不带版本。整套东西不启 Maven/Gradle daemon，也不做模型查询。

use crate::commands::maven::{scan_reactor, ReactorScan};
use crate::commands::path_util::{canonical_workspace_root, existing_workspace_root};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const RUNCONFIG_TIMEOUT: Duration = Duration::from_secs(10);
const TOOLCHAIN_TIMEOUT: Duration = Duration::from_secs(5);
const PROJECT_LAYER: &str = ".prismcode/run/project.json";
/// JDWP 串与 Lithe 的 `JavaDebugService` 逐字一致：attach 模式、挂起启动，
/// 调试器连上之前目标 JVM 不执行任何用户代码
const JDWP_TEMPLATE: &str = "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:{}";
const SPRING_BOOT_PLUGIN: &str = "spring-boot-maven-plugin";

pub const KIND_JAVA_CURRENT_FILE: &str = "java.current-file";
pub const KIND_MAVEN_MODULE: &str = "maven.module";
pub const KIND_SPRING_BOOT_MAVEN: &str = "spring-boot.maven";
pub const KIND_GRADLE_TASK: &str = "gradle.task";
/// `kind` 是前端 switch 的依据，也是项目层覆盖的目标：允许值收敛在这四个字面量里
const KINDS: [&str; 4] = [
    KIND_JAVA_CURRENT_FILE,
    KIND_MAVEN_MODULE,
    KIND_SPRING_BOOT_MAVEN,
    KIND_GRADLE_TASK,
];

const TOOLCHAIN_MAVEN: &str = "maven";
const TOOLCHAIN_GRADLE: &str = "gradle";
const TOOLCHAIN_JAVA: &str = "java";

const CONFIDENCE_DECLARED: &str = "declared";
const CONFIDENCE_INFERRED: &str = "inferred";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunConfiguration {
    pub id: String,
    pub label: String,
    pub kind: String,
    /// 项目相对模块路径，`.` 表示构建根
    pub module: String,
    /// 项目相对工作目录
    pub cwd: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// `declared`：来自构建文件的声明；`inferred`：按约定推断
    pub confidence: String,
    /// 可执行文件由哪个工具链提供（缺工具链时报诊断而不是直接失败）
    pub toolchain: Option<String>,
}

/// 分层覆盖：每个字段独立可选，未写的字段保留下层值。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationPatch {
    pub label: Option<String>,
    pub kind: Option<String>,
    pub module: Option<String>,
    pub cwd: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<BTreeMap<String, String>>,
    pub confidence: Option<String>,
    pub toolchain: Option<String>,
}

impl ConfigurationPatch {
    fn apply(&self, configuration: &mut RunConfiguration) {
        if let Some(value) = &self.label {
            configuration.label = value.clone();
        }
        if let Some(value) = &self.kind {
            configuration.kind = value.clone();
        }
        if let Some(value) = &self.module {
            configuration.module = value.clone();
        }
        if let Some(value) = &self.cwd {
            configuration.cwd = value.clone();
        }
        if let Some(value) = &self.command {
            configuration.command = value.clone();
        }
        if let Some(value) = &self.args {
            configuration.args = value.clone();
        }
        if let Some(value) = &self.env {
            configuration.env = value.clone();
        }
        if let Some(value) = &self.confidence {
            configuration.confidence = value.clone();
        }
        if let Some(value) = &self.toolchain {
            configuration.toolchain = Some(value.clone());
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayerEntry {
    id: String,
    #[serde(flatten)]
    patch: ConfigurationPatch,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayerDocument {
    #[serde(default)]
    configurations: Vec<LayerEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunConfigDiagnostic {
    pub path: String,
    pub message: String,
    pub severity: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateResult {
    pub configurations: Vec<RunConfiguration>,
    pub diagnostics: Vec<RunConfigDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainCandidate {
    pub id: String,
    pub kind: String,
    pub path: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResult {
    pub effective: Vec<RunConfiguration>,
    pub diagnostics: Vec<RunConfigDiagnostic>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPlan {
    pub cwd: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub debug_port: Option<u16>,
}

fn diagnostic(path: impl Into<String>, message: impl Into<String>, severity: &str) -> RunConfigDiagnostic {
    RunConfigDiagnostic {
        path: path.into(),
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
    match tokio::time::timeout(RUNCONFIG_TIMEOUT, handle).await {
        Ok(joined) => joined.map_err(|error| format!("{label}失败: {error}"))?,
        Err(_) => Err(format!("{label}超时")),
    }
}

/// 生成层：从构建文件现算可运行条目，不写盘。
#[tauri::command]
pub async fn runconfig_generate(root: String) -> Result<GenerateResult, String> {
    run_blocking("生成运行配置", move || {
        let workspace = existing_workspace_root(&root)?;
        Ok(generate_run_configurations(&workspace))
    })
    .await
}

/// 宿主工具链探测：包装器优先，失败一律跳过（缺工具链由 resolve 报诊断）。
#[tauri::command]
pub async fn runconfig_toolchains(
    app: tauri::AppHandle,
    root: String,
) -> Result<Vec<ToolchainCandidate>, String> {
    run_blocking("探测构建工具链", move || {
        let workspace = existing_workspace_root(&root)?;
        let fallback_java = crate::commands::java::bundled_java_binary(&app, None);
        Ok(detect_toolchains(&workspace, fallback_java))
    })
    .await
}

/// 合并生成层、项目层与前端传入的本地层，并按工具链候选报缺失诊断。
#[tauri::command]
pub async fn runconfig_resolve(
    root: String,
    toolchain_candidates: Vec<ToolchainCandidate>,
    local_overrides: Option<Value>,
) -> Result<ResolveResult, String> {
    run_blocking("解析运行配置", move || {
        let workspace = existing_workspace_root(&root)?;
        let result = resolve(&workspace, &toolchain_candidates, local_overrides.as_ref())?;
        Ok(result)
    })
    .await
}

/// 把一条配置投射成可直接执行的命令；调试态注入 JDWP 并返回端口。
#[tauri::command]
pub async fn runconfig_launch_plan(
    app: tauri::AppHandle,
    root: String,
    configuration_id: String,
    current_file: Option<String>,
    debug: bool,
    debug_port: Option<u16>,
) -> Result<LaunchPlan, String> {
    run_blocking("准备运行计划", move || {
        let workspace = existing_workspace_root(&root)?;
        let fallback_java = crate::commands::java::bundled_java_binary(&app, None);
        launch_plan(
            &workspace,
            &configuration_id,
            current_file.as_deref(),
            debug,
            debug_port,
            fallback_java,
        )
    })
    .await
}

/// 生成层：Maven 反应堆 → 每模块可运行条目；Gradle 只做插件映射；
/// 完全没有构建文件时才给「运行当前文件」。
pub fn generate_run_configurations(workspace: &Path) -> GenerateResult {
    let mut diagnostics = Vec::new();
    let mut configurations = Vec::new();
    let reactor = scan_reactor(workspace, &[]).unwrap_or_else(|error| {
        diagnostics.push(diagnostic("pom.xml", error, "error"));
        ReactorScan::default()
    });
    for item in &reactor.diagnostics {
        diagnostics.push(diagnostic(item.path.clone(), item.message.clone(), &item.severity));
    }

    if !reactor.modules.is_empty() {
        configurations.extend(maven_configurations(workspace, &reactor));
    }
    configurations.extend(gradle_configurations(workspace));

    // 兜底只跟「有没有构建文件」有关：pom.xml 畸形时一个模块都没解析出来，
    // 也不能改口说这是个单文件项目，否则界面会给出一个跑不起来的「运行当前文件」。
    if !has_build_files(workspace) {
        configurations.push(java_current_file_configuration());
    }
    GenerateResult {
        configurations,
        diagnostics,
    }
}

fn maven_configurations(workspace: &Path, reactor: &ReactorScan) -> Vec<RunConfiguration> {
    let command = wrapper_or(workspace, &reactor.root, "mvnw", "mvn");
    let mut configurations = Vec::new();
    for module in &reactor.modules {
        // 聚合器不产出构件：在它上面跑 test/package/clean 只会白等，run 更无从谈起
        if module.is_aggregator() {
            continue;
        }
        let cwd = reactor.root_relative.clone();
        let prefix = module_flag(&module.relative_path);
        let label_module = module_label(module);
        for (action, args) in [
            ("test", vec!["test".to_string()]),
            ("package", vec!["-DskipTests".to_string(), "package".to_string()]),
            ("clean", vec!["clean".to_string()]),
        ] {
            let mut full = maven_base_args(&prefix);
            full.extend(args);
            configurations.push(RunConfiguration {
                id: format!("{KIND_MAVEN_MODULE}:{}:{action}", module.relative_path),
                label: format!("{label_module} · {action}"),
                kind: KIND_MAVEN_MODULE.to_string(),
                module: module.relative_path.clone(),
                cwd: cwd.clone(),
                command: command.clone(),
                args: full,
                env: BTreeMap::new(),
                confidence: CONFIDENCE_DECLARED.to_string(),
                toolchain: Some(TOOLCHAIN_MAVEN.to_string()),
            });
        }
        if module.applies_plugin(SPRING_BOOT_PLUGIN) {
            let mut args = maven_base_args(&prefix);
            args.push("spring-boot:run".to_string());
            configurations.push(RunConfiguration {
                id: format!("{KIND_SPRING_BOOT_MAVEN}:{}", module.relative_path),
                label: format!("{label_module} · run"),
                kind: KIND_SPRING_BOOT_MAVEN.to_string(),
                module: module.relative_path.clone(),
                cwd,
                command: command.clone(),
                args,
                env: BTreeMap::new(),
                confidence: CONFIDENCE_DECLARED.to_string(),
                toolchain: Some(TOOLCHAIN_MAVEN.to_string()),
            });
        }
    }
    configurations
}

/// `-B -ntp`：批处理输出 + 关掉传输进度条，终端里只留可读日志。
/// 模块选择用 `-pl`：相对反应堆根解析，父 POM 与兄弟模块仍在同一次调用里可见。
fn maven_base_args(module_flag: &[String]) -> Vec<String> {
    let mut args = vec!["-B".to_string(), "-ntp".to_string()];
    args.extend(module_flag.iter().cloned());
    args
}

fn module_flag(relative_path: &str) -> Vec<String> {
    if relative_path == "." || relative_path.is_empty() {
        Vec::new()
    } else {
        vec!["-pl".to_string(), relative_path.to_string()]
    }
}

/// 标签用模块的项目相对路径而不是 artifactId：同名 artifact 出现在两个目录时，
/// 只有路径能区分两条配置。
fn module_label(module: &crate::commands::maven::DeclaredModule) -> String {
    if module.relative_path == "." {
        "root".to_string()
    } else {
        module.relative_path.clone()
    }
}

/// Gradle：只读 settings 的 include 与各 build 脚本的插件 id，映射到任务名。
/// 有意不启 Gradle daemon、不查 task 模型：多出的语义与常驻进程不成比例。
fn gradle_configurations(workspace: &Path) -> Vec<RunConfiguration> {
    let Some(root_build) = gradle_build_file(workspace) else {
        return Vec::new();
    };
    let command = wrapper_or(workspace, workspace, "gradlew", "gradle");
    let mut configurations = Vec::new();
    let mut projects = vec![GradleProject {
        path: ".".to_string(),
        directory: workspace.to_path_buf(),
        build_file: root_build,
    }];
    for name in gradle_included_projects(workspace) {
        let directory = workspace.join(name.replace(':', "/"));
        if let Some(build_file) = gradle_build_file(&directory) {
            projects.push(GradleProject {
                path: format!(":{}", name.trim_matches(':')),
                directory,
                build_file,
            });
        }
    }

    for project in projects {
        let Some(text) = fs::read_to_string(&project.build_file).ok() else {
            continue;
        };
        let relative = gradle_project_cwd(workspace, &project.directory);
        let task_prefix = if project.path == "." {
            String::new()
        } else {
            format!("{}:", project.path)
        };
        let label_module = project
            .directory
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "root".to_string());
        for (action, task, confidence) in [
            ("test", "test", CONFIDENCE_INFERRED),
            ("package", "build", CONFIDENCE_INFERRED),
        ] {
            configurations.push(RunConfiguration {
                id: format!("{KIND_GRADLE_TASK}:{}:{action}", project.path),
                label: format!("{label_module} · {action}"),
                kind: KIND_GRADLE_TASK.to_string(),
                module: project.path.clone(),
                cwd: relative.clone(),
                command: command.clone(),
                args: vec![format!("{task_prefix}{task}")],
                env: BTreeMap::new(),
                confidence: confidence.to_string(),
                toolchain: Some(TOOLCHAIN_GRADLE.to_string()),
            });
        }
        if let Some(task) = gradle_framework_task(&text) {
            configurations.push(RunConfiguration {
                id: format!("{KIND_GRADLE_TASK}:{}:run", project.path),
                label: format!("{label_module} · run"),
                kind: KIND_GRADLE_TASK.to_string(),
                module: project.path.clone(),
                cwd: relative,
                command: command.clone(),
                args: vec![format!("{task_prefix}{task}")],
                env: BTreeMap::new(),
                confidence: CONFIDENCE_DECLARED.to_string(),
                toolchain: Some(TOOLCHAIN_GRADLE.to_string()),
            });
        }
    }
    configurations
}

struct GradleProject {
    /// Gradle 项目路径：`.` 表示根项目，子项目形如 `:app`
    path: String,
    directory: PathBuf,
    build_file: PathBuf,
}

fn gradle_project_cwd(workspace: &Path, directory: &Path) -> String {
    directory
        .strip_prefix(workspace)
        .ok()
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| ".".to_string())
}

fn gradle_build_file(directory: &Path) -> Option<PathBuf> {
    for name in ["build.gradle.kts", "build.gradle"] {
        let candidate = directory.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// 子项目来自 `settings.gradle[.kts]` 的 `include ':app'` / `include(":app")`。
/// 只认引号里的名字：脚本里可以有任意 Groovy/Kotlin 表达式，解释执行不是这里的活。
fn gradle_included_projects(workspace: &Path) -> Vec<String> {
    for settings in ["settings.gradle.kts", "settings.gradle"] {
        let Ok(text) = fs::read_to_string(workspace.join(settings)) else {
            continue;
        };
        let mut names: Vec<String> = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if !line.starts_with("include") {
                continue;
            }
            for quote in ['\'', '"'] {
                let mut rest = line;
                while let Some(start) = rest.find(quote) {
                    rest = &rest[start + 1..];
                    let Some(end) = rest.find(quote) else { break };
                    let name = rest[..end].trim().trim_matches(':').to_string();
                    rest = &rest[end + 1..];
                    if !name.is_empty() && !names.contains(&name) {
                        names.push(name);
                    }
                }
            }
        }
        if !names.is_empty() {
            return names;
        }
    }
    Vec::new()
}

/// 应用插件 → 启动任务。每个插件都自己命名任务，猜错会静默跑空。
fn gradle_framework_task(build: &str) -> Option<&'static str> {
    for (plugin, task) in [
        ("org.springframework.boot", "bootRun"),
        ("io.quarkus", "quarkusDev"),
        ("io.micronaut.application", "run"),
    ] {
        let single = format!("id '{plugin}'");
        let double = format!("id(\"{plugin}\")");
        let parenthesised = format!("id('{plugin}')");
        if build.contains(&single) || build.contains(&double) || build.contains(&parenthesised) {
            return Some(task);
        }
    }
    None
}

/// 与前端 `detectJavaBuildTool` 同一顺序：包装器、pom、gradle 脚本任意一个存在，
/// 就说明这是构建工具项目，单文件兜底不适用。
fn has_build_files(workspace: &Path) -> bool {
    ["mvnw", "mvnw.cmd", "pom.xml", "gradlew", "gradlew.bat", "build.gradle", "build.gradle.kts"]
        .iter()
        .any(|name| workspace.join(name).is_file())
}

/// 没有构建文件时的兜底：直接跑当前文件（`java <file>`）。
fn java_current_file_configuration() -> RunConfiguration {
    RunConfiguration {
        id: format!("{KIND_JAVA_CURRENT_FILE}:current"),
        label: "当前文件 · run".to_string(),
        kind: KIND_JAVA_CURRENT_FILE.to_string(),
        module: ".".to_string(),
        cwd: ".".to_string(),
        command: TOOLCHAIN_JAVA.to_string(),
        args: Vec::new(),
        env: BTreeMap::new(),
        confidence: CONFIDENCE_INFERRED.to_string(),
        toolchain: Some(TOOLCHAIN_JAVA.to_string()),
    }
}

fn wrapper_or(workspace: &Path, build_root: &Path, wrapper: &str, fallback: &str) -> String {
    let candidate = build_root.join(wrapper);
    let executable = candidate.is_file() && {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::metadata(&candidate)
                .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        }
        #[cfg(not(unix))]
        {
            true
        }
    };
    if executable {
        // 工作目录就在构建根，用相对路径调用可以免去 Windows 上的路径分隔符分叉
        let relative = build_root
            .strip_prefix(workspace)
            .ok()
            .map(|value| value.to_string_lossy().replace('\\', "/"))
            .filter(|value| !value.is_empty());
        return match relative {
            Some(prefix) => format!("./{prefix}/{wrapper}"),
            None => format!("./{wrapper}"),
        };
    }
    fallback.to_string()
}

/// 合并三层并报工具链缺失诊断；命令与服务端测试共用同一入口。
pub fn resolve(
    workspace: &Path,
    candidates: &[ToolchainCandidate],
    local_overrides: Option<&Value>,
) -> Result<ResolveResult, String> {
    let generate = generate_run_configurations(workspace);
    let mut effective = generate.configurations;
    let mut diagnostics = generate.diagnostics;

    let project_layer = read_project_layer(workspace)?;
    apply_layer(&mut effective, &project_layer, PROJECT_LAYER, &mut diagnostics);
    if let Some(value) = local_overrides {
        match serde_json::from_value::<LayerDocument>(value.clone()) {
            Ok(document) => apply_layer(&mut effective, &document, "本地覆盖", &mut diagnostics),
            Err(error) => diagnostics.push(diagnostic(
                "本地覆盖",
                format!("本地覆盖不是合法运行配置文档: {error}"),
                "warning",
            )),
        }
    }

    let mut reported = Vec::new();
    for configuration in &effective {
        let Some(kind) = &configuration.toolchain else {
            continue;
        };
        if candidates.iter().any(|candidate| &candidate.kind == kind) {
            continue;
        }
        let key = (kind.clone(), configuration.id.clone());
        if reported.contains(&key) {
            continue;
        }
        reported.push(key);
        diagnostics.push(diagnostic(
            PROJECT_LAYER,
            format!(
                "未检测到 {kind} 工具链，运行配置「{}」暂时无法执行",
                configuration.label
            ),
            "warning",
        ));
    }

    Ok(ResolveResult {
        effective,
        diagnostics,
    })
}

fn read_project_layer(workspace: &Path) -> Result<LayerDocument, String> {
    let path = workspace.join(PROJECT_LAYER);
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(LayerDocument::default());
    };
    serde_json::from_str(&text)
        .map_err(|error| format!("{PROJECT_LAYER} 不是合法 JSON: {error}"))
}

/// 覆盖按 id 对齐。生成层里没有的 id 只报诊断不新增：用户手写的运行配置属于
/// 以后的能力，静默接受一个缺 command 的条目只会在启动时才炸。
fn apply_layer(
    configurations: &mut [RunConfiguration],
    layer: &LayerDocument,
    source: &str,
    diagnostics: &mut Vec<RunConfigDiagnostic>,
) {
    for entry in &layer.configurations {
        let Some(target) = configurations.iter_mut().find(|item| item.id == entry.id) else {
            diagnostics.push(diagnostic(
                source,
                format!("运行配置「{}」不在生成结果中，已忽略", entry.id),
                "warning",
            ));
            continue;
        };
        entry.patch.apply(target);
        if !KINDS.contains(&target.kind.as_str()) {
            diagnostics.push(diagnostic(
                source,
                format!("运行配置「{}」的 kind 「{}」不受支持", entry.id, target.kind),
                "error",
            ));
        }
    }
}

/// 把一条配置投射成命令；命令与服务端测试共用同一入口。
#[allow(clippy::too_many_arguments)]
pub fn launch_plan(
    workspace: &Path,
    configuration_id: &str,
    current_file: Option<&str>,
    debug: bool,
    debug_port: Option<u16>,
    fallback_java: Option<PathBuf>,
) -> Result<LaunchPlan, String> {
    // cwd 会被直接写进终端命令，必须是规范绝对路径
    let workspace = canonical_workspace_root(workspace)?;
    let workspace = workspace.as_path();
    let resolved = resolve(workspace, &[], None)?;
    let configuration = resolved
        .effective
        .iter()
        .find(|item| item.id == configuration_id)
        .ok_or_else(|| format!("找不到运行配置: {configuration_id}"))?;

    let reactor = scan_reactor(workspace, &[]).unwrap_or_default();
    if reactor
        .module(&configuration.module)
        .is_some_and(|module| module.is_aggregator())
    {
        return Err("聚合模块不可直接运行，请选择子模块".to_string());
    }

    let mut command = configuration.command.clone();
    let mut args = configuration.args.clone();
    let mut env = configuration.env.clone();
    let mut port = None;

    if configuration.kind == KIND_JAVA_CURRENT_FILE {
        let file = current_file
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "请先打开一个 Java 文件".to_string())?;
        let absolute = absolute_from(workspace, file);
        if !absolute.is_file() {
            return Err(format!("源文件不存在: {file}"));
        }
        // 内嵌 JRE 兜底：用户机器上没装 JDK 时 `java` 不在 PATH，但语言服务用的
        // 那份 Temurin 一直在包里，跑单文件不需要额外安装。
        if command == TOOLCHAIN_JAVA && !program_on_path(TOOLCHAIN_JAVA) {
            if let Some(binary) = fallback_java {
                command = binary.display().to_string();
            }
        }
        args = vec![absolute.display().to_string()];
    }

    if let Some(file) = current_file.map(str::trim).filter(|value| !value.is_empty()) {
        if configuration.kind == KIND_MAVEN_MODULE {
            apply_test_filter(workspace, configuration, file, &mut args);
        }
    }

    if debug {
        let resolved_port = match debug_port {
            Some(value) => value,
            None => free_port()?,
        };
        let jdwp = JDWP_TEMPLATE.replace("{}", &resolved_port.to_string());
        match configuration.kind.as_str() {
            // Spring Boot 的插件给 fork 出来的应用 JVM 单独开了参数通道；
            // MAVEN_OPTS 只影响 Maven 自己，注入到那里目标进程收不到。
            KIND_SPRING_BOOT_MAVEN => {
                let goal = args.pop();
                args.push(format!("-Dspring-boot.run.jvmArguments={jdwp}"));
                if let Some(goal) = goal {
                    args.push(goal);
                }
            }
            // Gradle 与被 fork 的测试 JVM 都不接受命令行透传，只能靠环境变量。
            // 每类只注入一处，避免同一个 JVM 收到两遍 agentlib。
            KIND_GRADLE_TASK => {
                env.insert("JAVA_TOOL_OPTIONS".to_string(), jdwp);
            }
            KIND_MAVEN_MODULE => {
                env.insert("MAVEN_OPTS".to_string(), jdwp);
            }
            KIND_JAVA_CURRENT_FILE => args.insert(0, jdwp),
            _ => {}
        }
        port = Some(resolved_port);
    }

    Ok(LaunchPlan {
        cwd: absolute_from(workspace, &configuration.cwd)
            .display()
            .to_string(),
        command,
        args,
        env,
        debug_port: port,
    })
}

/// `-Dtest=Class` 只在当前文件确实属于这条配置的模块时加：否则 Maven 会在
/// 别的模块里找不到测试类而直接失败。
fn apply_test_filter(
    workspace: &Path,
    configuration: &RunConfiguration,
    current_file: &str,
    args: &mut Vec<String>,
) {
    if !args.iter().any(|value| value == "test") {
        return;
    }
    let absolute = absolute_from(workspace, current_file);
    let Some(name) = absolute.file_name().and_then(|value| value.to_str()) else {
        return;
    };
    let Some(class) = name.strip_suffix(".java").filter(|value| !value.is_empty()) else {
        return;
    };
    let module_dir = absolute_from(workspace, &configuration.module);
    if !absolute.starts_with(&module_dir) {
        return;
    }
    let Some(position) = args.iter().position(|value| value == "test") else {
        return;
    };
    args.insert(position, format!("-Dtest={class}"));
}

fn absolute_from(workspace: &Path, value: &str) -> PathBuf {
    let path = Path::new(value);
    if path.is_absolute() {
        path.to_path_buf()
    } else if value == "." || value.is_empty() {
        workspace.to_path_buf()
    } else {
        workspace.join(path)
    }
}

fn free_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|error| format!("无法分配调试端口: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("无法分配调试端口: {error}"))?
        .port();
    // 端口在这个瞬间仍属于我们；JVM 随后接手。竞态窗口极小，且失败会在
    // 目标进程启动时报出可见错误，比固定 5005 撞端口更安全。
    drop(listener);
    Ok(port)
}

fn program_on_path(name: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|directory| {
        let candidate = directory.join(name);
        candidate.is_file()
            || (cfg!(windows) && directory.join(format!("{name}.exe")).is_file())
    })
}

fn detect_toolchains(workspace: &Path, fallback_java: Option<PathBuf>) -> Vec<ToolchainCandidate> {
    let mut candidates = Vec::new();
    let wrappers = [
        ("mvnw", TOOLCHAIN_MAVEN, vec!["-v"]),
        ("gradlew", TOOLCHAIN_GRADLE, vec!["--version"]),
    ];
    for (wrapper, kind, args) in wrappers {
        let path = workspace.join(wrapper);
        if !path.is_file() {
            continue;
        }
        if let Some(text) = run_probe(&path.display().to_string(), &args, workspace, TOOLCHAIN_TIMEOUT)
        {
            candidates.push(candidate(kind, &path.display().to_string(), &text));
        }
    }
    let path_tools = [
        (TOOLCHAIN_MAVEN, "mvn", vec!["-v"]),
        (TOOLCHAIN_GRADLE, "gradle", vec!["--version"]),
        (TOOLCHAIN_JAVA, "java", vec!["-version"]),
    ];
    for (kind, program, args) in path_tools {
        if !program_on_path(program) {
            continue;
        }
        if let Some(text) = run_probe(program, &args, workspace, TOOLCHAIN_TIMEOUT) {
            candidates.push(candidate(kind, program, &text));
        }
    }
    if !candidates.iter().any(|item| item.kind == TOOLCHAIN_JAVA) {
        if let Some(binary) = fallback_java {
            let path = binary.display().to_string();
            if let Some(text) = run_probe(&path, &["-version"], workspace, TOOLCHAIN_TIMEOUT) {
                candidates.push(candidate(TOOLCHAIN_JAVA, &path, &text));
            }
        }
    }
    candidates
}

fn candidate(kind: &str, path: &str, output: &str) -> ToolchainCandidate {
    ToolchainCandidate {
        id: format!("{kind}:{path}"),
        kind: kind.to_string(),
        path: path.to_string(),
        version: version_from_output(kind, output),
    }
}

/// 版本串按各工具自己的输出格式取：Maven/Gradle 打在 stdout，Java 打在 stderr。
fn version_from_output(kind: &str, output: &str) -> String {
    let patterns = match kind {
        TOOLCHAIN_JAVA => vec![r#"version "([^"]+)""#],
        TOOLCHAIN_GRADLE => vec![r"Gradle (\d+\.\d+(?:\.\d+)?)"],
        _ => vec![r"Apache Maven (\d+\.\d+(?:\.\d+)?)"],
    };
    for pattern in patterns {
        let expression = regex::Regex::new(pattern).expect("静态版本表达式恒有效");
        if let Some(captures) = expression.captures(output) {
            if let Some(value) = captures.get(1) {
                return value.as_str().to_string();
            }
        }
    }
    String::new()
}

/// 跑一个短命令并取回 stdout+stderr；超过时限直接杀掉，失败返回 None。
fn run_probe(program: &str, args: &[&str], cwd: &Path, limit: Duration) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
    let mut text = String::new();
    // 进程已退出，管道里的数据量有界，顺序读取不会互相阻塞
    child.stdout.take()?.read_to_string(&mut text).ok()?;
    if let Some(mut stderr) = child.stderr.take() {
        let mut extra = String::new();
        let _ = stderr.read_to_string(&mut extra);
        text.push_str(&extra);
    }
    Some(text)
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

    fn maven_spring_fixture(root: &Path) {
        write(
            &root.join("pom.xml"),
            r#"<project><artifactId>demo</artifactId><packaging>pom</packaging>
               <modules><module>app</module></modules></project>"#,
        );
        write(
            &root.join("app/pom.xml"),
            r#"<project><artifactId>app</artifactId>
               <build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build>
            </project>"#,
        );
        write(
            &root.join("app/src/main/java/App.java"),
            "class App {}",
        );
    }

    fn ids(result: &GenerateResult) -> Vec<&str> {
        result
            .configurations
            .iter()
            .map(|item| item.id.as_str())
            .collect()
    }

    #[test]
    fn generate_skips_aggregator_and_marks_spring_boot() {
        let dir = tempfile::tempdir().expect("临时目录");
        maven_spring_fixture(dir.path());
        let result = generate_run_configurations(dir.path());
        let ids = ids(&result);
        assert!(!ids.iter().any(|id| id.contains(":.")));
        assert!(ids.contains(&"spring-boot.maven:app"));
        assert!(ids.contains(&"maven.module:app:test"));
        assert!(result.diagnostics.is_empty());

        let run = result
            .configurations
            .iter()
            .find(|item| item.kind == KIND_SPRING_BOOT_MAVEN)
            .expect("spring-boot 配置");
        assert_eq!(run.args, vec!["-B", "-ntp", "-pl", "app", "spring-boot:run"]);
        assert_eq!(run.cwd, ".");
        assert_eq!(run.toolchain.as_deref(), Some(TOOLCHAIN_MAVEN));
        assert_eq!(run.confidence, CONFIDENCE_DECLARED);
    }

    #[test]
    fn generate_prefers_the_wrapper_when_it_is_executable() {
        let dir = tempfile::tempdir().expect("临时目录");
        maven_spring_fixture(dir.path());
        let wrapper = dir.path().join("mvnw");
        write(&wrapper, "#!/bin/sh\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).expect("权限");
        }
        let result = generate_run_configurations(dir.path());
        assert!(result
            .configurations
            .iter()
            .all(|item| item.command == "./mvnw"));
    }

    #[test]
    fn generate_falls_back_to_current_file_without_build_files() {
        let dir = tempfile::tempdir().expect("临时目录");
        write(&dir.path().join("Hello.java"), "class Hello {}");
        let result = generate_run_configurations(dir.path());
        assert_eq!(ids(&result), vec!["java.current-file:current"]);
        assert_eq!(result.configurations[0].args, Vec::<String>::new());
    }

    #[test]
    fn generate_maps_gradle_plugins_to_tasks() {
        let dir = tempfile::tempdir().expect("临时目录");
        write(
            &dir.path().join("settings.gradle.kts"),
            "include(\":app\")\n",
        );
        write(
            &dir.path().join("build.gradle.kts"),
            "plugins { id(\"org.springframework.boot\") }\n",
        );
        write(
            &dir.path().join("app/build.gradle.kts"),
            "plugins { id(\"io.quarkus\") }\n",
        );
        let result = generate_run_configurations(dir.path());
        let ids = ids(&result);
        assert!(ids.contains(&"gradle.task:.:test"));
        assert!(ids.contains(&"gradle.task::app:run"));
        let root_run = result
            .configurations
            .iter()
            .find(|item| item.id == "gradle.task:.:run")
            .expect("根项目 bootRun");
        assert_eq!(root_run.args, vec!["bootRun"]);
        let sub_run = result
            .configurations
            .iter()
            .find(|item| item.id == "gradle.task::app:run")
            .expect("子项目 quarkusDev");
        assert_eq!(sub_run.args, vec![":app:quarkusDev"]);
        assert_eq!(sub_run.cwd, "app");
    }

    #[test]
    fn resolve_applies_project_layer_overrides() {
        let dir = tempfile::tempdir().expect("临时目录");
        maven_spring_fixture(dir.path());
        write(
            &dir.path().join(PROJECT_LAYER),
            r#"{"version":1,"configurations":[{"id":"maven.module:app:test","args":["-B","-pl","app","verify"]}]}"#,
        );
        let candidates = vec![ToolchainCandidate {
            id: "maven:mvn".to_string(),
            kind: TOOLCHAIN_MAVEN.to_string(),
            path: "mvn".to_string(),
            version: "3.9.6".to_string(),
        }];
        let result = resolve(dir.path(), &candidates, None).expect("解析成功");
        let test = result
            .effective
            .iter()
            .find(|item| item.id == "maven.module:app:test")
            .expect("test 配置");
        assert_eq!(test.args, vec!["-B", "-pl", "app", "verify"]);
        // 覆盖只改 args：未写的字段必须保住生成层的值
        assert_eq!(test.command, "mvn");
        assert_eq!(test.kind, KIND_MAVEN_MODULE);
        assert!(result.diagnostics.is_empty());
    }

    #[test]
    fn resolve_reports_missing_toolchain_and_unknown_ids() {
        let dir = tempfile::tempdir().expect("临时目录");
        maven_spring_fixture(dir.path());
        let local = serde_json::json!({
            "configurations": [{ "id": "maven.module:app:ghost", "label": "ghost" }]
        });
        let result = resolve(dir.path(), &[], Some(&local)).expect("解析成功");
        assert!(result
            .diagnostics
            .iter()
            .any(|item| item.message.contains("不在生成结果中")));
        assert!(result
            .diagnostics
            .iter()
            .any(|item| item.message.contains("未检测到 maven 工具链")));
    }

    #[test]
    fn resolve_accepts_matching_toolchain_candidates() {
        let dir = tempfile::tempdir().expect("临时目录");
        maven_spring_fixture(dir.path());
        let candidates = vec![ToolchainCandidate {
            id: "maven:mvn".to_string(),
            kind: TOOLCHAIN_MAVEN.to_string(),
            path: "mvn".to_string(),
            version: "3.9.6".to_string(),
        }];
        let result = resolve(dir.path(), &candidates, None).expect("解析成功");
        assert!(!result
            .diagnostics
            .iter()
            .any(|item| item.message.contains("未检测到 maven")));
    }

    #[test]
    fn launch_plan_rejects_aggregator_modules() {
        let dir = tempfile::tempdir().expect("临时目录");
        maven_spring_fixture(dir.path());
        // app 不是聚合器：正常出计划，缺的只是命令行里的 mvn
        assert!(launch_plan(
            dir.path(),
            "maven.module:app:test",
            None,
            false,
            None,
            None
        )
        .is_ok());

        // 项目层把配置改挂到聚合根上：启动前必须拦住，而不是跑出一个空构件
        write(
            &dir.path().join(PROJECT_LAYER),
            &serde_json::json!({
                "configurations": [{
                    "id": "maven.module:app:test",
                    "kind": KIND_MAVEN_MODULE,
                    "module": ".",
                }]
            })
            .to_string(),
        );
        let error = launch_plan(
            dir.path(),
            "maven.module:app:test",
            None,
            false,
            None,
            None,
        )
        .expect_err("聚合模块必须被拦住");
        assert_eq!(error, "聚合模块不可直接运行，请选择子模块");
    }

    #[test]
    fn launch_plan_injects_jdwp_once_per_kind() {
        let dir = tempfile::tempdir().expect("临时目录");
        maven_spring_fixture(dir.path());
        let plan = launch_plan(
            dir.path(),
            "spring-boot.maven:app",
            None,
            true,
            Some(5005),
            None,
        )
        .expect("调试计划");
        assert_eq!(plan.debug_port, Some(5005));
        assert_eq!(
            plan.args,
            vec![
                "-B",
                "-ntp",
                "-pl",
                "app",
                "-Dspring-boot.run.jvmArguments=-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:5005",
                "spring-boot:run"
            ]
        );
        assert!(!plan.env.values().any(|value| value.contains("jdwp")));

        let plan = launch_plan(
            dir.path(),
            "maven.module:app:test",
            None,
            true,
            Some(5006),
            None,
        )
        .expect("调试计划");
        assert_eq!(
            plan.env.get("MAVEN_OPTS").map(String::as_str),
            Some("-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:5006")
        );
        assert!(!plan.args.iter().any(|value| value.contains("jdwp")));
    }

    #[test]
    fn launch_plan_filters_tests_for_the_file_own_module() {
        let dir = tempfile::tempdir().expect("临时目录");
        maven_spring_fixture(dir.path());
        write(
            &dir.path().join("app/src/test/java/HelloTest.java"),
            "class HelloTest {}",
        );
        write(&dir.path().join("Other.java"), "class Other {}");
        let plan = launch_plan(
            dir.path(),
            "maven.module:app:test",
            Some("app/src/test/java/HelloTest.java"),
            false,
            None,
            None,
        )
        .expect("运行计划");
        assert_eq!(
            plan.args,
            vec!["-B", "-ntp", "-pl", "app", "-Dtest=HelloTest", "test"]
        );

        let plan = launch_plan(
            dir.path(),
            "maven.module:app:test",
            Some("Other.java"),
            false,
            None,
            None,
        )
        .expect("运行计划");
        assert_eq!(plan.args, vec!["-B", "-ntp", "-pl", "app", "test"]);
    }

    #[test]
    fn launch_plan_runs_the_current_file_with_an_absolute_path() {
        let dir = tempfile::tempdir().expect("临时目录");
        write(&dir.path().join("Hello.java"), "class Hello {}");
        let plan = launch_plan(
            dir.path(),
            "java.current-file:current",
            Some("Hello.java"),
            false,
            None,
            None,
        )
        .expect("运行计划");
        assert_eq!(
            plan.cwd,
            dir.path().canonicalize().expect("归一化").display().to_string()
        );
        assert_eq!(plan.args.len(), 1);
        assert!(plan.args[0].ends_with("Hello.java"));
        assert!(Path::new(&plan.args[0]).is_absolute());

        let error = launch_plan(
            dir.path(),
            "java.current-file:current",
            None,
            false,
            None,
            None,
        )
        .expect_err("缺当前文件必须报错");
        assert_eq!(error, "请先打开一个 Java 文件");
    }

    #[test]
    fn launch_plan_reports_unknown_configuration() {
        let dir = tempfile::tempdir().expect("临时目录");
        maven_spring_fixture(dir.path());
        let error = launch_plan(dir.path(), "nope", None, false, None, None)
            .expect_err("未知配置必须报错");
        assert_eq!(error, "找不到运行配置: nope");
    }

    #[test]
    fn free_port_binds_and_releases() {
        let port = free_port().expect("端口");
        assert!(port > 0);
        // 释放之后必须能重新绑定，否则说明监听器泄漏
        let listener = TcpListener::bind(("127.0.0.1", port)).expect("重新绑定");
        drop(listener);
    }

    #[test]
    fn versions_are_parsed_from_each_tool_output() {
        assert_eq!(
            version_from_output(
                TOOLCHAIN_MAVEN,
                "Apache Maven 3.9.6 (bc0240f3c744dd6b6ec2920b3cd08dcc295161ae)"
            ),
            "3.9.6"
        );
        assert_eq!(
            version_from_output(TOOLCHAIN_GRADLE, "\nGradle 8.7\n"),
            "8.7"
        );
        assert_eq!(
            version_from_output(
                TOOLCHAIN_JAVA,
                "openjdk version \"21.0.2\" 2024-01-16\nOpenJDK Runtime Environment"
            ),
            "21.0.2"
        );
        assert_eq!(version_from_output(TOOLCHAIN_MAVEN, "garbage"), "");
    }

    #[test]
    fn kind_literals_stay_closed() {
        assert_eq!(KINDS.len(), 4);
        let dir = tempfile::tempdir().expect("临时目录");
        maven_spring_fixture(dir.path());
        let result = generate_run_configurations(dir.path());
        assert!(result
            .configurations
            .iter()
            .all(|item| KINDS.contains(&item.kind.as_str())));
    }
}
