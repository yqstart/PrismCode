//! 通用 LSP 宿主：只负责子进程、Content-Length 帧和生命周期。
//! 请求关联、文档版本和能力协商在前端。

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const LSP_READ_BUF_BYTES: usize = 32 * 1024;
const LSP_STDERR_LOG_LINES: usize = 500;
/// 会话收尾宽限期：先关标准输入，超时才强杀（DAP 调试会话共用同一节奏）
pub(crate) const LSP_STOP_GRACE_MS: u64 = 2000;

pub fn frame_message(body: &str) -> Vec<u8> {
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut bytes = header.into_bytes();
    bytes.extend_from_slice(body.as_bytes());
    bytes
}

pub struct FrameParser {
    buf: Vec<u8>,
}

impl FrameParser {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        self.buf.extend_from_slice(chunk);
        let mut frames = Vec::new();
        loop {
            match self.try_one() {
                Ok(None) => break,
                Ok(Some(body)) => frames.push(body),
                Err(error) => {
                    self.buf.clear();
                    return Err(error);
                }
            }
        }
        Ok(frames)
    }

    fn try_one(&mut self) -> Result<Option<String>, String> {
        let Some(header_end) = find_header_end(&self.buf) else {
            if self.buf.len() > MAX_HEADER_BYTES {
                return Err("LSP 消息帧无效: 头部过长".into());
            }
            return Ok(None);
        };
        if header_end > MAX_HEADER_BYTES {
            return Err("LSP 消息帧无效: 头部过长".into());
        }
        let header = std::str::from_utf8(&self.buf[..header_end])
            .map_err(|_| "LSP 消息帧无效: 头部不是 UTF-8".to_string())?;
        let content_length = parse_content_length(header)?;
        if content_length > MAX_MESSAGE_BYTES {
            return Err("LSP 消息帧无效: 正文过长".into());
        }
        let body_start = header_end + 4;
        let total = body_start + content_length;
        if self.buf.len() < total {
            return Ok(None);
        }
        let text = std::str::from_utf8(&self.buf[body_start..total])
            .map(|value| value.to_string())
            .map_err(|_| "LSP 消息帧无效: 正文不是 UTF-8".to_string())?;
        self.buf.drain(..total);
        Ok(Some(text))
    }
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_content_length(header: &str) -> Result<usize, String> {
    for line in header.split("\r\n") {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length:") {
            return rest
                .trim()
                .parse::<usize>()
                .map_err(|_| "LSP 消息帧无效: Content-Length 无法解析".to_string());
        }
    }
    Err("LSP 消息帧无效: 缺少 Content-Length".into())
}

struct LspSession {
    window: String,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    child: Arc<Mutex<Child>>,
    exited: Arc<AtomicBool>,
    stderr_log: Arc<Mutex<VecDeque<String>>>,
}

#[derive(Default)]
pub struct LspState {
    sessions: Mutex<HashMap<String, LspSession>>,
}

impl LspState {
    /// 关闭标准输入，宽限期内轮询退出，超时后 kill。会话不存在时直接成功。
    pub fn stop_session(&self, session_id: &str) -> Result<(), String> {
        let session = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|error| format!("语言服务锁失败: {error}"))?;
            sessions.remove(session_id)
        };
        let Some(session) = session else {
            return Ok(());
        };
        if let Ok(mut stdin) = session.stdin.lock() {
            stdin.take();
        }
        let deadline = Instant::now() + Duration::from_millis(LSP_STOP_GRACE_MS);
        loop {
            if session.exited.load(Ordering::SeqCst) || poll_child(&session.child)?.is_some() {
                session.exited.store(true, Ordering::SeqCst);
                return Ok(());
            }
            if Instant::now() >= deadline {
                if let Ok(mut child) = session.child.lock() {
                    let _ = child.kill();
                }
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
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
}

/// `Some` 表示进程已经结束（退出码可能为空）；`None` 表示仍在运行。
pub(crate) fn poll_child(child: &Mutex<Child>) -> Result<Option<Option<i32>>, String> {
    let mut guard = child
        .lock()
        .map_err(|error| format!("停止语言服务失败: {error}"))?;
    match guard.try_wait() {
        Ok(Some(status)) => Ok(Some(status.code())),
        Ok(None) => Ok(None),
        Err(_) => Ok(Some(None)),
    }
}

/// 会话结束时只发一次退出事件：读线程与停止命令可能同时收尾。
/// 事件名由调用方给出，DAP 会话借同一实现发 `dap://exit/...`。
pub(crate) fn emit_session_exit(
    app: &AppHandle,
    window: &str,
    event: &str,
    code: Option<i32>,
    emitted: &AtomicBool,
) {
    if emitted.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = app.emit_to(window, event, code);
}

fn emit_exit(app: &AppHandle, window: &str, session_id: &str, code: Option<i32>, emitted: &AtomicBool) {
    emit_session_exit(app, window, &format!("lsp://exit/{session_id}"), code, emitted);
}

#[tauri::command]
pub async fn lsp_start(
    window: tauri::WebviewWindow,
    state: State<'_, LspState>,
    session_id: String,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: HashMap<String, String>,
) -> Result<u32, String> {
    {
        let sessions = state
            .sessions
            .lock()
            .map_err(|error| format!("语言服务锁失败: {error}"))?;
        if sessions.contains_key(&session_id) {
            return Err(format!("语言服务会话已存在: {session_id}"));
        }
    }

    let mut command = Command::new(&program);
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd.filter(|value| !value.is_empty()) {
        command.current_dir(cwd);
    }
    for (key, value) in env {
        command.env(key, value);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动语言服务: {error}"))?;
    let pid = child.id();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "语言服务没有标准输入".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "语言服务没有标准输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "语言服务没有标准错误".to_string())?;

    let stdin = Arc::new(Mutex::new(Some(stdin)));
    let child = Arc::new(Mutex::new(child));
    let exited = Arc::new(AtomicBool::new(false));
    let exit_emitted = Arc::new(AtomicBool::new(false));
    let stderr_log = Arc::new(Mutex::new(VecDeque::with_capacity(LSP_STDERR_LOG_LINES)));
    let window_label = window.label().to_string();
    let app = window.app_handle().clone();

    state
        .sessions
        .lock()
        .map_err(|error| format!("语言服务锁失败: {error}"))?
        .insert(
            session_id.clone(),
            LspSession {
                window: window_label.clone(),
                stdin: Arc::clone(&stdin),
                child: Arc::clone(&child),
                exited: Arc::clone(&exited),
                stderr_log: Arc::clone(&stderr_log),
            },
        );

    {
        let app = app.clone();
        let window_label = window_label.clone();
        let session_id = session_id.clone();
        let stderr_log = Arc::clone(&stderr_log);
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if let Ok(mut log) = stderr_log.lock() {
                    if log.len() >= LSP_STDERR_LOG_LINES {
                        log.pop_front();
                    }
                    log.push_back(line.clone());
                }
                let _ = app.emit_to(&window_label, &format!("lsp://stderr/{session_id}"), line);
            }
        });
    }

    {
        let app = app.clone();
        let window_label = window_label.clone();
        let session_id = session_id.clone();
        let child = Arc::clone(&child);
        let exited = Arc::clone(&exited);
        let exit_emitted = Arc::clone(&exit_emitted);
        std::thread::spawn(move || {
            let mut parser = FrameParser::new();
            let mut buf = vec![0u8; LSP_READ_BUF_BYTES];
            let mut stdout = stdout;
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(size) => match parser.push(&buf[..size]) {
                        Ok(frames) => {
                            for frame in frames {
                                let _ = app.emit_to(
                                    &window_label,
                                    &format!("lsp://message/{session_id}"),
                                    frame,
                                );
                            }
                        }
                        Err(error) => {
                            let _ = app.emit_to(
                                &window_label,
                                &format!("lsp://stderr/{session_id}"),
                                error,
                            );
                        }
                    },
                }
            }
            let code = loop {
                match poll_child(&child) {
                    Ok(Some(code)) => break code,
                    Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                    Err(_) => break None,
                }
            };
            exited.store(true, Ordering::SeqCst);
            emit_exit(&app, &window_label, &session_id, code, &exit_emitted);
            if let Some(state) = app.try_state::<LspState>() {
                if let Ok(mut sessions) = state.sessions.lock() {
                    sessions.remove(&session_id);
                }
            }
        });
    }

    Ok(pid)
}

#[tauri::command]
pub async fn lsp_send(
    state: State<'_, LspState>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|error| format!("语言服务锁失败: {error}"))?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("语言服务会话不存在: {session_id}"))?;
    let mut stdin = session
        .stdin
        .lock()
        .map_err(|error| format!("语言服务锁失败: {error}"))?;
    let stdin = stdin
        .as_mut()
        .ok_or_else(|| format!("语言服务会话不存在: {session_id}"))?;
    stdin
        .write_all(&frame_message(&message))
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("写入语言服务失败: {error}"))
}

#[tauri::command]
pub async fn lsp_stop(state: State<'_, LspState>, session_id: String) -> Result<(), String> {
    state.stop_session(&session_id)
}

#[tauri::command]
pub async fn lsp_logs(
    state: State<'_, LspState>,
    session_id: String,
) -> Result<Vec<String>, String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|error| format!("语言服务锁失败: {error}"))?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("语言服务会话不存在: {session_id}"))?;
    let log = session
        .stderr_log
        .lock()
        .map_err(|error| format!("语言服务锁失败: {error}"))?;
    Ok(log.iter().cloned().collect())
}

pub fn stop_window_sessions(app: &AppHandle, window_label: &str) {
    app.state::<LspState>()
        .stop_matching(|window| window == window_label);
}

pub fn stop_all_sessions(app: &AppHandle) {
    app.state::<LspState>().stop_matching(|_| true);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_message_counts_utf8_bytes() {
        let body = r#"{"message":"你好"}"#;
        let framed = frame_message(body);
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        assert!(framed.starts_with(header.as_bytes()));
        assert!(framed.ends_with(body.as_bytes()));
        assert!(body.len() > body.chars().count());
    }

    #[test]
    fn parser_accepts_a_whole_frame() {
        let body = r#"{"jsonrpc":"2.0","method":"initialized"}"#;
        let mut parser = FrameParser::new();
        let frames = parser.push(&frame_message(body)).expect("整帧");
        assert_eq!(frames, vec![body.to_string()]);
    }

    #[test]
    fn parser_accepts_byte_slices_and_multiple_frames() {
        let first = r#"{"id":1}"#;
        let second = r#"{"id":2,"result":"中文"}"#;
        let mut bytes = frame_message(first);
        bytes.extend(frame_message(second));
        let mut parser = FrameParser::new();
        let mut got = Vec::new();
        for byte in bytes {
            got.extend(parser.push(&[byte]).expect("逐字节"));
        }
        assert_eq!(got, vec![first.to_string(), second.to_string()]);
    }

    #[test]
    fn parser_rejects_oversized_header_missing_length_and_bad_utf8() {
        let mut parser = FrameParser::new();
        let huge = vec![b'A'; MAX_HEADER_BYTES + 8];
        let error = parser.push(&huge).expect_err("超长头");
        assert!(error.contains("头部过长"));
        assert!(parser.buf.is_empty());

        let missing = b"Content-Type: application/vscode-jsonrpc\r\n\r\n{}";
        let error = parser.push(missing).expect_err("缺长度");
        assert!(error.contains("缺少 Content-Length"));
        assert!(parser.buf.is_empty());

        let mut bad = b"Content-Length: 2\r\n\r\n".to_vec();
        bad.extend_from_slice(&[0xff, 0xfe]);
        let error = parser.push(&bad).expect_err("非 UTF-8");
        assert!(error.contains("不是 UTF-8"));
        let recovered = parser.push(&frame_message("{}")).expect("清空后继续");
        assert_eq!(recovered, vec!["{}".to_string()]);
    }

    #[test]
    fn stop_unknown_session_is_idempotent() {
        let state = LspState::default();
        state.stop_session("missing-session").expect("未知会话");
        state.stop_session("missing-session").expect("再次停止");
    }
}
