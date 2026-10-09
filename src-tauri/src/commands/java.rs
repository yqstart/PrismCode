//! Java 运行时定位与 JDTLS 启动计划。进程与文件 IO 放在 blocking 线程。

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};

const JDTLS_VERSION: &str = "1.61.0";
const JDTLS_DIR_NAME: &str = "jdtls";
const JRE_DIR_NAME: &str = "jre";
const JAVA_CACHE_DIR: &str = "java";
const JDT_WORKSPACE_RETENTION_DAYS: u64 = 30;
const JAVA_HEAP_CLAMP: (u32, u32) = (512, 4096);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaRuntimeInfo {
    pub jre_home: String,
    pub java_bin: String,
    pub java_version: String,
    pub jdtls_root: String,
    pub jdtls_version: String,
    pub lombok: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaLaunchPlan {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub data_dir: String,
    pub config_dir: String,
    pub env: HashMap<String, String>,
    pub workspace_key: String,
}

struct ResolvedRuntime {
    info: JavaRuntimeInfo,
    launcher_jar: PathBuf,
    config_source: PathBuf,
    lombok_jar: Option<PathBuf>,
}

pub fn normalize_workspace_identity(root: &Path) -> String {
    let raw = root.to_string_lossy().replace('\\', "/");
    let (drive, rest) = if raw.len() >= 2 && raw.as_bytes().get(1) == Some(&b':') {
        (raw[..2].to_ascii_lowercase(), raw[2..].to_string())
    } else {
        (String::new(), raw)
    };
    let absolute = rest.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            if parts.pop().is_none() && !absolute {
                parts.push("..");
            }
            continue;
        }
        parts.push(part);
    }
    let mut out = String::new();
    if !drive.is_empty() {
        out.push_str(&drive);
    }
    if absolute || !drive.is_empty() {
        out.push('/');
    }
    out.push_str(&parts.join("/"));
    while out.len() > 1 && out.ends_with('/') {
        out.pop();
    }
    if out.is_empty() { "/".into() } else { out }
}

pub fn workspace_key(root: &Path) -> String {
    let identity = normalize_workspace_identity(root);
    let mut hasher = Sha256::new();
    hasher.update(identity.as_bytes());
    hasher.update([0u8]);
    hasher.update(JDTLS_VERSION.as_bytes());
    hex_encode(&hasher.finalize())
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0xf) as usize] as char);
    }
    out
}

pub fn platform_config_dir() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "config_mac_arm"
    }
    #[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
    {
        "config_mac"
    }
    #[cfg(target_os = "linux")]
    {
        "config_linux"
    }
    #[cfg(target_os = "windows")]
    {
        "config_win"
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        "config_linux"
    }
}

pub fn clamp_heap_mb(value: u32) -> u32 {
    value.clamp(JAVA_HEAP_CLAMP.0, JAVA_HEAP_CLAMP.1)
}

pub fn build_jdtls_args(
    _jre: &Path,
    lombok: Option<&Path>,
    launcher_jar: &Path,
    config_dir: &Path,
    data_dir: &Path,
    heap_mb: u32,
) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(jar) = lombok {
        args.push(format!("-javaagent:{}", jar.display()));
    }
    let heap = clamp_heap_mb(heap_mb);
    args.extend([
        "-Xms256m".to_string(),
        format!("-Xmx{heap}m"),
        "-XX:MaxMetaspaceSize=512m".to_string(),
        "-Dfile.encoding=UTF-8".to_string(),
        "--add-modules=ALL-SYSTEM".to_string(),
        "--add-opens=java.base/java.util=ALL-UNNAMED".to_string(),
        "--add-opens=java.base/java.lang=ALL-UNNAMED".to_string(),
        "-Declipse.application=org.eclipse.jdt.ls.core.id1".to_string(),
        "-Declipse.product=org.eclipse.jdt.ls.core.product".to_string(),
        "-Dosgi.bundles.defaultStartLevel=4".to_string(),
        "-Dlog.level=WARNING".to_string(),
        "-jar".to_string(),
        launcher_jar.display().to_string(),
        "-configuration".to_string(),
        config_dir.display().to_string(),
        "-data".to_string(),
        data_dir.display().to_string(),
    ]);
    args
}

pub fn select_stale_workspace_dirs(
    entries: &[(String, SystemTime)],
    now: SystemTime,
    days: u64,
) -> Vec<String> {
    let limit = Duration::from_secs(days.saturating_mul(24 * 60 * 60));
    entries
        .iter()
        .filter_map(|(name, modified)| {
            let age = now.duration_since(*modified).ok()?;
            if age > limit { Some(name.clone()) } else { None }
        })
        .collect()
}

fn resource_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(dir) = std::env::var_os("PRISMCODE_JAVA_ROOT") {
        roots.push(PathBuf::from(dir));
    }
    if let Ok(dir) = app.path().resource_dir() {
        roots.push(dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
            if let Some(resources) = dir.parent().map(|parent| parent.join("Resources")) {
                roots.push(resources);
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.join(".artifacts"));
        roots.push(cwd);
    }
    roots
}

fn java_binary(jre: &Path) -> PathBuf {
    if cfg!(windows) {
        jre.join("bin").join("java.exe")
    } else {
        jre.join("bin").join("java")
    }
}

fn find_launcher(plugins: &Path) -> Option<PathBuf> {
    let mut jars = fs::read_dir(plugins).ok()?.filter_map(|entry| {
        let path = entry.ok()?.path();
        let name = path.file_name()?.to_string_lossy().to_string();
        if name.starts_with("org.eclipse.equinox.launcher_") && name.ends_with(".jar") {
            Some(path)
        } else {
            None
        }
    }).collect::<Vec<_>>();
    jars.sort();
    jars.into_iter().next()
}

fn locate_jdtls(roots: &[PathBuf], override_path: Option<&str>) -> Result<(PathBuf, PathBuf, PathBuf, Option<PathBuf>), String> {
    let mut candidates = Vec::new();
    if let Some(path) = override_path.map(str::trim).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(path);
        candidates.push(path.join(JDTLS_VERSION));
        candidates.push(path);
    }
    for root in roots {
        candidates.push(root.join(JDTLS_DIR_NAME).join(JDTLS_VERSION));
        candidates.push(root.join(JDTLS_DIR_NAME));
        candidates.push(root.join(".artifacts").join(JDTLS_DIR_NAME).join(JDTLS_VERSION));
    }
    let mut tried = Vec::new();
    for candidate in candidates {
        tried.push(candidate.display().to_string());
        let launcher = find_launcher(&candidate.join("plugins"));
        let config = candidate.join(platform_config_dir());
        if launcher.is_some() && config.is_dir() {
            let lombok = candidate.join("lombok").join("lombok.jar");
            let lombok = lombok.is_file().then_some(lombok);
            return Ok((candidate, launcher.expect("launcher"), config, lombok));
        }
    }
    Err(format!("jdtls-missing: 未找到 JDTLS {}", tried.join(" | ")))
}

fn locate_jre(roots: &[PathBuf], override_path: Option<&str>) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(path) = override_path.map(str::trim).filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(path));
    }
    for root in roots {
        candidates.push(root.join(JRE_DIR_NAME));
    }
    if let Some(home) = std::env::var_os("PRISMCODE_JRE_HOME") {
        candidates.push(PathBuf::from(home));
    }
    let mut tried = Vec::new();
    for candidate in candidates {
        tried.push(candidate.display().to_string());
        if java_binary(&candidate).is_file() {
            return Ok(candidate);
        }
    }
    Err(format!("jre-missing: 未找到 Java 运行时 {}", tried.join(" | ")))
}

fn cached_java_version(java_bin: &Path) -> Result<String, String> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = java_bin.display().to_string();
    if let Ok(guard) = cache.lock() {
        if let Some(version) = guard.get(&key) {
            return Ok(version.clone());
        }
    }
    let output = Command::new(java_bin)
        .arg("-version")
        .output()
        .map_err(|_| "jre-invalid: 无法执行 java".to_string())?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let text = if stderr.contains("version \"") { stderr } else { stdout };
    let version = text
        .split("version \"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "jre-invalid: 无法执行 java".to_string())?
        .to_string();
    if let Ok(mut guard) = cache.lock() {
        guard.insert(key, version.clone());
    }
    Ok(version)
}

fn resolve_runtime(
    app: &AppHandle,
    jre_path: Option<&str>,
    jdtls_path: Option<&str>,
) -> Result<ResolvedRuntime, String> {
    let roots = resource_roots(app);
    let (jdtls_root, launcher_jar, config_source, lombok_jar) = locate_jdtls(&roots, jdtls_path)?;
    let jre_home = locate_jre(&roots, jre_path)?;
    let java_bin = java_binary(&jre_home);
    let java_version = cached_java_version(&java_bin)?;
    Ok(ResolvedRuntime {
        info: JavaRuntimeInfo {
            jre_home: jre_home.display().to_string(),
            java_bin: java_bin.display().to_string(),
            java_version,
            jdtls_root: jdtls_root.display().to_string(),
            jdtls_version: JDTLS_VERSION.to_string(),
            lombok: lombok_jar.is_some(),
        },
        launcher_jar,
        config_source,
        lombok_jar,
    })
}

/// 随包分发的 JRE 里的 java 可执行文件。运行配置在 PATH 上没有 java 时用它兜底；
/// 找不到返回 None，由调用方决定是报诊断还是换方案。
pub fn bundled_java_binary(app: &AppHandle, override_path: Option<&str>) -> Option<PathBuf> {
    let roots = resource_roots(app);
    let home = locate_jre(&roots, override_path).ok()?;
    let binary = java_binary(&home);
    binary.is_file().then_some(binary)
}

fn prism_java_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "无法定位用户主目录".to_string())?;
    Ok(PathBuf::from(home).join(".prismcode").join(JAVA_CACHE_DIR))
}

fn copy_dir_all(source: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|error| format!("无法创建目录 {}: {error}", dest.display()))?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let target = dest.join(entry.file_name());
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target).map_err(|error| {
                format!("无法复制 {}: {error}", entry.path().display())
            })?;
        }
    }
    Ok(())
}

fn ensure_config_copy(source: &Path, dest: &Path) -> Result<(), String> {
    let same = fs::read(source.join("config.ini"))
        .ok()
        .zip(fs::read(dest.join("config.ini")).ok())
        .is_some_and(|(left, right)| left == right);
    if dest.is_dir() && same {
        return Ok(());
    }
    if dest.exists() {
        fs::remove_dir_all(dest).map_err(|error| format!("无法重置 Java 配置目录: {error}"))?;
    }
    copy_dir_all(source, dest)
}

fn prune_stale_workspaces(root: &Path) {
    static PRUNED: OnceLock<()> = OnceLock::new();
    if PRUNED.get().is_some() {
        return;
    }
    let data = root.join("data");
    let entries = match fs::read_dir(&data) {
        Ok(entries) => entries,
        Err(_) => {
            let _ = PRUNED.set(());
            return;
        }
    };
    let mut stamps = Vec::new();
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else { continue };
        if !metadata.is_dir() {
            continue;
        }
        let Ok(modified) = metadata.modified() else { continue };
        stamps.push((entry.file_name().to_string_lossy().to_string(), modified));
    }
    let stale = select_stale_workspace_dirs(&stamps, SystemTime::now(), JDT_WORKSPACE_RETENTION_DAYS);
    for name in stale {
        let data_dir = data.join(&name);
        let config_dir = root.join("config").join(&name);
        if let Err(error) = fs::remove_dir_all(&data_dir) {
            eprintln!("清理过期 Java 索引失败 {}: {error}", data_dir.display());
        }
        if config_dir.exists() {
            if let Err(error) = fs::remove_dir_all(&config_dir) {
                eprintln!("清理过期 Java 配置失败 {}: {error}", config_dir.display());
            }
        }
    }
    let _ = PRUNED.set(());
}

fn launch_env(jre_home: &Path) -> HashMap<String, String> {
    let bin = jre_home.join("bin");
    let old_path = std::env::var("PATH").unwrap_or_default();
    let path = if cfg!(windows) {
        format!("{};{old_path}", bin.display())
    } else {
        format!("{}:{old_path}", bin.display())
    };
    HashMap::from([
        ("JAVA_HOME".into(), jre_home.display().to_string()),
        ("PATH".into(), path),
        ("JAVA_TOOL_OPTIONS".into(), String::new()),
    ])
}

fn workspace_dirs(root: &Path) -> Result<(String, PathBuf, PathBuf), String> {
    let key = workspace_key(root);
    let base = prism_java_root()?;
    let data_dir = base.join("data").join(&key);
    let config_dir = base.join("config").join(&key);
    Ok((key, data_dir, config_dir))
}

#[tauri::command]
pub async fn java_probe_runtime(
    app: AppHandle,
    jre_path: Option<String>,
    jdtls_path: Option<String>,
) -> Result<JavaRuntimeInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        resolve_runtime(&app, jre_path.as_deref(), jdtls_path.as_deref()).map(|runtime| runtime.info)
    })
    .await
    .map_err(|error| format!("检测 Java 运行时失败: {error}"))?
}

#[tauri::command]
pub async fn java_launch_plan(
    app: AppHandle,
    root: String,
    heap_mb: u32,
    jre_path: Option<String>,
    jdtls_path: Option<String>,
) -> Result<JavaLaunchPlan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = resolve_runtime(&app, jre_path.as_deref(), jdtls_path.as_deref())?;
        let workspace = PathBuf::from(&root);
        let (workspace_key, data_dir, config_dir) = workspace_dirs(&workspace)?;
        if let Ok(base) = prism_java_root() {
            prune_stale_workspaces(&base);
        }
        fs::create_dir_all(&data_dir).map_err(|error| format!("无法创建 Java 索引目录: {error}"))?;
        ensure_config_copy(&runtime.config_source, &config_dir)?;
        let jre_home = PathBuf::from(&runtime.info.jre_home);
        Ok(JavaLaunchPlan {
            program: runtime.info.java_bin.clone(),
            args: build_jdtls_args(
                &jre_home,
                runtime.lombok_jar.as_deref(),
                &runtime.launcher_jar,
                &config_dir,
                &data_dir,
                heap_mb,
            ),
            cwd: root,
            data_dir: data_dir.display().to_string(),
            config_dir: config_dir.display().to_string(),
            env: launch_env(&jre_home),
            workspace_key,
        })
    })
    .await
    .map_err(|error| format!("准备 Java 启动计划失败: {error}"))?
}

#[tauri::command]
pub async fn java_rebuild_index(
    _app: AppHandle,
    root: String,
    _jre_path: Option<String>,
    _jdtls_path: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_key, data_dir, config_dir) = workspace_dirs(&PathBuf::from(root))?;
        if data_dir.exists() {
            fs::remove_dir_all(&data_dir).map_err(|error| format!("无法删除 Java 索引: {error}"))?;
        }
        if config_dir.exists() {
            fs::remove_dir_all(&config_dir).map_err(|error| format!("无法删除 Java 配置: {error}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("重建 Java 索引失败: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heap_is_clamped() {
        assert_eq!(clamp_heap_mb(0), 512);
        assert_eq!(clamp_heap_mb(512), 512);
        assert_eq!(clamp_heap_mb(1024), 1024);
        assert_eq!(clamp_heap_mb(4096), 4096);
        assert_eq!(clamp_heap_mb(8192), 4096);
    }

    #[test]
    fn jdtls_args_keep_order_and_single_heap() {
        let jre = Path::new("/runtime/jre");
        let launcher = Path::new("/jdtls/plugins/org.eclipse.equinox.launcher_1.jar");
        let config = Path::new("/config");
        let data = Path::new("/data");
        let with_lombok = build_jdtls_args(
            jre,
            Some(Path::new("/jdtls/lombok/lombok.jar")),
            launcher,
            config,
            data,
            8192,
        );
        assert!(with_lombok[0].starts_with("-javaagent:"));
        assert_eq!(with_lombok.iter().filter(|arg| arg.starts_with("-Xmx")).count(), 1);
        assert!(with_lombok.iter().any(|arg| arg == "-Xmx4096m"));
        assert!(with_lombok.iter().any(|arg| arg == "-Xms256m"));
        assert!(with_lombok.iter().any(|arg| arg == "-Dlog.level=WARNING"));
        assert_eq!(with_lombok[with_lombok.len() - 2], "-data");

        let plain = build_jdtls_args(jre, None, launcher, config, data, 1024);
        assert_eq!(plain[0], "-Xms256m");
        assert!(plain.iter().any(|arg| arg == "-Xmx1024m"));
        assert!(!plain.iter().any(|arg| arg.starts_with("-javaagent:")));
    }

    #[test]
    fn workspace_key_is_stable_across_spellings() {
        let key = workspace_key(Path::new("/a/b/"));
        assert_eq!(key, workspace_key(Path::new("/a/./b")));
        assert_eq!(key, workspace_key(Path::new("/a/../a/b")));
        assert_eq!(workspace_key(Path::new(r"C:\a\b")), workspace_key(Path::new("c:/a/b")));
        assert_eq!(key.len(), 64);
        assert!(key.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    #[test]
    fn stale_dirs_keep_the_exact_retention_boundary() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(100 * 86400);
        let exact = now - Duration::from_secs(30 * 86400);
        let older = now - Duration::from_secs(31 * 86400);
        let fresh = now - Duration::from_secs(29 * 86400);
        let stale = select_stale_workspace_dirs(
            &[
                ("exact".into(), exact),
                ("older".into(), older),
                ("fresh".into(), fresh),
            ],
            now,
            30,
        );
        assert_eq!(stale, vec!["older".to_string()]);
    }

    #[test]
    fn platform_config_matches_host() {
        let name = platform_config_dir();
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        assert_eq!(name, "config_mac_arm");
        #[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
        assert_eq!(name, "config_mac");
        #[cfg(target_os = "linux")]
        assert_eq!(name, "config_linux");
        #[cfg(target_os = "windows")]
        assert_eq!(name, "config_win");
    }
}
