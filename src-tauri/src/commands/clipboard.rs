//! 系统剪贴板文件读取 + 外部文件复制入库。
//!
//! 背景：资源树原先的剪贴板是纯应用内状态（`workspace.clipboard` 存工作区内
//! 路径），从 Finder / 资源管理器复制文件后按粘贴毫无反应。本模块补上缺的
//! 一环：从系统剪贴板读出文件路径列表，再把工作区外的文件复制进工作区。
//!
//! 平台策略：
//! - macOS：读 `NSPasteboard.generalPasteboard`。Finder 写文件复制时会同时
//!   提供 `NSFilenamesPboardType`（老类型，向后兼容）与可转为 NSURL 的对象；
//!   先读老类型（零构造开销），没有再走 `readObjectsForClasses:@[NSURL]`
//!   取 `path`。AppKit 对象必须在主线程访问，经 `run_on_main_thread` 切回
//!   （与 `set_dock_menu` 同一范式），内部 `catch_unwind` 防 panic 穿越。
//! - Windows：`clipboard-win` 读 `CF_HDROP`（`FileList`），资源管理器复制的
//!   文件天然就是该格式。剪贴板无文件或被占用时按空列表处理，不报错。
//! - Linux / 其它：返回空列表，前端降级提示（不定再引入 x11 依赖）。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use walkdir::WalkDir;

use super::fs::canonicalize_for_creation;
use super::path_util::resolve_inside_workspace;

/// 读系统剪贴板中的文件路径列表（绝对路径）。
///
/// 剪贴板里没有文件时返回空数组（不是错误），调用方据此提示
/// 「系统剪贴板中没有可粘贴的文件」。
#[tauri::command]
pub fn read_system_clipboard_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        return read_macos_clipboard_files(app);
    }
    #[cfg(target_os = "windows")]
    {
        return read_windows_clipboard_files();
    }
    #[allow(unreachable_code)]
    {
        let _ = app;
        Ok(Vec::new())
    }
}

/// 把工作区外的单个文件/目录复制到工作区内的目标路径。
///
/// 与 `copy_entry` 的区别：源路径不受工作区边界限制（绝对路径即可），目标
/// 仍走 `resolve_inside_workspace`（工作区边界 + TCC 书签语义复用）。目标已
/// 存在直接报错，`-copyN` 重命名由前端（`workspace.pasteExternal`）统一处理，
/// 与内部粘贴的命名规则保持一致。
#[tauri::command]
pub async fn copy_external_entries(
    root: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let handle = tokio::task::spawn_blocking(move || copy_external_blocking(root, from, to));
    match tokio::time::timeout(Duration::from_secs(120), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("复制任务失败: {join}")),
        Err(_) => Err("复制超时（120s）".into()),
    }
}

fn copy_external_blocking(root: String, from: String, to: String) -> Result<(), String> {
    let from_path = PathBuf::from(&from);
    if !from_path.is_absolute() {
        return Err("外部复制源必须是绝对路径".into());
    }
    if !from_path.exists() {
        return Err(format!(
            "复制源不存在：{}",
            from_path.to_string_lossy()
        ));
    }
    let root_path = PathBuf::from(&root);
    let to_path = resolve_inside_workspace(&root_path, Path::new(&to))?;
    if to_path.exists() {
        return Err("目标路径已存在".into());
    }

    if from_path.is_file() {
        if let Some(parent) = to_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(&from_path, &to_path).map_err(|e| e.to_string())?;
        return Ok(());
    }
    if !from_path.is_dir() {
        return Err("不支持的复制源".into());
    }
    let from_canon = fs::canonicalize(&from_path).map_err(|e| e.to_string())?;
    let destination_canon = canonicalize_for_creation(&to_path)?;
    if destination_canon.starts_with(&from_canon) {
        return Err("不能将文件夹复制到自身或其子目录内".into());
    }
    for entry in WalkDir::new(&from_path) {
        let entry = entry.map_err(|e| e.to_string())?;
        let rel = entry
            .path()
            .strip_prefix(&from_path)
            .map_err(|e| e.to_string())?;
        let dest = to_path.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(entry.path(), &dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn read_windows_clipboard_files() -> Result<Vec<String>, String> {
    let files: Vec<PathBuf> =
        clipboard_win::get_clipboard(clipboard_win::formats::FileList).unwrap_or_default();
    Ok(files
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .collect())
}

#[cfg(target_os = "macos")]
fn read_macos_clipboard_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(read_macos_pasteboard_files));
        let _ = tx.send(result);
    })
    .map_err(|e| format!("无法在主线程读取剪贴板：{e}"))?;
    match rx.recv() {
        Ok(Ok(files)) => Ok(files),
        Ok(Err(panic)) => {
            let msg = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "未知 panic".to_string());
            Err(format!("读取系统剪贴板失败：{msg}"))
        }
        Err(e) => Err(format!("读取系统剪贴板失败：{e}")),
    }
}

/// 主线程内执行：先读 `NSFilenamesPboardType`，没有再读 NSURL 对象。
/// 只保留真实存在的文件系统路径（过滤掉网页 URL 等转出来的非文件项）。
#[cfg(target_os = "macos")]
fn read_macos_pasteboard_files() -> Vec<String> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::NSString;

    unsafe {
        let pb_class = match AnyClass::get(c"NSPasteboard") {
            Some(c) => c,
            None => return Vec::new(),
        };
        let pb: *mut AnyObject = msg_send![pb_class, generalPasteboard];
        if pb.is_null() {
            return Vec::new();
        }

        // 路径 1：Finder 兼容的老类型，直接是 NSString 文件名数组。
        let filenames_type = NSString::from_str("NSFilenamesPboardType");
        let list: *mut AnyObject = msg_send![pb, propertyListForType: &*filenames_type];
        let mut out = nsstring_array_to_vec(list);
        if !out.is_empty() {
            return out;
        }

        // 路径 2：可转为 NSURL 的对象，逐个取 path。
        let nsurl_class = match AnyClass::get(c"NSURL") {
            Some(c) => c,
            None => return Vec::new(),
        };
        let nsarray_class = match AnyClass::get(c"NSArray") {
            Some(c) => c,
            None => return Vec::new(),
        };
        let class_array: *mut AnyObject = msg_send![nsarray_class, arrayWithObject: nsurl_class];
        if class_array.is_null() {
            return Vec::new();
        }
        let urls: *mut AnyObject =
            msg_send![pb, readObjectsForClasses: class_array, options: std::ptr::null::<AnyObject>()];
        if urls.is_null() {
            return Vec::new();
        }
        let count: usize = msg_send![urls, count];
        for i in 0..count {
            let url: *mut AnyObject = msg_send![urls, objectAtIndex: i];
            if url.is_null() {
                continue;
            }
            let path_str: *mut AnyObject = msg_send![url, path];
            if path_str.is_null() {
                continue;
            }
            if let Some(p) = nsstring_to_string(path_str) {
                out.push(p);
            }
        }
        // 非文件 URL（网页链接等）转出的 path 不存在于磁盘，直接过滤。
        out.into_iter()
            .filter(|p| Path::new(p).exists())
            .collect()
    }
}

/// NSArray<NSString>（或 null）转 Vec<String>。非 NSString 元素跳过。
#[cfg(target_os = "macos")]
unsafe fn nsstring_array_to_vec(array: *mut objc2::runtime::AnyObject) -> Vec<String> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    if array.is_null() {
        return Vec::new();
    }
    let count: usize = msg_send![array, count];
    let mut out = Vec::new();
    for i in 0..count {
        let item: *mut AnyObject = msg_send![array, objectAtIndex: i];
        if item.is_null() {
            continue;
        }
        if let Some(s) = nsstring_to_string(item) {
            out.push(s);
        }
    }
    out
}

#[cfg(target_os = "macos")]
unsafe fn nsstring_to_string(ns: *mut objc2::runtime::AnyObject) -> Option<String> {
    use objc2::msg_send;
    let utf8: *const i8 = msg_send![ns, UTF8String];
    if utf8.is_null() {
        return None;
    }
    Some(
        std::ffi::CStr::from_ptr(utf8)
            .to_string_lossy()
            .into_owned(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_copy_rejects_relative_source() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path().join("repo");
        std::fs::create_dir_all(&root).expect("创建工作区");
        let error = copy_external_blocking(
            root.to_string_lossy().into_owned(),
            "relative/source.txt".into(),
            "dest.txt".into(),
        )
        .expect_err("相对源路径应被拒绝");
        assert!(error.contains("绝对路径"));
    }

    #[test]
    fn external_copy_rejects_missing_source() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path().join("repo");
        std::fs::create_dir_all(&root).expect("创建工作区");
        let missing = temp.path().join("nope.txt");
        let error = copy_external_blocking(
            root.to_string_lossy().into_owned(),
            missing.to_string_lossy().into_owned(),
            "dest.txt".into(),
        )
        .expect_err("不存在的源应报错");
        assert!(error.contains("不存在"));
    }

    #[test]
    fn external_copy_file_into_workspace() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path().join("repo");
        std::fs::create_dir_all(&root).expect("创建工作区");
        let outside = temp.path().join("outside.txt");
        std::fs::write(&outside, "hello").expect("写外部源文件");
        copy_external_blocking(
            root.to_string_lossy().into_owned(),
            outside.to_string_lossy().into_owned(),
            "sub/copy.txt".into(),
        )
        .expect("外部文件复制");
        assert_eq!(
            std::fs::read_to_string(root.join("sub/copy.txt")).expect("读目标"),
            "hello"
        );
    }

    #[test]
    fn external_copy_directory_into_workspace() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path().join("repo");
        std::fs::create_dir_all(&root).expect("创建工作区");
        let outside = temp.path().join("outside-dir");
        std::fs::create_dir_all(outside.join("nested")).expect("建外部目录");
        std::fs::write(outside.join("a.txt"), "a").expect("写文件");
        std::fs::write(outside.join("nested/b.txt"), "b").expect("写嵌套文件");
        copy_external_blocking(
            root.to_string_lossy().into_owned(),
            outside.to_string_lossy().into_owned(),
            "imported".into(),
        )
        .expect("外部目录复制");
        assert_eq!(
            std::fs::read_to_string(root.join("imported/a.txt")).expect("读文件"),
            "a"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("imported/nested/b.txt")).expect("读嵌套"),
            "b"
        );
    }

    #[test]
    fn external_copy_rejects_existing_target() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path().join("repo");
        std::fs::create_dir_all(&root).expect("创建工作区");
        let outside = temp.path().join("outside.txt");
        std::fs::write(&outside, "x").expect("写外部源");
        std::fs::write(root.join("dest.txt"), "y").expect("写已存在目标");
        let error = copy_external_blocking(
            root.to_string_lossy().into_owned(),
            outside.to_string_lossy().into_owned(),
            "dest.txt".into(),
        )
        .expect_err("目标已存在应报错");
        assert!(error.contains("已存在"));
    }

    #[test]
    fn external_copy_rejects_workspace_escape_target() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path().join("repo");
        std::fs::create_dir_all(&root).expect("创建工作区");
        let outside = temp.path().join("outside.txt");
        std::fs::write(&outside, "x").expect("写外部源");
        let error = copy_external_blocking(
            root.to_string_lossy().into_owned(),
            outside.to_string_lossy().into_owned(),
            "../escape.txt".into(),
        )
        .expect_err("穿越目标应被拒绝");
        assert!(error.contains("非法组件"));
    }
}
