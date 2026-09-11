//! 外部编辑器打开桥接。
//!
//! 负责把 CLI、macOS Launch Services 传入的路径统一转成前端可消费的事件。
//! 前端启动较慢时先放入 pending 队列，避免冷启动时丢失外部打开请求。

use serde::Serialize;
use std::{path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

#[cfg(target_os = "macos")]
use tauri::Url;

pub const EVENT_NAME: &str = "app://open-external";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalOpenTarget {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    pub is_dir: bool,
}

impl ExternalOpenTarget {
    pub fn from_path(path: PathBuf, line: Option<u32>, column: Option<u32>) -> Self {
        let is_dir = path.is_dir();
        Self {
            path: path.to_string_lossy().into_owned(),
            line,
            column,
            is_dir,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalOpenRequest {
    pub targets: Vec<ExternalOpenTarget>,
}

impl ExternalOpenRequest {
    pub fn new(targets: Vec<ExternalOpenTarget>) -> Self {
        Self { targets }
    }
}

#[derive(Default)]
struct ExternalOpenStateInner {
    frontend_ready: bool,
    pending: Vec<ExternalOpenRequest>,
}

/// 外部打开请求的进程内队列。
///
/// `RunEvent::Opened` 可能早于 WebView 挂载；`frontend_ready` 之前的请求先缓存，
/// 前端注册监听后通过 `take_pending_external_opens` 一次性取走。
#[derive(Default)]
pub struct ExternalOpenState {
    inner: Mutex<ExternalOpenStateInner>,
}

impl ExternalOpenState {
    pub fn with_pending(targets: Vec<ExternalOpenTarget>) -> Self {
        let pending = if targets.is_empty() {
            Vec::new()
        } else {
            vec![ExternalOpenRequest::new(targets)]
        };
        Self {
            inner: Mutex::new(ExternalOpenStateInner {
                frontend_ready: false,
                pending,
            }),
        }
    }
}

/// 前端完成监听注册后取出冷启动期间缓存的请求，并切换到实时事件模式。
#[tauri::command]
pub fn take_pending_external_opens(
    state: State<'_, ExternalOpenState>,
) -> Vec<ExternalOpenRequest> {
    let mut inner = state
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    inner.frontend_ready = true;
    std::mem::take(&mut inner.pending)
}

/// 把请求送给前端；WebView 尚未准备好时暂存，避免冷启动丢路径。
pub fn enqueue<R: Runtime>(app: &AppHandle<R>, request: ExternalOpenRequest) {
    if request.targets.is_empty() {
        return;
    }

    let emit_now = {
        let state = app.state::<ExternalOpenState>();
        let mut inner = state
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if inner.frontend_ready {
            true
        } else {
            inner.pending.push(request.clone());
            false
        }
    };

    if emit_now {
        if let Err(error) = app.emit(EVENT_NAME, request) {
            eprintln!("[external-open] 无法通知前端：{error}");
        }
    }
}

pub fn enqueue_targets<R: Runtime>(app: &AppHandle<R>, targets: Vec<ExternalOpenTarget>) {
    enqueue(app, ExternalOpenRequest::new(targets));
}

/// 把第二次 CLI 调用带来的参数送入现有实例。
pub fn focus_primary_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 将 macOS Launch Services 的文件 URL 转成可打开的本地路径。
#[cfg(target_os = "macos")]
pub fn targets_from_urls(urls: Vec<Url>) -> Vec<ExternalOpenTarget> {
    urls.into_iter()
        .filter_map(|url| {
            if url.scheme() != "file" {
                return None;
            }
            let path = url.to_file_path().ok()?;
            if path.as_os_str().is_empty() {
                return None;
            }
            Some(ExternalOpenTarget::from_path(path, None, None))
        })
        .collect()
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn converts_file_urls_to_local_targets() {
        let url = Url::parse("file:///tmp/Prism%20Code.ts").expect("文件 URL 应有效");
        let targets = targets_from_urls(vec![url]);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].path, "/tmp/Prism Code.ts");
        assert!(!targets[0].is_dir);
        assert_eq!(targets[0].line, None);
    }

    #[test]
    fn ignores_non_file_urls() {
        let url = Url::parse("https://example.com/file.ts").expect("URL 应有效");
        assert!(targets_from_urls(vec![url]).is_empty());
    }
}
