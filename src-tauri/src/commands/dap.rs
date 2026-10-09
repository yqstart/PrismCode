//! DAP 宿主：把 java-debug 插件开出的 TCP 端口包成会话。
//!
//! java-debug 不是可执行 jar（无 Main-Class，也不支持 `--stdio`）：它由 jdt.ls 通过
//! `initializationOptions.bundles` 装载，客户端发 `vscode.java.startDebugSession`
//! 拿到一个 ServerSocket 端口，再在该 socket 上跑标准 Content-Length 帧的 DAP。
//! 因此这里的会话持有的是 TCP 连接而不是子进程，帧编解码仍复用 `commands::lsp`。

use crate::commands::lsp::{frame_message, emit_session_exit, FrameParser};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const DAP_READ_BUF_BYTES: usize = 32 * 1024;
const DAP_LOG_LINES: usize = 200;
const DAP_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

struct DapSession {
    window: String,
    /// 写半区。读半区在后台线程里，用 try_clone 拿到的另一个句柄。
    writer: Arc<Mutex<Option<TcpStream>>>,
    closed: Arc<AtomicBool>,
    log: Arc<Mutex<VecDeque<String>>>,
}

#[derive(Default)]
pub struct DapState {
    sessions: Mutex<HashMap<String, DapSession>>,
}

impl DapState {
    /// 结束会话：关掉连接并从表里移除。会话不存在时直接成功。
    pub fn stop_session(&self, session_id: &str) -> Result<(), String> {
        let session = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|error| format!("调试会话锁失败: {error}"))?;
            sessions.remove(session_id)
        };
        let Some(session) = session else {
            return Ok(());
        };
        session.closed.store(true, Ordering::SeqCst);
        if let Ok(mut writer) = session.writer.lock() {
            if let Some(stream) = writer.take() {
                let _ = stream.shutdown(Shutdown::Both);
            }
        }
        Ok(())
    }

    fn stop_matching(&self, predicate: impl Fn(&str) -> bool) {
        let ids: Vec<String> = self
            .sessions
            .lock()
            .map(|sessions| {
                sessions
                    .iter()
                    .filter(|(_, session)| predicate(&session.window))
                    .map(|(id, _)| id.clone())
                    .collect()
            })
            .unwrap_or_default();
        for id in ids {
            let _ = self.stop_session(&id);
        }
    }

    fn session_id_for_window(&self, window: &str) -> Option<String> {
        let sessions = self.sessions.lock().ok()?;
        sessions
            .iter()
            .find(|(_, session)| session.window == window)
            .map(|(id, _)| id.clone())
    }
}

fn session_id(window: &str) -> String {
    format!("dap:{window}")
}

fn push_log(log: &Mutex<VecDeque<String>>, line: impl Into<String>) {
    if let Ok(mut lines) = log.lock() {
        if lines.len() >= DAP_LOG_LINES {
            lines.pop_front();
        }
        lines.push_back(line.into());
    }
}

/// 随包分发的调试适配器：jar 与它的版本信息
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DapAdapter {
    /// 插件 jar 绝对路径，交给 jdt.ls 的 `initializationOptions.bundles`
    pub jar_path: String,
    pub version: String,
    pub root: String,
}

/// `adapter.json` 由 `scripts/prepare-debug-adapter.mjs` 写在 jar 旁边
#[derive(Debug, serde::Deserialize)]
struct AdapterDescriptor {
    version: String,
    jar: String,
}

/// 定位随包分发的调试适配器 jar：
/// 1. `PRISMCODE_JAVA_DEBUG_JAR` 直接指向 jar（开发/救急覆盖）
/// 2. `PRISMCODE_JAVA_DEBUG_HOME` 指向包含 `adapter.json` 的目录
/// 3. 资源目录与开发期 `.artifacts` 下的 `debug-adapter[/<version>]`
///
/// 找不到返回 `None`（缺包不是故障，由前端给中文指引）。
#[tauri::command]
pub async fn dap_probe_adapter(
    app: AppHandle,
    adapter_path: Option<String>,
) -> Result<Option<DapAdapter>, String> {
    let handle =
        tauri::async_runtime::spawn_blocking(move || locate_adapter(&app, adapter_path.as_deref()));
    match tokio::time::timeout(Duration::from_secs(5), handle).await {
        Ok(joined) => joined.map_err(|error| format!("定位调试适配器失败: {error}")),
        Err(_) => Err("定位调试适配器超时".to_string()),
    }
}

fn locate_adapter(app: &AppHandle, adapter_path: Option<&str>) -> Option<DapAdapter> {
    // 设置面板里的显式路径优先，其次环境变量，最后随包资源
    if let Some(adapter) = adapter_path.and_then(adapter_from_override) {
        return Some(adapter);
    }
    if let Some(path) = std::env::var_os("PRISMCODE_JAVA_DEBUG_JAR") {
        let jar = PathBuf::from(path);
        if jar.is_file() {
            return Some(DapAdapter {
                version: String::new(),
                root: jar
                    .parent()
                    .map(|parent| parent.display().to_string())
                    .unwrap_or_default(),
                jar_path: jar.display().to_string(),
            });
        }
    }
    adapter_roots(app)
        .iter()
        .find_map(|root| descriptor_at(root))
}

/// 用户显式给的路径：既可以直接指向插件 jar，也可以指向含 `adapter.json` 的目录。
/// 纯函数，便于单测；路径不存在或目录里没有描述时返回 None，交给后面的兜底。
pub fn adapter_from_override(value: &str) -> Option<DapAdapter> {
    let path = PathBuf::from(value.trim());
    if path.is_file() {
        return Some(DapAdapter {
            jar_path: path.display().to_string(),
            version: String::new(),
            root: path
                .parent()
                .map(|parent| parent.display().to_string())
                .unwrap_or_default(),
        });
    }
    if !path.is_dir() {
        return None;
    }
    descriptor_at(&path)
}

/// 读目录里的 `adapter.json` 拼出适配器描述
fn descriptor_at(directory: &Path) -> Option<DapAdapter> {
    let text = std::fs::read_to_string(directory.join("adapter.json")).ok()?;
    let descriptor: AdapterDescriptor = serde_json::from_str(&text).ok()?;
    let jar = directory.join(&descriptor.jar);
    jar.is_file().then(|| DapAdapter {
        jar_path: jar.display().to_string(),
        version: descriptor.version,
        root: directory.display().to_string(),
    })
}

/// 候选目录：环境变量覆盖 → 资源目录 → 开发期 `.artifacts`，每处都含版本号子目录
fn adapter_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(override_path) = std::env::var_os("PRISMCODE_JAVA_DEBUG_HOME") {
        roots.push(PathBuf::from(override_path));
    }
    let mut bases: Vec<PathBuf> = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        bases.push(resource);
    }
    if let Ok(cwd) = std::env::current_dir() {
        bases.push(cwd);
    }
    for base in bases {
        for name in ["debug-adapter", "debug_adapter"] {
            push_adapter_dir(&mut roots, base.join(name));
            push_adapter_dir(&mut roots, base.join(".artifacts").join(name));
        }
    }
    roots
}

/// 目录本身与其下的一层版本目录都算候选，顺序稳定（版本目录按名字排序）
fn push_adapter_dir(roots: &mut Vec<PathBuf>, directory: PathBuf) {
    if !directory.is_dir() {
        return;
    }
    roots.push(directory.clone());
    let Ok(entries) = std::fs::read_dir(&directory) else {
        return;
    };
    let mut children: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| entry.path())
        .collect();
    children.sort();
    roots.extend(children);
}

/// 连上 java-debug 的 DAP 端口。返回会话 ID；一个窗口同时只允许一个调试会话。
#[tauri::command]
pub async fn dap_connect(
    window: tauri::WebviewWindow,
    state: State<'_, DapState>,
    port: u16,
) -> Result<String, String> {
    let window_label = window.label().to_string();
    let id = session_id(&window_label);
    // 会话 ID 由窗口 label 派生，「同一窗口只有一个会话」是结构保证的
    if let Some(existing) = state.session_id_for_window(&window_label) {
        return Err(format!("当前窗口已有调试会话（{existing}），请先停止"));
    }

    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let stream = TcpStream::connect_timeout(&address, DAP_CONNECT_TIMEOUT)
        .map_err(|error| format!("连接调试端口 {port} 失败: {error}"))?;
    let _ = stream.set_nodelay(true);
    let reader = stream
        .try_clone()
        .map_err(|error| format!("复制调试连接失败: {error}"))?;

    let writer = Arc::new(Mutex::new(Some(stream)));
    let closed = Arc::new(AtomicBool::new(false));
    let log = Arc::new(Mutex::new(VecDeque::with_capacity(DAP_LOG_LINES)));
    let app = window.app_handle().clone();
    push_log(&log, format!("已连接调试适配器 127.0.0.1:{port}"));
    let _ = app.emit_to(&window_label, &format!("dap://notice/{id}"), format!("已连接调试适配器 127.0.0.1:{port}"));

    state
        .sessions
        .lock()
        .map_err(|error| format!("调试会话锁失败: {error}"))?
        .insert(
            id.clone(),
            DapSession {
                window: window_label.clone(),
                writer: Arc::clone(&writer),
                closed: Arc::clone(&closed),
                log: Arc::clone(&log),
            },
        );

    {
        let app = app.clone();
        let window_label = window_label.clone();
        let id = id.clone();
        let closed = Arc::clone(&closed);
        let log = Arc::clone(&log);
        std::thread::spawn(move || {
            let mut parser = FrameParser::new();
            let mut buf = vec![0u8; DAP_READ_BUF_BYTES];
            let mut reader = reader;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(size) => match parser.push(&buf[..size]) {
                        Ok(frames) => {
                            for frame in frames {
                                let _ = app.emit_to(
                                    &window_label,
                                    &format!("dap://message/{id}"),
                                    frame,
                                );
                            }
                        }
                        Err(error) => {
                            push_log(&log, error.clone());
                            let _ = app.emit_to(&window_label, &format!("dap://notice/{id}"), error);
                        }
                    },
                }
            }
            // 连接断开等价于会话结束：调试目标由适配器在 disconnect 时收尾，
            // 这里只负责把界面切回「已停止」
            closed.store(true, Ordering::SeqCst);
            emit_session_exit(
                &app,
                &window_label,
                &format!("dap://exit/{id}"),
                None,
                &AtomicBool::new(false),
            );
            if let Some(state) = app.try_state::<DapState>() {
                if let Ok(mut sessions) = state.sessions.lock() {
                    sessions.remove(&id);
                }
            }
        });
    }

    Ok(id)
}

#[tauri::command]
pub async fn dap_send(
    state: State<'_, DapState>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    let stream = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|error| format!("调试会话锁失败: {error}"))?;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("调试会话不存在: {session_id}"))?;
        let writer = session
            .writer
            .lock()
            .map_err(|error| format!("调试会话锁失败: {error}"))?;
        writer
            .as_ref()
            .ok_or_else(|| format!("调试会话不存在: {session_id}"))?
            .try_clone()
            .map_err(|error| format!("复制调试连接失败: {error}"))?
    };
    let mut stream = stream;
    stream
        .write_all(&frame_message(&message))
        .and_then(|_| stream.flush())
        .map_err(|error| format!("写入调试适配器失败: {error}"))
}

#[tauri::command]
pub async fn dap_stop(state: State<'_, DapState>, session_id: String) -> Result<(), String> {
    state.stop_session(&session_id)
}

#[tauri::command]
pub async fn dap_logs(state: State<'_, DapState>, session_id: String) -> Result<Vec<String>, String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|error| format!("调试会话锁失败: {error}"))?;
    let Some(session) = sessions.get(&session_id) else {
        return Ok(Vec::new());
    };
    let log = session
        .log
        .lock()
        .map_err(|error| format!("调试会话锁失败: {error}"))?;
    Ok(log.iter().cloned().collect())
}

/// 窗口销毁时调用：连接必须一起收掉，否则会留下一个没人读的 socket
pub fn stop_window_sessions(app: &AppHandle, window_label: &str) {
    app.state::<DapState>()
        .stop_matching(|window| window == window_label);
}

pub fn stop_all_sessions(app: &AppHandle) {
    app.state::<DapState>().stop_matching(|_| true);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_id_is_derived_from_the_window() {
        assert_eq!(session_id("main"), "dap:main");
        assert_ne!(session_id("main"), session_id("second"));
    }

    #[test]
    fn stopping_an_unknown_session_succeeds() {
        let state = DapState::default();
        assert!(state.stop_session("dap:none").is_ok());
    }

    #[test]
    fn window_lookup_is_empty_without_sessions() {
        let state = DapState::default();
        assert!(state.session_id_for_window("main").is_none());
    }

    #[test]
    fn override_accepts_a_jar_or_a_directory() {
        let dir = tempfile::tempdir().expect("临时目录");
        let jar = dir.path().join("plugin.jar");
        std::fs::write(&jar, "jar").expect("写 jar");
        let by_file = adapter_from_override(&jar.display().to_string()).expect("按文件解析");
        assert_eq!(by_file.jar_path, jar.display().to_string());

        std::fs::write(
            dir.path().join("adapter.json"),
            r#"{"version":"1.2.3","jar":"plugin.jar"}"#,
        )
        .expect("写描述");
        let by_dir = adapter_from_override(&dir.path().display().to_string()).expect("按目录解析");
        assert_eq!(by_dir.version, "1.2.3");
        assert_eq!(by_dir.jar_path, jar.display().to_string());

        assert!(adapter_from_override("").is_none());
        assert!(adapter_from_override("/definitely/missing").is_none());
    }

    #[test]
    fn adapter_descriptor_is_parsed() {
        let descriptor: AdapterDescriptor =
            serde_json::from_str(r#"{"version":"0.53.1","jar":"plugin.jar"}"#).expect("描述可解析");
        assert_eq!(descriptor.version, "0.53.1");
        assert_eq!(descriptor.jar, "plugin.jar");
    }

    #[test]
    fn log_keeps_the_newest_lines() {
        let log = Mutex::new(VecDeque::new());
        for index in 0..(DAP_LOG_LINES + 10) {
            push_log(&log, format!("line {index}"));
        }
        let lines = log.lock().expect("锁");
        assert_eq!(lines.len(), DAP_LOG_LINES);
        // 最旧的 10 条被挤掉，最新一条必须还在
        assert_eq!(lines.front().map(String::as_str), Some("line 10"));
        assert_eq!(
            lines.back().map(String::as_str),
            Some(format!("line {}", DAP_LOG_LINES + 9).as_str())
        );
    }
}
