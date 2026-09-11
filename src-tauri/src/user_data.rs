//! 应用级用户数据目录（~/.prismcode），含自 Miro Code 更名后的迁移。

use std::path::{Path, PathBuf};

const NEW_DIR_NAME: &str = ".prismcode";
const LEGACY_DIR_NAME: &str = ".mirocode";

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// 返回 Prism Code 用户数据目录；若仅存在旧 `~/.mirocode` 则尝试一次性重命名。
pub fn user_data_dir() -> Option<PathBuf> {
    let home = home_dir()?;
    resolve_user_data_dir(&home)
}

fn resolve_user_data_dir(home: &Path) -> Option<PathBuf> {
    let new_dir = home.join(NEW_DIR_NAME);
    let legacy_dir = home.join(LEGACY_DIR_NAME);
    if new_dir.exists() {
        return Some(new_dir);
    }
    if legacy_dir.is_dir() {
        if std::fs::rename(&legacy_dir, &new_dir).is_ok() {
            return Some(new_dir);
        }
        return Some(legacy_dir);
    }
    Some(new_dir)
}
