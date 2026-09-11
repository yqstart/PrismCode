use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use walkdir::WalkDir;

use super::path_util::{is_tree_ignored, resolve_inside_workspace};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
pub async fn list_dir(
    root: String,
    path: String,
    extra_ignores: Option<Vec<String>>,
) -> Result<Vec<DirEntryInfo>, String> {
    // 超大目录 read_dir + 排序放 spawn_blocking，避免主线程卡顿
    let handle = tokio::task::spawn_blocking(move || {
        list_dir_blocking(root, path, extra_ignores)
    });
    match tokio::time::timeout(Duration::from_secs(15), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("列出目录任务失败: {join}")),
        Err(_) => Err("列出目录超时（15s）".into()),
    }
}

fn list_dir_blocking(
    root: String,
    path: String,
    extra_ignores: Option<Vec<String>>,
) -> Result<Vec<DirEntryInfo>, String> {
    let root_path = PathBuf::from(&root);
    let dir = resolve_inside_workspace(&root_path, Path::new(&path))?;

    if !dir.is_dir() {
        return Err("目标不是目录".into());
    }

    let extra = extra_ignores.unwrap_or_default();
    let mut entries = Vec::new();

    let rd = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for item in rd {
        let item = item.map_err(|e| e.to_string())?;
        let name = item.file_name().to_string_lossy().to_string();
        if is_tree_ignored(&name, &extra) {
            continue;
        }
        let file_type = item.file_type().map_err(|e| e.to_string())?;
        entries.push(DirEntryInfo {
            name,
            path: item.path().to_string_lossy().to_string(),
            is_dir: file_type.is_dir(),
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[tauri::command]
pub async fn read_text_file(root: String, path: String) -> Result<String, String> {
    // 20MB 级整读放 spawn_blocking，避免打开大文件时冻结 UI
    let handle = tokio::task::spawn_blocking(move || {
        read_text_file_blocking(root, path)
    });
    match tokio::time::timeout(Duration::from_secs(30), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("读取文件任务失败: {join}")),
        Err(_) => Err("读取文件超时（30s）".into()),
    }
}

fn read_text_file_blocking(root: String, path: String) -> Result<String, String> {
    const MAX_BYTES: u64 = 20 * 1024 * 1024; // 20MB（对齐 read_file_base64 的上限策略）
    let root_path = PathBuf::from(&root);
    let file = resolve_inside_workspace(&root_path, Path::new(&path))?;
    if !file.is_file() {
        return Err("目标不是文件".into());
    }
    // 先查元数据，超大文件不整读进内存（避免内存翻倍 + IPC 序列化爆炸）
    let meta = fs::metadata(&file).map_err(|e| e.to_string())?;
    if meta.len() > MAX_BYTES {
        return Err(format!("文件过大，暂不支持打开（上限 {}MB）", MAX_BYTES / 1024 / 1024));
    }
    let bytes = fs::read(&file).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Err("暂不支持打开二进制文件".into());
    }
    String::from_utf8(bytes).map_err(|_| "文件不是有效 UTF-8 文本".into())
}

/// 读取工作区内二进制文件为 base64（图片预览）
#[tauri::command]
pub async fn read_file_base64(root: String, path: String) -> Result<String, String> {
    // 40MB 读取 + base64 编码（产出 ~53MB 字符串）放 spawn_blocking，避免冻结 UI
    let handle = tokio::task::spawn_blocking(move || {
        read_file_base64_blocking(root, path)
    });
    match tokio::time::timeout(Duration::from_secs(30), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("读取图片任务失败: {join}")),
        Err(_) => Err("读取图片超时（30s）".into()),
    }
}

fn read_file_base64_blocking(root: String, path: String) -> Result<String, String> {
    const MAX_BYTES: usize = 40 * 1024 * 1024; // 40MB
    let root_path = PathBuf::from(&root);
    let file = resolve_inside_workspace(&root_path, Path::new(&path))?;
    if !file.is_file() {
        return Err("目标不是文件".into());
    }
    let meta = fs::metadata(&file).map_err(|e| e.to_string())?;
    if meta.len() as usize > MAX_BYTES {
        return Err("图片过大，无法预览（上限 40MB）".into());
    }
    let bytes = fs::read(&file).map_err(|e| e.to_string())?;
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub fn write_text_file(root: String, path: String, content: String) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    let file = resolve_inside_workspace(&root_path, Path::new(&path))?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&file, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_entry(root: String, path: String, is_dir: bool) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    let target = resolve_inside_workspace(&root_path, Path::new(&path))?;
    if target.exists() {
        return Err("路径已存在".into());
    }
    if is_dir {
        fs::create_dir_all(&target).map_err(|e| e.to_string())
    } else {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&target, "").map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn rename_entry(root: String, from: String, to: String) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    let from_path = resolve_inside_workspace(&root_path, Path::new(&from))?;
    let to_path = resolve_inside_workspace(&root_path, Path::new(&to))?;
    ensure_not_workspace_root(&root_path, &from_path, "不能重命名工作区根目录")?;
    if to_path.exists() {
        return Err("目标路径已存在".into());
    }
    fs::rename(&from_path, &to_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_entry(root: String, path: String) -> Result<(), String> {
    // 整目录递归删除（remove_dir_all）放 spawn_blocking，避免大目录删除冻结 UI
    let handle = tokio::task::spawn_blocking(move || delete_entry_blocking(root, path));
    match tokio::time::timeout(Duration::from_secs(60), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("删除任务失败: {join}")),
        Err(_) => Err("删除超时（60s）".into()),
    }
}

fn delete_entry_blocking(root: String, path: String) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    let target = resolve_inside_workspace(&root_path, Path::new(&path))?;
    ensure_not_workspace_root(&root_path, &target, "不能删除工作区根目录")?;
    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&target).map_err(|e| e.to_string())
    }
}

fn ensure_not_workspace_root(root: &Path, target: &Path, message: &str) -> Result<(), String> {
    let root_canon = fs::canonicalize(root).map_err(|e| format!("工作区无效: {e}"))?;
    let target_canon = fs::canonicalize(target).map_err(|e| e.to_string())?;
    if target_canon == root_canon {
        return Err(message.into());
    }
    Ok(())
}

#[tauri::command]
pub async fn copy_entry(root: String, from: String, to: String) -> Result<(), String> {
    // 整目录递归复制（WalkDir）放 spawn_blocking，避免大目录复制冻结 UI
    let handle = tokio::task::spawn_blocking(move || copy_entry_blocking(root, from, to));
    match tokio::time::timeout(Duration::from_secs(120), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("复制任务失败: {join}")),
        Err(_) => Err("复制超时（120s）".into()),
    }
}

fn copy_entry_blocking(root: String, from: String, to: String) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    let from_path = resolve_inside_workspace(&root_path, Path::new(&from))?;
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

/// 目标尚不存在时，按最近的现存祖先解析其真实路径，识别通过符号链接
/// 指向源目录的复制目标，避免递归复制把新文件继续纳入 WalkDir。
fn canonicalize_for_creation(path: &Path) -> Result<PathBuf, String> {
    let mut existing = path;
    let mut missing = Vec::new();
    loop {
        match fs::symlink_metadata(existing) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = existing
                    .file_name()
                    .ok_or_else(|| "无效目标路径".to_string())?;
                missing.push(name.to_os_string());
                existing = existing
                    .parent()
                    .ok_or_else(|| "无效目标路径".to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let mut canonical = fs::canonicalize(existing).map_err(|e| e.to_string())?;
    for component in missing.iter().rev() {
        canonical.push(component);
    }
    Ok(canonical)
}

#[tauri::command]
pub fn path_exists(root: String, path: String) -> Result<bool, String> {
    let root_path = PathBuf::from(&root);
    let target = resolve_inside_workspace(&root_path, Path::new(&path))?;
    Ok(target.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_workspace_paths_use_the_selected_root() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path().join("repo");
        std::fs::create_dir_all(&root).expect("创建工作区");

        write_text_file(
            root.to_string_lossy().into_owned(),
            "nested/config.json".into(),
            "{}".into(),
        )
        .expect("写入相对路径");

        let target = root.join("nested/config.json");
        assert_eq!(std::fs::read_to_string(&target).expect("读取文件"), "{}");
        assert!(path_exists(
            root.to_string_lossy().into_owned(),
            "nested/config.json".into(),
        )
        .expect("检查相对路径"));
    }

    #[test]
    fn workspace_root_cannot_be_renamed_or_deleted() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path().join("repo");
        std::fs::create_dir_all(&root).expect("创建工作区");
        let root_string = root.to_string_lossy().into_owned();

        let delete_error = delete_entry_blocking(root_string.clone(), ".".into())
            .expect_err("不应删除工作区根目录");
        assert!(delete_error.contains("不能删除工作区根目录"));
        assert!(root.is_dir());

        let rename_error = rename_entry(root_string, ".".into(), "renamed".into())
            .expect_err("不应重命名工作区根目录");
        assert!(rename_error.contains("不能重命名工作区根目录"));
        assert!(root.is_dir());
    }

    #[test]
    fn copy_directory_into_itself_is_rejected_for_dot_alias() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path().join("repo");
        std::fs::create_dir_all(&root).expect("创建工作区");
        let root_string = root.to_string_lossy().into_owned();

        let error = copy_entry_blocking(root_string, ".".into(), "nested".into())
            .expect_err("工作区根目录不能复制到自身子目录");
        assert!(error.contains("不能将文件夹复制到自身或其子目录内"));
        assert!(!root.join("nested").exists());
    }

    #[cfg(unix)]
    #[test]
    fn copy_directory_into_symlinked_child_is_rejected() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path().join("repo");
        let source = root.join("source");
        std::fs::create_dir_all(&source).expect("创建源目录");
        symlink(&source, root.join("alias")).expect("创建目录符号链接");

        let error = copy_entry_blocking(
            root.to_string_lossy().into_owned(),
            "source".into(),
            "alias/nested".into(),
        )
        .expect_err("符号链接别名下不应递归复制");
        assert!(error.contains("不能将文件夹复制到自身或其子目录内"));
        assert!(!source.join("nested").exists());
    }
}

/// 读取全局用户 snippets 目录（~/.prismcode/snippets/*.json），返回（文件名, 内容）列表。
/// 与应用级 SSH/AI 凭据同模式（home 目录不受工作区边界限制）；目录不存在返回空。
#[tauri::command]
pub fn snippets_read_global() -> Result<Vec<(String, String)>, String> {
    const MAX_BYTES: u64 = 512 * 1024; // 单文件 512KB 上限（snippet 文件足够）
    let dir = crate::user_data::user_data_dir()
        .ok_or_else(|| "无法确定用户主目录".to_string())?
        .join("snippets");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") {
            continue;
        }
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        if meta.len() > MAX_BYTES {
            continue;
        }
        let content = fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
        out.push((name, content));
    }
    Ok(out)
}
