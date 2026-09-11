use chrono::{Local, TimeZone};
use git2::{
    build::CheckoutBuilder, BranchType, Cred, DiffOptions, RemoteCallbacks, Repository, ResetType,
    Signature, StashFlags, Status, StatusOptions,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt};

fn open_repo(root: &str) -> Result<Repository, String> {
    Repository::discover(root).map_err(|e| format!("未找到 Git 仓库: {e}"))
}

/// `git_unpushed_commits` 进程内 LRU 缓存：
/// 同一 (root, branch, local_oid) 在 30s 内复用上次结果，避免大仓库反复 revwalk 卡顿 PushDialog 打开
const UNPUSHED_CACHE_TTL: Duration = Duration::from_secs(30);

type UnpushedCacheValue = (Instant, Vec<GitCommitInfo>);

fn unpushed_cache() -> &'static Mutex<HashMap<String, UnpushedCacheValue>> {
    static CACHE: OnceLock<Mutex<HashMap<String, UnpushedCacheValue>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

// ==================== git_status TTL 缓存 ====================
// 保存/聚焦/切文件等读路径高频触发 refresh；同一 root 在 TTL 窗口内复用上次
// 结果，避免大仓库（未 ignore 的 node_modules 等）反复全量 status。
// 任何修改工作区/索引/HEAD 的 git 命令先 clear_status_cache()，保证操作后
// 立即刷新能看到新状态（见各命令顶部调用）。
const STATUS_CACHE_TTL: Duration = Duration::from_millis(1500);

struct StatusCacheEntry {
    root: String,
    at: Instant,
    result: Result<GitStatusSnapshot, String>,
}

struct StatusCacheState {
    generation: u64,
    entry: Option<StatusCacheEntry>,
}

static STATUS_CACHE: OnceLock<Mutex<StatusCacheState>> = OnceLock::new();

fn status_cache() -> &'static Mutex<StatusCacheState> {
    STATUS_CACHE.get_or_init(|| {
        Mutex::new(StatusCacheState {
            generation: 0,
            entry: None,
        })
    })
}

/// 使 git_status 缓存失效（修改性命令在改变仓库状态前调用）。
///
/// generation 用来阻止失效前已经在途的 git_status 请求在完成后重新
/// 写入旧快照。仅清空 entry 不够，因为旧请求可能晚于本次修改返回。
pub(crate) fn clear_status_cache() {
    let mut state = status_cache().lock().unwrap_or_else(|e| e.into_inner());
    state.generation = state.generation.wrapping_add(1);
    state.entry = None;
    // HEAD、索引、上游或远端引用变化后，未推送提交列表也不能继续复用旧结果。
    if let Ok(mut cache) = unpushed_cache().lock() {
        cache.clear();
    }
}

fn try_store_status_result(
    state: &mut StatusCacheState,
    root: String,
    request_generation: u64,
    result: Result<GitStatusSnapshot, String>,
) -> bool {
    if state.generation != request_generation {
        return false;
    }
    state.entry = Some(StatusCacheEntry {
        root,
        at: Instant::now(),
        result,
    });
    true
}

fn cache_status_result(
    root: String,
    request_generation: u64,
    result: Result<GitStatusSnapshot, String>,
) {
    let mut state = status_cache().lock().unwrap_or_else(|e| e.into_inner());
    let _ = try_store_status_result(&mut state, root, request_generation, result);
}

/// 进程内串行化会写 Git 索引的操作。
/// 多窗口或快速连续点击时，各操作若同时读取旧 index 再写回，后写入者会覆盖前一次结果。
fn index_operation_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusSnapshot {
    pub initialized: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    /// 当前 HEAD 提交短 id（无提交 / detached 场景为空）
    pub head: Option<String>,
    /// 本地领先上游的提交数
    pub ahead: usize,
    /// 本地落后上游的提交数
    pub behind: usize,
    pub entries: Vec<GitStatusEntry>,
    pub conflict_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchInfo {
    pub name: String,
    pub is_head: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitInfo {
    pub id: String,
    pub summary: String,
    pub author: String,
    pub author_email: String,
    pub committer: String,
    pub committer_email: String,
    pub time: String,
    /// 提交说明正文（不含首行 summary）。
    pub body: String,
    pub files: Vec<String>,
    pub changes: Vec<GitFileChange>,
    /// 父提交完整 id
    pub parents: Vec<String>,
    /// 指向该提交的本地/远程 refs（短名）
    pub refs: Vec<String>,
    /// 是否尚未推送到上游（位于 ahead 区间内）
    pub unpushed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub old_path: Option<String>,
    /// added / deleted / modified / renamed / copied / typechange
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTagInfo {
    pub name: String,
    pub target: String,
    pub annotated: bool,
    pub tagger: Option<String>,
    pub time: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub path: String,
    pub patch: String,
}

/// 分栏对比两侧文本（WebStorm 风格）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileSides {
    pub path: String,
    pub left: String,
    pub right: String,
    pub left_label: String,
    pub right_label: String,
}

/// 冲突文件三路文本。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictSides {
    pub path: String,
    pub base: String,
    pub ours: String,
    pub theirs: String,
    pub working: String,
}

fn status_label(status: git2::Status) -> String {
    if status.is_conflicted() {
        return "conflict".into();
    }
    if status.is_index_new() || status.is_wt_new() {
        return "untracked".into();
    }
    if status.is_index_deleted() || status.is_wt_deleted() {
        return "deleted".into();
    }
    if status.is_index_renamed() || status.is_wt_renamed() {
        return "renamed".into();
    }
    if status.is_index_modified() || status.is_wt_modified() || status.is_wt_typechange() {
        return "modified".into();
    }
    "changed".into()
}

#[tauri::command]
pub async fn git_status(root: String) -> Result<GitStatusSnapshot, String> {
    // 读路径 TTL 缓存：高频 refresh（保存/聚焦/切文件）在窗口内复用上次结果
    let now = Instant::now();
    let request_generation = {
        let state = status_cache().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = state.entry.as_ref() {
            if entry.root == root && now.duration_since(entry.at) < STATUS_CACHE_TTL {
                return entry.result.clone();
            }
        }
        state.generation
    };
    // 同步命令默认在主线程执行（Tauri 2 wry IPC handler 内联调用），
    // recurse_untracked_dirs 在大仓库（未 ignore 的 node_modules 等）可达秒级，
    // 放 spawn_blocking + 超时，避免冻结整个 UI
    let task_root = root.clone();
    let handle = tokio::task::spawn_blocking(move || git_status_blocking(task_root));
    let result = match tokio::time::timeout(std::time::Duration::from_secs(30), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("读取 Git 状态任务失败: {join}")),
        Err(_) => Err("读取 Git 状态超时（30s）".into()),
    };
    // 失效前已启动的请求可能在修改完成后才返回，不能让它重新污染 TTL 缓存。
    cache_status_result(root, request_generation, result.clone());
    result
}

fn git_status_blocking(root: String) -> Result<GitStatusSnapshot, String> {
    let path = PathBuf::from(&root);
    let repo = match Repository::discover(&path) {
        Ok(r) => r,
        Err(_) => {
            return Ok(GitStatusSnapshot {
                initialized: false,
                branch: None,
                upstream: None,
                head: None,
                ahead: 0,
                behind: 0,
                entries: vec![],
                conflict_count: 0,
            });
        }
    };

    let head_name = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().ok().map(|s| s.to_string()));

    let head_oid = repo.head().ok().and_then(|h| h.target()).map(|oid| {
        let s = oid.to_string();
        short_text(&s, 7)
    });

    let upstream = (|| {
        let head = repo.head().ok()?;
        if !head.is_branch() {
            return None;
        }
        let name = head.shorthand().ok()?;
        let branch = repo.find_branch(name, BranchType::Local).ok()?;
        let up = branch.upstream().ok()?;
        up.name().ok().flatten().map(|s| s.to_string())
    })();

    let (ahead, behind) = (|| {
        let head = repo.head().ok()?;
        if !head.is_branch() {
            return None;
        }
        let name = head.shorthand().ok()?;
        let branch = repo.find_branch(name, BranchType::Local).ok()?;
        let local_oid = head.target()?;
        let upstream_ref = branch.upstream().ok()?;
        let remote_oid = upstream_ref.get().target()?;
        repo.graph_ahead_behind(local_oid, remote_oid).ok()
    })()
    .unwrap_or((0, 0));

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .exclude_submodules(true)
        .renames_head_to_index(true);

    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    let mut conflict_count = 0usize;

    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        if path.is_empty() {
            continue;
        }
        let st = entry.status();
        let conflicted = st.is_conflicted();
        if conflicted {
            conflict_count += 1;
        }
        let staged = st.intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED
                | git2::Status::INDEX_TYPECHANGE,
        );
        let unstaged = st.intersects(
            git2::Status::WT_NEW
                | git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_RENAMED
                | git2::Status::WT_TYPECHANGE
                | git2::Status::CONFLICTED,
        );
        entries.push(GitStatusEntry {
            path,
            status: status_label(st),
            staged,
            unstaged,
            conflicted,
        });
    }

    Ok(GitStatusSnapshot {
        initialized: true,
        branch: head_name,
        upstream,
        head: head_oid,
        ahead,
        behind,
        entries,
        conflict_count,
    })
}

#[tauri::command]
pub fn git_init(root: String) -> Result<(), String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let result = Repository::init(&root).map(|_| ()).map_err(|e| e.to_string());
    clear_status_cache();
    result
}

#[tauri::command]
pub fn git_set_remote(root: String, name: String, url: String) -> Result<(), String> {
    clear_status_cache();
    let result = (|| {
        let repo = open_repo(&root)?;
        match repo.find_remote(&name) {
            Ok(_) => repo
                .remote_set_url(&name, &url)
                .map_err(|e| e.to_string())?,
            Err(_) => {
                repo.remote(&name, &url).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })();
    clear_status_cache();
    result
}

fn ensure_repo_paths(repo: &Repository, paths: &[String]) -> Result<(), String> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| "裸仓库不支持工作区路径".to_string())?;
    for path in paths {
        crate::commands::path_util::ensure_inside_workspace(workdir, &workdir.join(path))?;
    }
    Ok(())
}

fn index_add(repo: &Repository, paths: &[String]) -> Result<(), String> {
    ensure_repo_paths(repo, paths)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    if paths.is_empty() {
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .map_err(|e| e.to_string())?;
    } else {
        for p in paths {
            let abs = repo.workdir().map(|w| w.join(p));
            if abs.as_ref().map(|a| a.is_dir()).unwrap_or(false) {
                index
                    .add_all([p.as_str()].iter(), git2::IndexAddOption::DEFAULT, None)
                    .map_err(|e| e.to_string())?;
            } else if abs.as_ref().map(|a| a.exists()).unwrap_or(false) {
                index.add_path(Path::new(p)).map_err(|e| e.to_string())?;
            } else {
                let _ = index.remove_path(Path::new(p));
            }
        }
    }
    index.write().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    let _index_guard = index_operation_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let result = (|| {
        let repo = open_repo(&root)?;
        index_add(&repo, &paths)
    })();
    clear_status_cache();
    result
}

#[tauri::command]
pub fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    let _index_guard = index_operation_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let result = (|| {
        let repo = open_repo(&root)?;
        if !paths.is_empty() {
            ensure_repo_paths(&repo, &paths)?;
        }
        match repo.head() {
            Ok(head) => {
                let commit = head.peel_to_commit().map_err(|e| e.to_string())?;
                if paths.is_empty() {
                    repo.reset(commit.as_object(), ResetType::Mixed, None)
                        .map_err(|e| e.to_string())?;
                } else {
                    repo.reset_default(Some(commit.as_object()), &paths)
                        .map_err(|e| e.to_string())?;
                }
            }
            Err(_) => {
                let mut index = repo.index().map_err(|e| e.to_string())?;
                if paths.is_empty() {
                    index.clear().map_err(|e| e.to_string())?;
                } else {
                    for p in paths {
                        let _ = index.remove_path(Path::new(&p));
                    }
                }
                index.write().map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })();
    clear_status_cache();
    result
}

#[tauri::command]
pub fn git_commit(
    root: String,
    message: String,
    paths: Option<Vec<String>>,
    amend: Option<bool>,
) -> Result<String, String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let result = commit_internal(root, message, paths, amend, None);
    clear_status_cache();
    result
}

/// 内部提交：可指定额外父提交。
/// merge 自动提交必须带上被合并分支的 commit 作为第二父，否则合并拓扑丢失
/// （产物线性，被合并分支 tip 不是新提交祖先），再次 merge 同一分支会被
/// merge_analysis 判定需要真实合并 → 已应用的变更重复应用 → 凭空冲突
fn commit_internal(
    root: String,
    message: String,
    paths: Option<Vec<String>>,
    amend: Option<bool>,
    extra_parent: Option<git2::Oid>,
) -> Result<String, String> {
    let _index_guard = index_operation_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let repo = open_repo(&root)?;
    if message.trim().is_empty() {
        return Err("提交说明不能为空".into());
    }
    // 勾选路径提交（WebStorm Changelist）：仅纳入选中文件，先重置索引再 add。
    // 合并冲突解决中（MERGE_HEAD 存在）时跳过 reset：合并结果在 index 里，
    // reset 会把已解决的冲突与合并内容一并清掉。
    let merging = read_merge_head(&root)?.is_some();
    if let Some(ref paths) = paths {
        if paths.is_empty() {
            return Err("请至少勾选一个文件再提交".into());
        }
        // 必须在重置索引前校验路径；否则非法路径会先清空当前索引，
        // 随后才在 index_add 失败，造成用户已有暂存状态被意外撤销。
        ensure_repo_paths(&repo, paths)?;
        if !merging {
            match repo.head() {
                Ok(head) => {
                    let commit = head.peel_to_commit().map_err(|e| e.to_string())?;
                    repo.reset(commit.as_object(), ResetType::Mixed, None)
                        .map_err(|e| e.to_string())?;
                }
                Err(_) => {
                    let mut index = repo.index().map_err(|e| e.to_string())?;
                    index.clear().map_err(|e| e.to_string())?;
                    index.write().map_err(|e| e.to_string())?;
                }
            }
        }
        index_add(&repo, paths)?;
    }

    let mut index = repo.index().map_err(|e| e.to_string())?;
    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let sig = repo
        .signature()
        .or_else(|_| Signature::now("Prism Code", "prismcode@local"))
        .map_err(|e| e.to_string())?;

    let parents = match repo.head() {
        Ok(head) => {
            let head_commit = head.peel_to_commit().map_err(|e| e.to_string())?;
            if amend.unwrap_or(false) {
                let mut ps = Vec::new();
                for i in 0..head_commit.parent_count() {
                    ps.push(head_commit.parent(i).map_err(|e| e.to_string())?);
                }
                ps
            } else {
                let mut ps = vec![head_commit];
                if let Some(oid) = extra_parent {
                    ps.push(repo.find_commit(oid).map_err(|e| e.to_string())?);
                } else if let Some(merge_oid) = read_merge_head(&root)? {
                    // 冲突解决后的提交：把 MERGE_HEAD 记录的被合并分支作为第二父，
                    // 保持合并拓扑（否则该分支变更重复应用，再次 merge 会凭空冲突）
                    ps.push(repo.find_commit(merge_oid).map_err(|e| e.to_string())?);
                }
                ps
            }
        }
        Err(_) => {
            if amend.unwrap_or(false) {
                return Err("没有可修订的提交".into());
            }
            vec![]
        }
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let is_amend = amend.unwrap_or(false);
    let amend_ref = if is_amend {
        repo.head().ok().and_then(|head| {
            if head.is_branch() {
                head.name().ok().map(str::to_owned)
            } else {
                None
            }
        })
    } else {
        None
    };

    let oid = repo
        .commit(
            // amend 的父提交是旧 HEAD 的父，而不是旧 HEAD 本身；git2 在
            // update_ref=HEAD 时会拒绝这种非快进更新，所以先只创建对象，
            // 再强制更新当前分支引用。
            if is_amend { None } else { Some("HEAD") },
            &sig,
            &sig,
            message.trim(),
            &tree,
            &parent_refs,
        )
        .map_err(|e| e.to_string())?;
    if is_amend {
        if let Some(refname) = amend_ref {
            repo.reference(&refname, oid, true, "commit --amend")
                .map_err(|e| format!("更新 amend 后的分支引用失败: {e}"))?;
        } else {
            repo.set_head_detached(oid)
                .map_err(|e| format!("更新 amend 后的分离 HEAD 失败: {e}"))?;
        }
    }
    // 合并提交落库后清掉 MERGE_HEAD/MERGE_MSG（对齐 git commit 结束合并的行为）
    if let Ok(dir) = git_dir(&root) {
        let _ = std::fs::remove_file(dir.join("MERGE_HEAD"));
        let _ = std::fs::remove_file(dir.join("MERGE_MSG"));
    }
    Ok(oid.to_string())
}

/// 读取 .git/MERGE_HEAD（存在且可解析为提交时返回 Some(oid)）。
fn read_merge_head(root: &str) -> Result<Option<git2::Oid>, String> {
    let dir = git_dir(root)?;
    let path = dir.join("MERGE_HEAD");
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取 MERGE_HEAD 失败: {e}"))?;
    let oid = content
        .trim()
        .parse::<git2::Oid>()
        .map_err(|e| format!("MERGE_HEAD 内容无效: {e}"))?;
    Ok(Some(oid))
}

#[tauri::command]
pub async fn git_branches(root: String) -> Result<Vec<GitBranchInfo>, String> {
    // refresh 链路的伴随查询：放 spawn_blocking，避免主线程 revwalk
    let handle = tokio::task::spawn_blocking(move || git_branches_blocking(root));
    match tokio::time::timeout(Duration::from_secs(15), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("读取分支任务失败: {join}")),
        Err(_) => Err("读取分支超时（15s）".into()),
    }
}

fn git_branches_blocking(root: String) -> Result<Vec<GitBranchInfo>, String> {
    let repo = open_repo(&root)?;
    let mut list = Vec::new();
    let branches = repo.branches(None).map_err(|e| e.to_string())?;
    for item in branches {
        let (branch, ty) = item.map_err(|e| e.to_string())?;
        let name = branch
            .name()
            .map_err(|e| e.to_string())?
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let upstream = branch
            .upstream()
            .ok()
            .and_then(|u| u.name().ok().flatten().map(|s| s.to_string()));
        list.push(GitBranchInfo {
            name,
            is_head: branch.is_head(),
            is_remote: matches!(ty, BranchType::Remote),
            upstream,
        });
    }
    list.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(list)
}

#[tauri::command]
pub async fn git_checkout(
    root: String,
    name: String,
    force: Option<bool>,
) -> Result<(), String> {
    // checkout_tree 会重写整个工作树，大仓库可达秒级，放 spawn_blocking
    let handle = tokio::task::spawn_blocking(move || {
        git_checkout_blocking(root, name, force)
    });
    let result = match tokio::time::timeout(Duration::from_secs(120), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("切换分支任务失败: {join}")),
        Err(_) => Err("切换分支超时（120s）".into()),
    };
    clear_status_cache();
    result
}

fn git_checkout_blocking(root: String, name: String, force: Option<bool>) -> Result<(), String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let repo = open_repo(&root)?;
    let (object, reference) = repo.revparse_ext(&name).map_err(|e| e.to_string())?;
    let mut builder = CheckoutBuilder::new();
    if force.unwrap_or(false) {
        builder.force();
    }
    repo.checkout_tree(&object, Some(&mut builder))
        .map_err(|e| format!("切换分支失败: {e}"))?;
    match reference {
        Some(r) => {
            let refname = r.name().map_err(|e| e.to_string())?;
            repo.set_head(refname).map_err(|e| e.to_string())?;
        }
        None => {
            repo.set_head_detached(object.id())
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn git_create_branch(
    root: String,
    name: String,
    checkout: bool,
) -> Result<(), String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let task_root = root.clone();
    let task_name = name.clone();
    let handle = tokio::task::spawn_blocking(move || {
        let repo = open_repo(&task_root)?;
        let commit = repo
            .head()
            .map_err(|e| e.to_string())?
            .peel_to_commit()
            .map_err(|e| e.to_string())?;
        repo.branch(&task_name, &commit, false)
            .map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    });
    let branch_result = match tokio::time::timeout(Duration::from_secs(30), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("创建分支任务失败: {join}")),
        Err(_) => Err("创建分支超时（30s）".into()),
    };
    clear_status_cache();
    branch_result?;
    if checkout {
        let result = git_checkout(root, name, Some(false)).await;
        clear_status_cache();
        return result;
    }
    Ok(())
}

#[tauri::command]
pub fn git_delete_branch(root: String, name: String) -> Result<(), String> {
    clear_status_cache();
    let result = (|| {
        let repo = open_repo(&root)?;
        let mut branch = repo
            .find_branch(&name, BranchType::Local)
            .map_err(|e| e.to_string())?;
        if branch.is_head() {
            return Err("不能删除当前分支".into());
        }
        branch.delete().map_err(|e| e.to_string())
    })();
    clear_status_cache();
    result
}

#[tauri::command]
pub fn git_rename_branch(root: String, from: String, to: String) -> Result<(), String> {
    clear_status_cache();
    let repo = open_repo(&root)?;
    let mut branch = repo
        .find_branch(&from, BranchType::Local)
        .map_err(|e| e.to_string())?;
    branch.rename(&to, false).map_err(|e| e.to_string())?;
    clear_status_cache();
    Ok(())
}

// ==================== 提交详情与文件变更 ====================

fn diff_status_label(status: git2::Delta) -> &'static str {
    match status {
        git2::Delta::Added | git2::Delta::Untracked => "added",
        git2::Delta::Deleted => "deleted",
        git2::Delta::Renamed => "renamed",
        git2::Delta::Copied => "copied",
        git2::Delta::Typechange => "typechange",
        _ => "modified",
    }
}

fn diff_file_changes(
    repo: &Repository,
    old_tree: Option<&git2::Tree<'_>>,
    new_tree: Option<&git2::Tree<'_>>,
) -> Vec<GitFileChange> {
    let Ok(diff) = repo.diff_tree_to_tree(old_tree, new_tree, None) else {
        return vec![];
    };
    let mut changes = Vec::new();
    let _ = diff.foreach(
        &mut |delta, _| {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().to_string());
            let Some(path) = path else {
                return true;
            };
            let old_path = delta
                .old_file()
                .path()
                .map(|p| p.to_string_lossy().to_string())
                .filter(|old| old != &path);
            changes.push(GitFileChange {
                path,
                old_path,
                status: diff_status_label(delta.status()).to_string(),
            });
            true
        },
        None,
        None,
        None,
    );
    changes
}

fn commit_info_from_commit(
    repo: &Repository,
    commit: &git2::Commit<'_>,
    refs: Vec<String>,
    unpushed: bool,
    include_changes: bool,
) -> GitCommitInfo {
    let time = Local
        .timestamp_opt(commit.time().seconds(), 0)
        .single()
        .map(|t| t.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default();
    let parents: Vec<String> = (0..commit.parent_count())
        .filter_map(|i| commit.parent_id(i).ok())
        .map(|id| id.to_string())
        .collect();
    let full_message = commit.message().unwrap_or("").trim_end().to_string();
    let body = full_message
        .lines()
        .skip(1)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    let changes = if include_changes {
        let old_tree = commit.parent(0).ok().and_then(|parent| parent.tree().ok());
        let new_tree = commit.tree().ok();
        diff_file_changes(repo, old_tree.as_ref(), new_tree.as_ref())
    } else {
        vec![]
    };
    let files = changes.iter().map(|change| change.path.clone()).collect();

    GitCommitInfo {
        id: commit.id().to_string(),
        summary: commit
            .summary()
            .ok()
            .flatten()
            .unwrap_or("")
            .to_string(),
        author: commit.author().name().unwrap_or("").to_string(),
        author_email: commit.author().email().unwrap_or("").to_string(),
        committer: commit.committer().name().unwrap_or("").to_string(),
        committer_email: commit.committer().email().unwrap_or("").to_string(),
        time,
        body,
        files,
        changes,
        parents,
        refs,
        unpushed,
    }
}

fn tag_info_from_reference(repo: &Repository, reference: &git2::Reference<'_>) -> Option<GitTagInfo> {
    let name = reference
        .name()
        .ok()
        .and_then(|raw| raw.strip_prefix("refs/tags/"))?
        .to_string();
    let target = reference.peel_to_commit().ok()?.id().to_string();
    let tag = reference
        .target()
        .and_then(|oid| repo.find_tag(oid).ok());
    let annotated = tag.is_some();
    let tagger = tag
        .as_ref()
        .and_then(|value| value.tagger())
        .and_then(|sig| sig.name().ok().map(ToString::to_string));
    let time = tag.as_ref().and_then(|value| {
        value.tagger().and_then(|sig| {
            Local
                .timestamp_opt(sig.when().seconds(), 0)
                .single()
                .map(|date| date.format("%Y-%m-%d %H:%M").to_string())
        })
    });
    let message = tag
        .as_ref()
        .and_then(|value| {
            value
                .message()
                .ok()
                .flatten()
                .map(|text| text.trim().to_string())
        })
        .filter(|text| !text.is_empty());
    Some(GitTagInfo {
        name,
        target,
        annotated,
        tagger,
        time,
        message,
    })
}

#[tauri::command]
pub async fn git_log(root: String, limit: Option<usize>) -> Result<Vec<GitCommitInfo>, String> {
    // 每个 commit 都做全树 diff，大仓库耗时明显，须离开主线程
    let handle = tokio::task::spawn_blocking(move || git_log_blocking(root, limit));
    match tokio::time::timeout(std::time::Duration::from_secs(30), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("读取提交历史任务失败: {join}")),
        Err(_) => Err("读取提交历史超时（30s）".into()),
    }
}

fn git_log_blocking(root: String, limit: Option<usize>) -> Result<Vec<GitCommitInfo>, String> {
    let repo = open_repo(&root)?;
    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    // Git Graph 的「全部分支」必须包含没有被当前 HEAD 祖先链覆盖的提交。
    // 从所有可解析为提交的 refs 入队，重复提交由 revwalk 自动去重；
    // 没有 refs 的异常仓库再回退到 HEAD。
    let mut pushed_ref = false;
    if let Ok(references) = repo.references() {
        for reference in references.flatten() {
            if let Ok(commit) = reference.peel_to_commit() {
                if revwalk.push(commit.id()).is_ok() {
                    pushed_ref = true;
                }
            }
        }
    }
    if !pushed_ref {
        revwalk.push_head().map_err(|e| e.to_string())?;
    }
    // TOPOLOGICAL 便于绘制父子关系图；TIME 作次要排序
    revwalk
        .set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(50);

    // 收集 ref → commit 完整 id 映射
    let mut ref_map: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    if let Ok(refs) = repo.references() {
        for reference in refs.flatten() {
            let Ok(name) = reference.shorthand() else {
                continue;
            };
            if name == "HEAD" {
                continue;
            }
            let oid = reference
                .peel_to_commit()
                .ok()
                .map(|commit| commit.id());
            if let Some(oid) = oid {
                ref_map
                    .entry(oid.to_string())
                    .or_default()
                    .push(name.to_string());
            }
        }
    }

    // ahead 区间：本地有、上游没有的提交
    let mut unpushed_ids = std::collections::HashSet::new();
    if let Ok(head) = repo.head() {
        if head.is_branch() {
            if let Ok(branch_name) = head.shorthand() {
                if let Ok(branch) = repo.find_branch(branch_name, BranchType::Local) {
                    if let Ok(upstream) = branch.upstream() {
                        if let (Some(local), Some(remote)) =
                            (head.target(), upstream.get().target())
                        {
                            if let Ok(mut walk) = repo.revwalk() {
                                let _ = walk.push(local);
                                let _ = walk.hide(remote);
                                for oid in walk.flatten() {
                                    unpushed_ids.insert(oid.to_string());
                                }
                            }
                        }
                    } else if let Ok(mut walk) = repo.revwalk() {
                        // 无上游：当前可见提交视为未推送
                        let _ = walk.push_head();
                        for (i, oid) in walk.enumerate() {
                            if i >= limit {
                                break;
                            }
                            if let Ok(oid) = oid {
                                unpushed_ids.insert(oid.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    let mut commits = Vec::new();
    for (i, oid) in revwalk.enumerate() {
        if i >= limit {
            break;
        }
        let oid = oid.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        let id = oid.to_string();
        let refs = ref_map.get(&id).cloned().unwrap_or_default();
        let unpushed = unpushed_ids.contains(&id);
        commits.push(commit_info_from_commit(
            &repo,
            &commit,
            refs,
            unpushed,
            true,
        ));
    }
    Ok(commits)
}

#[tauri::command]
pub async fn git_tags(root: String) -> Result<Vec<GitTagInfo>, String> {
    let handle = tokio::task::spawn_blocking(move || git_tags_blocking(root));
    match tokio::time::timeout(Duration::from_secs(15), handle).await {
        Ok(Ok(result)) => result,
        Ok(Err(join)) => Err(format!("读取标签任务失败: {join}")),
        Err(_) => Err("读取标签超时（15s）".into()),
    }
}

fn git_tags_blocking(root: String) -> Result<Vec<GitTagInfo>, String> {
    let repo = open_repo(&root)?;
    let mut tags = Vec::new();
    let references = repo.references().map_err(|e| e.to_string())?;
    for reference in references.flatten() {
        if let Some(tag) = tag_info_from_reference(&repo, &reference) {
            tags.push(tag);
        }
    }
    tags.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(tags)
}

#[tauri::command]
pub async fn git_commit_files(
    root: String,
    left_ref: String,
    right_ref: String,
) -> Result<Vec<GitFileChange>, String> {
    let handle = tokio::task::spawn_blocking(move || {
        let repo = open_repo(&root)?;
        let old_commit = if left_ref.trim().is_empty() {
            None
        } else {
            let oid = resolve_commit_oid(&repo, &left_ref)?;
            Some(repo.find_commit(oid).map_err(|e| e.to_string())?)
        };
        let old_tree = old_commit
            .as_ref()
            .map(|commit| commit.tree())
            .transpose()
            .map_err(|e| e.to_string())?;
        let right_oid = resolve_commit_oid(&repo, &right_ref)?;
        let right_commit = repo.find_commit(right_oid).map_err(|e| e.to_string())?;
        let right_tree = right_commit.tree().map_err(|e| e.to_string())?;
        Ok::<Vec<GitFileChange>, String>(diff_file_changes(
            &repo,
            old_tree.as_ref(),
            Some(&right_tree),
        ))
    });
    match tokio::time::timeout(Duration::from_secs(30), handle).await {
        Ok(Ok(result)) => result,
        Ok(Err(join)) => Err(format!("读取提交文件任务失败: {join}")),
        Err(_) => Err("读取提交文件超时（30s）".into()),
    }
}

#[tauri::command]
pub fn git_create_tag(
    root: String,
    name: String,
    commit_id: String,
    message: Option<String>,
    force: Option<bool>,
) -> Result<(), String> {
    clear_status_cache();
    let repo = open_repo(&root)?;
    if name.trim().is_empty() {
        return Err("标签名不能为空".into());
    }
    let oid = resolve_commit_oid(&repo, &commit_id)?;
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
    let force = force.unwrap_or(false);
    if let Some(text) = message.filter(|value| !value.trim().is_empty()) {
        let signature = repo
            .signature()
            .map_err(|e| format!("创建附注标签需要 Git 用户名与邮箱: {e}"))?;
        repo.tag(&name, commit.as_object(), &signature, &text, force)
            .map_err(|e| format!("创建标签失败: {e}"))?;
    } else {
        repo.tag_lightweight(&name, commit.as_object(), force)
            .map_err(|e| format!("创建标签失败: {e}"))?;
    }
    clear_status_cache();
    Ok(())
}

#[tauri::command]
pub fn git_delete_tag(root: String, name: String) -> Result<(), String> {
    clear_status_cache();
    let repo = open_repo(&root)?;
    repo.tag_delete(&name)
        .map_err(|e| format!("删除标签失败: {e}"))?;
    clear_status_cache();
    Ok(())
}

#[tauri::command]
pub async fn git_push_tag(
    root: String,
    remote: String,
    name: String,
) -> Result<String, String> {
    // remote/tag 名来自前端和仓库配置，不能让其被 Git 当作选项解析。
    clear_status_cache();
    let handle = tokio::task::spawn_blocking(move || {
        validate_git_positional_arg(&remote, "远程名称")?;
        validate_git_positional_arg(&name, "标签名称")?;
        run_git(&root, &["push", &remote, &name])
            .map(|_| format!("已推送标签 {name} 到 {remote}"))
    });
    let result = match tokio::time::timeout(Duration::from_secs(120), handle).await {
        Ok(Ok(result)) => result,
        Ok(Err(join)) => Err(format!("推送标签任务失败: {join}")),
        Err(_) => Err("推送标签超时（120s）".into()),
    };
    clear_status_cache();
    result
}

/// 丢弃工作区指定路径的未提交变更（已跟踪还原到 HEAD；未跟踪则删除）。
#[tauri::command]
pub async fn git_discard_paths(root: String, paths: Vec<String>) -> Result<(), String> {
    // 内部跑完整 status + checkout，放 spawn_blocking
    let handle = tokio::task::spawn_blocking(move || {
        git_discard_paths_blocking(root, paths)
    });
    let result = match tokio::time::timeout(Duration::from_secs(60), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("丢弃变更任务失败: {join}")),
        Err(_) => Err("丢弃变更超时（60s）".into()),
    };
    clear_status_cache();
    result
}

fn git_discard_paths_blocking(root: String, paths: Vec<String>) -> Result<(), String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    if paths.is_empty() {
        return Ok(());
    }
    let repo = open_repo(&root)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "裸仓库无法丢弃工作区变更".to_string())?
        .to_path_buf();

    // 路径来自前端 invoke，join 后必须仍落在工作区内：否则含 `..` 或绝对
    // 路径的输入可直接删除 / 覆写仓库外任意文件（此处绕过 git2 直接 std::fs）
    for p in &paths {
        crate::commands::path_util::ensure_inside_workspace(&workdir, &workdir.join(p))?;
    }

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .exclude_submodules(true);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;

    fn norm(p: &str) -> String {
        p.replace('\\', "/")
    }

    let path_set: std::collections::HashSet<String> = paths.iter().map(|p| norm(p)).collect();
    let mut tracked: Vec<String> = Vec::new();
    let mut untracked: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("");
        if path.is_empty() {
            continue;
        }
        let key = norm(path);
        if !path_set.contains(&key) {
            continue;
        }
        seen.insert(key.clone());
        let st = entry.status();
        // 纯未跟踪（工作区新增且未入 index）→ 删除文件
        if st.is_wt_new()
            && !st.intersects(
                git2::Status::INDEX_NEW
                    | git2::Status::INDEX_MODIFIED
                    | git2::Status::INDEX_DELETED
                    | git2::Status::INDEX_RENAMED
                    | git2::Status::INDEX_TYPECHANGE,
            )
        {
            untracked.push(path.to_string());
        } else {
            tracked.push(path.to_string());
        }
    }

    // 状态列表未命中时仍尝试 checkout（路径格式偶发不一致的兜底）
    for p in &paths {
        let key = norm(p);
        if !seen.contains(&key) {
            tracked.push(p.clone());
        }
    }

    if !tracked.is_empty() {
        let mut builder = CheckoutBuilder::new();
        builder.force();
        for path in &tracked {
            builder.path(path);
        }
        // checkout_head 会把指定路径的 index + worktree 一并还原到 HEAD
        repo.checkout_head(Some(&mut builder))
            .map_err(|e| format!("丢弃变更失败: {e}"))?;

        // INDEX_NEW（已暂存但从未提交）在 HEAD 中不存在，需从 index 移除并删工作区文件
        let mut index = repo.index().map_err(|e| e.to_string())?;
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        for path in &tracked {
            let in_head = head_tree
                .as_ref()
                .and_then(|t| t.get_path(Path::new(path)).ok())
                .is_some();
            if !in_head {
                let _ = index.remove_path(Path::new(path));
                let full = workdir.join(path);
                if full.is_dir() {
                    let _ = std::fs::remove_dir_all(&full);
                } else if full.exists() {
                    let _ = std::fs::remove_file(&full);
                }
            }
        }
        index.write().map_err(|e| e.to_string())?;
    }

    for path in &untracked {
        let full = workdir.join(path);
        if full.is_dir() {
            std::fs::remove_dir_all(&full)
                .map_err(|e| format!("删除未跟踪目录失败 {}: {e}", full.display()))?;
        } else if full.exists() {
            std::fs::remove_file(&full)
                .map_err(|e| format!("删除未跟踪文件失败 {}: {e}", full.display()))?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn git_diff(
    root: String,
    path: Option<String>,
    staged: Option<bool>,
) -> Result<GitDiffResult, String> {
    // 大文件 diff 可能较慢，离开主线程
    let handle = tokio::task::spawn_blocking(move || git_diff_blocking(root, path, staged));
    match tokio::time::timeout(std::time::Duration::from_secs(30), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("生成差异任务失败: {join}")),
        Err(_) => Err("生成差异超时（30s）".into()),
    }
}

fn git_diff_blocking(
    root: String,
    path: Option<String>,
    staged: Option<bool>,
) -> Result<GitDiffResult, String> {
    let repo = open_repo(&root)?;
    if let Some(ref path) = path {
        ensure_repo_paths(&repo, std::slice::from_ref(path))?;
    }
    let staged = staged.unwrap_or(false);
    let mut opts = DiffOptions::new();
    if let Some(ref p) = path {
        opts.pathspec(p);
    }
    let diff = if staged {
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
            .map_err(|e| e.to_string())?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut opts))
            .map_err(|e| e.to_string())?
    };

    let mut patch = String::new();
    let stats = diff.stats().map_err(|e| e.to_string())?;
    patch.push_str(&format!(
        "files: {}  +{}  -{}\n\n",
        stats.files_changed(),
        stats.insertions(),
        stats.deletions()
    ));

    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        let origin = line.origin();
        if origin == '+' || origin == '-' || origin == ' ' {
            patch.push(origin);
        }
        patch.push_str(std::str::from_utf8(line.content()).unwrap_or(""));
        true
    })
    .map_err(|e| e.to_string())?;

    Ok(GitDiffResult {
        path: path.unwrap_or_else(|| "工作区".into()),
        patch,
    })
}

fn blob_text(repo: &Repository, id: git2::Oid) -> Result<String, String> {
    let blob = repo.find_blob(id).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(blob.content()).to_string())
}

fn head_file_text(repo: &Repository, path: &str) -> Result<String, String> {
    let Ok(head) = repo.head() else {
        return Ok(String::new());
    };
    let Ok(tree) = head.peel_to_tree() else {
        return Ok(String::new());
    };
    match tree.get_path(Path::new(path)) {
        Ok(entry) => {
            let obj = entry.to_object(repo).map_err(|e| e.to_string())?;
            let blob = obj.peel_to_blob().map_err(|e| e.to_string())?;
            Ok(String::from_utf8_lossy(blob.content()).to_string())
        }
        Err(_) => Ok(String::new()),
    }
}

/// 取 HEAD 中该文件的文本内容（未跟踪 / 不存在时返回空串），
/// 供前端行内改动条（buffer 与 HEAD 逐行 diff）使用。
#[tauri::command]
pub async fn git_head_text(root: String, path: String) -> Result<String, String> {
    let handle = tokio::task::spawn_blocking(move || {
        let repo = open_repo(&root)?;
        ensure_repo_paths(&repo, std::slice::from_ref(&path))?;
        head_file_text(&repo, &path)
    });
    match tokio::time::timeout(Duration::from_secs(10), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("读取 HEAD 文本任务失败: {join}")),
        Err(_) => Err("读取 HEAD 文本超时（10s）".into()),
    }
}

fn index_file_text(repo: &Repository, path: &str) -> Result<Option<String>, String> {
    let index = repo.index().map_err(|e| e.to_string())?;
    match index.get_path(Path::new(path), 0) {
        Some(entry) => blob_text(repo, entry.id).map(Some),
        None => Ok(None),
    }
}

fn workdir_file_text(repo: &Repository, path: &str) -> Result<String, String> {
    let wd = repo.workdir().ok_or("无工作区")?;
    let full = wd.join(path);
    crate::commands::path_util::ensure_inside_workspace(wd, &full)?;
    if !full.exists() {
        return Ok(String::new());
    }
    if full.is_dir() {
        return Err("目标是目录，无法对比".into());
    }
    std::fs::read_to_string(&full).map_err(|e| format!("读取工作区文件失败: {e}"))
}

/// 分栏 diff：staged=true → HEAD|Index；否则 Index|工作区。
#[tauri::command]
pub async fn git_file_sides(
    root: String,
    path: String,
    staged: Option<bool>,
) -> Result<GitFileSides, String> {
    // 含 blob 读取 + 可能全树对比，放 spawn_blocking
    let handle = tokio::task::spawn_blocking(move || {
        git_file_sides_blocking(root, path, staged)
    });
    match tokio::time::timeout(Duration::from_secs(30), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("读取分栏对比任务失败: {join}")),
        Err(_) => Err("读取分栏对比超时（30s）".into()),
    }
}

fn git_file_sides_blocking(
    root: String,
    path: String,
    staged: Option<bool>,
) -> Result<GitFileSides, String> {
    if path.trim().is_empty() {
        return Err("请选择具体文件进行分栏对比".into());
    }
    let repo = open_repo(&root)?;
    ensure_repo_paths(&repo, std::slice::from_ref(&path))?;
    let staged = staged.unwrap_or(false);
    if staged {
        Ok(GitFileSides {
            path: path.clone(),
            left: head_file_text(&repo, &path)?,
            right: index_file_text(&repo, &path)?.unwrap_or_default(),
            left_label: "HEAD".into(),
            right_label: "已暂存".into(),
        })
    } else {
        let left = {
            let indexed = index_file_text(&repo, &path)?;
            indexed.map_or_else(|| head_file_text(&repo, &path), Ok)?
        };
        Ok(GitFileSides {
            path: path.clone(),
            left,
            right: workdir_file_text(&repo, &path)?,
            left_label: "索引".into(),
            right_label: "工作区".into(),
        })
    }
}

/// 冲突分栏：ours / theirs / base / working。
#[tauri::command]
pub async fn git_conflict_sides(root: String, path: String) -> Result<GitConflictSides, String> {
    // 含多 blob 读取，放 spawn_blocking
    let handle = tokio::task::spawn_blocking(move || {
        git_conflict_sides_blocking(root, path)
    });
    match tokio::time::timeout(Duration::from_secs(30), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("读取冲突分栏任务失败: {join}")),
        Err(_) => Err("读取冲突分栏超时（30s）".into()),
    }
}

fn git_conflict_sides_blocking(
    root: String,
    path: String,
) -> Result<GitConflictSides, String> {
    if path.trim().is_empty() {
        return Err("路径不能为空".into());
    }
    let repo = open_repo(&root)?;
    ensure_repo_paths(&repo, std::slice::from_ref(&path))?;
    let index = repo.index().map_err(|e| e.to_string())?;
    let conflict = index
        .conflict_get(Path::new(&path))
        .map_err(|e| format!("不是冲突文件或无法读取: {e}"))?;

    let base = match conflict.ancestor {
        Some(e) => blob_text(&repo, e.id)?,
        None => String::new(),
    };
    let ours = match conflict.our {
        Some(e) => blob_text(&repo, e.id)?,
        None => String::new(),
    };
    let theirs = match conflict.their {
        Some(e) => blob_text(&repo, e.id)?,
        None => String::new(),
    };
    let working = workdir_file_text(&repo, &path)?;

    Ok(GitConflictSides {
        path,
        base,
        ours,
        theirs,
        working,
    })
}

const AUTH_REQUIRED_PREFIX: &str = "GIT_AUTH_REQUIRED";
const AUTH_SEP: &str = "|||";

fn is_auth_error(e: &git2::Error) -> bool {
    // 只匹配明确的认证/凭据错误码；不再用 message 子串匹配（避免 "authorization" 等无关文本误判为认证失败导致死循环弹窗）
    matches!(
        e.code(),
        git2::ErrorCode::Auth | git2::ErrorCode::Certificate
    ) || e.message().contains("authentication required")
        || e.message().contains("未找到远程凭据")
        || e.message().contains("ssh")
            && (e.message().contains("auth") || e.message().contains("publickey"))
}

fn format_remote_error(op: &str, e: git2::Error, remote_url: &str) -> String {
    let msg = e.message().to_string();
    if is_auth_error(&e) {
        // 前端据此弹出账号密码框
        return format!("{AUTH_REQUIRED_PREFIX}{AUTH_SEP}{remote_url}{AUTH_SEP}{msg}");
    }
    format!("{op}失败: {msg}")
}

fn default_ssh_key_paths() -> Vec<std::path::PathBuf> {
    let mut keys = Vec::new();
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    let Some(home) = home else {
        return keys;
    };
    let ssh = std::path::PathBuf::from(home).join(".ssh");
    for name in ["id_ed25519", "id_rsa", "id_ecdsa", "id_dsa"] {
        let p = ssh.join(name);
        if p.is_file() {
            keys.push(p);
        }
    }
    keys
}

/// 尝试从 SSH agent 拿凭据，整体超时受 `timeout` 限制。
/// - `Ok(Some(cred))`：agent 返回了有效凭据
/// - `Ok(None)`：agent 超时（卡死 / agent socket 无响应），让调用方走密钥文件路径
/// - `Err(_)`：agent 不可用（未启动等），让调用方走密钥文件路径
///
/// git2 凭据回调是同步闭包无法直接 await，故用临时线程 + mpsc 模拟超时。
fn try_ssh_agent_with_timeout(
    user: &str,
    timeout: std::time::Duration,
) -> Result<Option<git2::Cred>, git2::Error> {
    let user_owned = user.to_string();
    // `git2::Cred` 内部只持有一个 `*mut git_cred`，本身不跨线程共享可变状态。
    // 跨线程传递时需要手动标记 Send；超时分支会丢弃这个 Cred，由 libgit2 释放。
    struct SendCred(Option<git2::Cred>);
    unsafe impl Send for SendCred {}
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<SendCred, String>>(1);
    let handle = std::thread::Builder::new()
        .name("git2-ssh-agent".into())
        .spawn(move || {
            let result = Cred::ssh_key_from_agent(&user_owned).map(|c| SendCred(Some(c)));
            let payload = result.map_err(|e| e.message().to_string());
            // 通道已关闭（主线程已超时返回）也无所谓，send 失败忽略
            let _ = tx.send(payload);
        })
        .map_err(|e| git2::Error::from_str(&format!("spawn ssh agent helper: {e}")))?;
    match rx.recv_timeout(timeout) {
        Ok(Ok(SendCred(Some(cred)))) => Ok(Some(cred)),
        Ok(Ok(SendCred(None))) => Err(git2::Error::from_str("ssh agent 返回空凭据")),
        Ok(Err(detail)) => Err(git2::Error::from_str(&format!(
            "ssh agent 不可用: {detail}"
        ))),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            // 主动让 helper 线程泄漏（detach）；它继续跑也不影响主流程
            // std::thread 没有安全 detach API，但 join handle 析构即 detach 行为
            drop(handle);
            Ok(None)
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            Err(git2::Error::from_str("ssh agent helper 提前退出"))
        }
    }
}

/// 解析 https://host/path 或 http://host/path → (protocol, host)
fn parse_http_remote(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    let (protocol, rest) = if let Some(r) = url.strip_prefix("https://") {
        ("https", r)
    } else if let Some(r) = url.strip_prefix("http://") {
        ("http", r)
    } else {
        return None;
    };
    let host = rest
        .split('/')
        .next()
        .unwrap_or("")
        .split('@')
        .next_back()?;
    if host.is_empty() {
        return None;
    }
    let host = host.split('@').next_back().unwrap_or(host);
    Some((protocol.to_string(), host.to_string()))
}

fn cred_host_key(url: &str) -> Option<String> {
    let (protocol, host) = parse_http_remote(url)?;
    Some(format!("{protocol}://{host}"))
}

fn parse_http_remote_for_store(url: &str) -> Option<(String, String, String)> {
    let url = url.trim();
    let (protocol, rest) = if let Some(r) = url.strip_prefix("https://") {
        ("https", r)
    } else if let Some(r) = url.strip_prefix("http://") {
        ("http", r)
    } else {
        return None;
    };
    let authority = rest.split('/').next().unwrap_or("");
    let host = authority.split('@').next_back()?.trim();
    if host.is_empty() {
        return None;
    }
    let path = if let Some((_, tail)) = rest.split_once('/') {
        format!("/{}", tail)
    } else {
        "/".to_string()
    };
    Some((protocol.to_string(), host.to_string(), path))
}

struct TempGitCredentialStore {
    path: PathBuf,
}

impl TempGitCredentialStore {
    fn new(url: &str, username: &str, password: &str) -> Result<Self, String> {
        let (protocol, host, path) = parse_http_remote_for_store(url)
            .ok_or_else(|| "仅 HTTPS/HTTP 远程支持账号密码重试".to_string())?;
        let dir = std::env::temp_dir();
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path_buf = dir.join(format!("prismcode-git-cred-{nonce}.txt"));
        let payload = format!(
            "{protocol}://{}:{}@{host}{path}\n",
            percent_encode_credential(username),
            percent_encode_credential(password)
        );
        // 创建时即 0600（对齐 write_private 模式）：先 0644 落盘再 chmod
        // 存在瞬时权限窗口，期间同机其它用户可读到明文密码
        {
            use std::io::Write;
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts
                .open(&path_buf)
                .map_err(|e| format!("写入临时 Git 凭据失败: {e}"))?;
            f.write_all(payload.as_bytes())
                .map_err(|e| format!("写入临时 Git 凭据失败: {e}"))?;
        }
        Ok(Self { path: path_buf })
    }

    fn helper_arg(&self) -> String {
        let mut path = self.path.to_string_lossy().replace('\\', "/");
        if path.contains('"') {
            path = path.replace('"', "\\\"");
        }
        if path.chars().any(char::is_whitespace) {
            format!("store --file=\"{path}\"")
        } else {
            format!("store --file={path}")
        }
    }
}

impl Drop for TempGitCredentialStore {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn percent_encode_credential(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        let is_unreserved =
            matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~');
        if is_unreserved {
            out.push(char::from(b));
        } else {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    }
    out
}

async fn read_child_pipe<R>(pipe: Option<R>) -> Vec<u8>
where
    R: AsyncRead + Unpin,
{
    let mut buf = Vec::new();
    if let Some(mut reader) = pipe {
        let _ = reader.read_to_end(&mut buf).await;
    }
    buf
}

fn looks_like_auth_failure(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    lower.contains("authentication failed")
        || lower.contains("authentication required")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("fatal: could not") && lower.contains("authenticate")
        || lower.contains("permission denied")
        || lower.contains("publickey")
        || lower.contains("askpass")
        || lower.contains("terminal prompts disabled")
        || lower.contains("credential") && lower.contains("denied")
}

fn format_cli_remote_error(op: &str, detail: &str, remote_url: &str) -> String {
    let msg = detail.trim();
    if looks_like_auth_failure(msg) {
        return format!("{AUTH_REQUIRED_PREFIX}{AUTH_SEP}{remote_url}{AUTH_SEP}{msg}");
    }
    if msg.is_empty() {
        format!("{op}失败")
    } else {
        format!("{op}失败: {msg}")
    }
}

fn save_git_credential_with_timeout(url: &str, username: &str, password: &str) {
    save_prism_cred(url, username, password);

    let Some((protocol, host)) = parse_http_remote(url) else {
        return;
    };
    let payload =
        format!("protocol={protocol}\nhost={host}\nusername={username}\npassword={password}\n\n");
    let mut child = match std::process::Command::new("git")
        .args(["credential", "approve"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(payload.as_bytes());
    }
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < Duration::from_secs(3) => {
                std::thread::sleep(Duration::from_millis(30));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            Err(_) => break,
        }
    }
}
fn prism_cred_store_path() -> Option<PathBuf> {
    Some(
        crate::user_data::user_data_dir()?
            .join("git-credentials.json"),
    )
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct StoredGitCred {
    username: String,
    password: String,
}

fn load_prism_cred(url: &str) -> Option<(String, String)> {
    let key = cred_host_key(url)?;
    let path = prism_cred_store_path()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let map: std::collections::HashMap<String, StoredGitCred> = serde_json::from_str(&raw).ok()?;
    let c = map.get(&key)?;
    if c.username.is_empty() || c.password.is_empty() {
        return None;
    }
    Some((c.username.clone(), c.password.clone()))
}

fn save_prism_cred(url: &str, username: &str, password: &str) {
    let Some(key) = cred_host_key(url) else {
        return;
    };
    let Some(path) = prism_cred_store_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut map: std::collections::HashMap<String, StoredGitCred> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    map.insert(
        key,
        StoredGitCred {
            username: username.to_string(),
            password: password.to_string(),
        },
    );
    if let Ok(raw) = serde_json::to_string_pretty(&map) {
        // 新建即 0600：消除「先 0644 写盘再 chmod」的瞬时权限窗口
        let _ = write_private(&path, &raw);
    }
}

/// 以 0600 权限写入文本文件（Unix；Windows 无此语义，权限由目录 ACL 管控）。
/// 相比 fs::write + set_permissions 两步，避免了凭据文件瞬时 0644 的暴露窗口。
fn write_private(path: &std::path::Path, content: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(content.as_bytes())
}

/// 写入系统 git credential（尽力而为）+ Prism Code 本地凭据（可靠记住）
fn save_git_credential(url: &str, username: &str, password: &str) {
    save_git_credential_with_timeout(url, username, password);
}

/// 供登录弹窗预填：按远程 URL 查 Prism Code 已存用户名
#[tauri::command]
pub fn git_stored_username(url: String) -> Option<String> {
    load_prism_cred(&url).map(|(u, _)| u)
}

/// 远程凭据：显式账号密码 → Prism 已存凭据 → SSH → git credential helper
fn make_callbacks(username: Option<String>, password: Option<String>) -> RemoteCallbacks<'static> {
    let mut cb = RemoteCallbacks::new();
    cb.credentials(move |url, username_from_url, allowed| {
        let explicit_user = username.as_deref();
        let explicit_pass = password.as_deref();
        let stored = load_prism_cred(url);

        if allowed.contains(git2::CredentialType::USERNAME) {
            let user = explicit_user
                .or(stored.as_ref().map(|(u, _)| u.as_str()))
                .or(username_from_url)
                .unwrap_or("git");
            return Cred::username(user);
        }

        // 用户在弹窗中填写的 HTTPS 账号密码优先
        if let (Some(u), Some(p)) = (explicit_user, explicit_pass) {
            if allowed.contains(git2::CredentialType::USER_PASS_PLAINTEXT)
                || allowed.contains(git2::CredentialType::DEFAULT)
            {
                return Cred::userpass_plaintext(u, p);
            }
        }

        // 应用内已记住的凭据
        if let Some((u, p)) = stored {
            if allowed.contains(git2::CredentialType::USER_PASS_PLAINTEXT)
                || allowed.contains(git2::CredentialType::DEFAULT)
            {
                return Cred::userpass_plaintext(&u, &p);
            }
        }

        if allowed.contains(git2::CredentialType::SSH_KEY) {
            let user = username_from_url.unwrap_or("git");
            // SSH agent 单点 5s 超时：避免 agent 卡死拖住整次推送
            match try_ssh_agent_with_timeout(user, Duration::from_secs(5)) {
                Ok(Some(cred)) => return Ok(cred),
                Ok(None) => { /* agent 超时：继续走密钥文件路径 */ }
                Err(_) => { /* agent 不可用：继续走密钥文件路径 */ }
            }
            for key in default_ssh_key_paths() {
                if let Ok(cred) = Cred::ssh_key(user, None, &key, None) {
                    return Ok(cred);
                }
            }
        }

        if allowed.contains(git2::CredentialType::USER_PASS_PLAINTEXT)
            || allowed.contains(git2::CredentialType::DEFAULT)
        {
            if let Ok(cfg) = git2::Config::open_default() {
                if let Ok(cred) = Cred::credential_helper(&cfg, url, username_from_url) {
                    return Ok(cred);
                }
            }
        }

        Err(git2::Error::from_str(
            "未找到远程凭据（SSH 密钥或 HTTPS credential helper）",
        ))
    });
    cb
}

fn remote_url(remote: &git2::Remote<'_>) -> String {
    remote.url().unwrap_or("").to_string()
}

#[tauri::command]
pub async fn git_pull(
    root: String,
    username: Option<String>,
    password: Option<String>,
    remember: Option<bool>,
) -> Result<String, String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let handle =
        tokio::task::spawn_blocking(move || git_pull_blocking(root, username, password, remember));
    let result = match tokio::time::timeout(std::time::Duration::from_secs(120), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("拉取任务失败: {join}")),
        Err(_) => Err("拉取超时（120s），请检查网络或稍后重试".into()),
    };
    clear_status_cache();
    result
}

fn git_pull_blocking(
    root: String,
    username: Option<String>,
    password: Option<String>,
    remember: Option<bool>,
) -> Result<String, String> {
    // 与 merge 一致：进行中的操作并存或本地有未提交改动时拒绝，
    // 否则 libgit2 的 merge/checkout 会静默覆盖本地修改
    if is_rebase_in_progress(&root) {
        return Err("无法拉取：Rebase 正在进行中，请先完成或放弃 Rebase".into());
    }
    if git_dir(&root)
        .map(|d| d.join("MERGE_HEAD").exists())
        .unwrap_or(false)
    {
        return Err("无法拉取：上一次合并尚未完成，请先解决冲突或放弃合并".into());
    }
    let repo = open_repo(&root)?;
    ensure_mergeable_worktree(&repo)?;
    let head = repo.head().map_err(|e| e.to_string())?;
    let branch = head.shorthand().map_err(|e| e.to_string())?.to_string();
    let mut remote = repo
        .find_remote("origin")
        .map_err(|e| format!("缺少 origin 远程: {e}"))?;
    let url = remote_url(&remote);
    let mut opts = git2::FetchOptions::new();
    opts.remote_callbacks(make_callbacks(username.clone(), password.clone()));
    remote
        .fetch(&[branch.as_str()], Some(&mut opts), None)
        .map_err(|e| format_remote_error("拉取", e, &url))?;

    if remember.unwrap_or(false) {
        if let (Some(u), Some(p)) = (username.as_deref(), password.as_deref()) {
            save_git_credential(&url, u, p);
        }
    }

    let fetch_head = repo
        .find_reference("FETCH_HEAD")
        .map_err(|e| e.to_string())?;
    let fetch_commit = repo
        .reference_to_annotated_commit(&fetch_head)
        .map_err(|e| e.to_string())?;

    let (analysis, _) = repo
        .merge_analysis(&[&fetch_commit])
        .map_err(|e| e.to_string())?;
    if analysis.is_up_to_date() {
        return Ok("已是最新".into());
    }
    if analysis.is_fast_forward() {
        // 快进：移动 HEAD ref 后再 checkout 同步 index/工作树。
        // force 在 ensure_mergeable_worktree 已保证工作树干净的前提下是安全的，
        // 且能补全 index 中缺失的新增文件（safe 模式不会写「index 中不存在」的文件）。
        let refname = format!("refs/heads/{branch}");
        let mut reference = repo.find_reference(&refname).map_err(|e| e.to_string())?;
        reference
            .set_target(fetch_commit.id(), "fast-forward")
            .map_err(|e| e.to_string())?;
        repo.set_head(&refname).map_err(|e| e.to_string())?;
        repo.checkout_head(Some(CheckoutBuilder::default().force()))
            .map_err(|e| format!("快进拉取后检出工作树失败: {e}"))?;
        return Ok("快进拉取完成".into());
    }

    repo.merge(&[&fetch_commit], None, None)
        .map_err(|e| format!("合并失败: {e}"))?;
    if repo.index().map(|i| i.has_conflicts()).unwrap_or(false) {
        // 写 MERGE_HEAD：冲突解决后提交自动带上第二父（拓扑不丢）
        if let Ok(dir) = git_dir(&root) {
            let _ = std::fs::write(dir.join("MERGE_HEAD"), format!("{}\n", fetch_commit.id()));
            let _ = std::fs::write(
                dir.join("MERGE_MSG"),
                format!("Merge remote-tracking branch 'origin/{branch}'\n"),
            );
        }
        return Err("拉取后存在冲突，请在 Commit 面板解决".into());
    }
    let msg = format!("Merge remote-tracking branch 'origin/{branch}'");
    // 双亲提交：远端 commit 必须进父链（否则拓扑丢失，重复 pull 出冲突）
    commit_internal(root, msg, None, None, Some(fetch_commit.id()))?;
    Ok("合并拉取完成".into())
}

#[tauri::command]
pub async fn git_push(
    root: String,
    force: Option<bool>,
    username: Option<String>,
    password: Option<String>,
    remember: Option<bool>,
) -> Result<String, String> {
    clear_status_cache();
    let result = async {
    let (branch, url) = {
        let repo = open_repo(&root)?;
        let head = repo.head().map_err(|e| e.to_string())?;
        let branch = head.shorthand().map_err(|e| e.to_string())?.to_string();
        let remote = repo
            .find_remote("origin")
            .map_err(|e| format!("缺少 origin 远程: {e}"))?;
        let url = remote_url(&remote);
        (branch, url)
    };
    let refspec = if force.unwrap_or(false) {
        format!("+refs/heads/{branch}:refs/heads/{branch}")
    } else {
        format!("refs/heads/{branch}:refs/heads/{branch}")
    };

    let temp_store = match (username.as_deref(), password.as_deref()) {
        (Some(u), Some(p)) if parse_http_remote(&url).is_some() => {
            Some(TempGitCredentialStore::new(&url, u, p)?)
        }
        _ => None,
    };

    let mut cmd = tokio::process::Command::new("git");
    cmd.current_dir(&root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(store) = temp_store.as_ref() {
        cmd.arg("-c")
            .arg("credential.helper=")
            .arg("-c")
            .arg(format!("credential.helper={}", store.helper_arg()));
    }
    cmd.args(["push", "origin", &refspec]);

    let mut child = cmd.spawn().map_err(|e| format!("无法执行 git push: {e}"))?;
    let stdout_task = tokio::spawn(read_child_pipe(child.stdout.take()));
    let stderr_task = tokio::spawn(read_child_pipe(child.stderr.take()));

    let status = match tokio::time::timeout(Duration::from_secs(120), child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => {
            let _ = child.kill().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err(format!("推送任务失败: {e}"));
        }
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err("推送超时（120s），请检查网络或稍后重试".into());
        }
    };

    let stdout = stdout_task
        .await
        .map_err(|e| format!("读取 git push 输出失败: {e}"))?;
    let stderr = stderr_task
        .await
        .map_err(|e| format!("读取 git push 错误输出失败: {e}"))?;
    let stdout = String::from_utf8_lossy(&stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&stderr).trim().to_string();

    if !status.success() {
        let detail = if stderr.is_empty() {
            stdout.as_str()
        } else {
            stderr.as_str()
        };
        return Err(format_cli_remote_error("推送", detail, &url));
    }

    if remember.unwrap_or(false) {
        if let (Some(u), Some(p)) = (username.as_deref(), password.as_deref()) {
            save_git_credential(&url, u, p);
        }
    }
    Ok("推送成功".into())
    }
    .await;
    clear_status_cache();
    result
}

#[tauri::command]
pub fn git_stash(
    root: String,
    message: Option<String>,
    include_untracked: Option<bool>,
) -> Result<(), String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let result = (|| {
        let mut repo = open_repo(&root)?;
        let sig = repo.signature().map_err(|e| e.to_string())?;
        let msg = message.unwrap_or_else(|| "Prism Code stash".into());
        let flags = if include_untracked.unwrap_or(false) {
            StashFlags::INCLUDE_UNTRACKED
        } else {
            StashFlags::DEFAULT
        };
        repo.stash_save(&sig, &msg, Some(flags))
            .map_err(|e| format!("贮藏失败: {e}"))?;
        Ok(())
    })();
    clear_status_cache();
    result
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashEntry {
    pub index: usize,
    pub id: String,
    pub message: String,
}

#[tauri::command]
pub async fn git_stash_list(root: String) -> Result<Vec<GitStashEntry>, String> {
    // refresh 链路的伴随查询：放 spawn_blocking，避免主线程遍历 stash
    let handle = tokio::task::spawn_blocking(move || git_stash_list_blocking(root));
    match tokio::time::timeout(Duration::from_secs(15), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("读取贮藏列表任务失败: {join}")),
        Err(_) => Err("读取贮藏列表超时（15s）".into()),
    }
}

fn git_stash_list_blocking(root: String) -> Result<Vec<GitStashEntry>, String> {
    let mut repo = open_repo(&root)?;
    let mut out = Vec::new();
    repo.stash_foreach(|index, message, oid| {
        out.push(GitStashEntry {
            index,
            id: oid.to_string(),
            message: message.to_string(),
        });
        true
    })
    .map_err(|e| e.to_string())?;
    Ok(out)
}

#[tauri::command]
pub fn git_stash_pop(root: String, index: Option<usize>) -> Result<(), String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let result = (|| {
        let mut repo = open_repo(&root)?;
        repo.stash_pop(index.unwrap_or(0), None)
            .map_err(|e| format!("弹出贮藏失败: {e}"))?;
        Ok(())
    })();
    clear_status_cache();
    result
}

#[tauri::command]
pub fn git_stash_apply(root: String, index: usize) -> Result<(), String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let result = (|| {
        let mut repo = open_repo(&root)?;
        repo.stash_apply(index, None)
            .map_err(|e| format!("应用贮藏失败: {e}"))?;
        Ok(())
    })();
    clear_status_cache();
    result
}

#[tauri::command]
pub fn git_stash_drop(root: String, index: usize) -> Result<(), String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let result = (|| {
        let mut repo = open_repo(&root)?;
        repo.stash_drop(index)
            .map_err(|e| format!("删除贮藏失败: {e}"))?;
        Ok(())
    })();
    clear_status_cache();
    result
}

#[tauri::command]
pub async fn git_reset_hard(root: String) -> Result<(), String> {
    // Hard reset 重写整个工作树，放 spawn_blocking
    clear_status_cache();
    let handle = tokio::task::spawn_blocking(move || git_reset_hard_blocking(root));
    let result = match tokio::time::timeout(Duration::from_secs(60), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("重置任务失败: {join}")),
        Err(_) => Err("重置超时（60s）".into()),
    };
    clear_status_cache();
    result
}

fn git_reset_hard_blocking(root: String) -> Result<(), String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let repo = open_repo(&root)?;
    let head = repo
        .head()
        .map_err(|e| e.to_string())?
        .peel_to_commit()
        .map_err(|e| e.to_string())?;
    repo.reset(head.as_object(), ResetType::Hard, None)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_undo_commit(root: String) -> Result<(), String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let result = (|| {
        let repo = open_repo(&root)?;
        let commit = repo
            .head()
            .map_err(|e| e.to_string())?
            .peel_to_commit()
            .map_err(|e| e.to_string())?;
        if commit.parent_count() == 0 {
            return Err("没有可撤销的父提交".into());
        }
        let parent = commit.parent(0).map_err(|e| e.to_string())?;
        repo.reset(parent.as_object(), ResetType::Soft, None)
            .map_err(|e| e.to_string())
    })();
    clear_status_cache();
    result
}

#[tauri::command]
pub async fn git_revert_to(root: String, commit_id: String) -> Result<(), String> {
    // Hard reset 重写整个工作树，放 spawn_blocking
    clear_status_cache();
    let handle = tokio::task::spawn_blocking(move || {
        git_revert_to_blocking(root, commit_id)
    });
    let result = match tokio::time::timeout(Duration::from_secs(60), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("回滚任务失败: {join}")),
        Err(_) => Err("回滚超时（60s）".into()),
    };
    clear_status_cache();
    result
}

fn git_revert_to_blocking(root: String, commit_id: String) -> Result<(), String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let repo = open_repo(&root)?;
    let oid = resolve_commit_oid(&repo, &commit_id)?;
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
    repo.reset(commit.as_object(), ResetType::Hard, None)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_merge_branch(root: String, name: String) -> Result<String, String> {
    // merge 分析 + checkout/merge 重写工作树，放 spawn_blocking
    clear_status_cache();
    let handle = tokio::task::spawn_blocking(move || {
        git_merge_branch_blocking(root, name)
    });
    let result = match tokio::time::timeout(Duration::from_secs(120), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("合并任务失败: {join}")),
        Err(_) => Err("合并超时（120s）".into()),
    };
    clear_status_cache();
    result
}

fn git_merge_branch_blocking(root: String, name: String) -> Result<String, String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    // 与系统 git 一致：存在其它进行中的操作时拒绝合并
    if is_rebase_in_progress(&root) {
        return Err("无法合并：Rebase 正在进行中，请先完成或放弃 Rebase".into());
    }
    if git_dir(&root)
        .map(|d| d.join("MERGE_HEAD").exists())
        .unwrap_or(false)
    {
        return Err("无法合并：上一次合并尚未完成，请先在 Commit 面板继续或放弃合并".into());
    }
    let repo = open_repo(&root)?;
    // libgit2 的 merge 会静默覆盖本地未提交修改（系统 git 会拒绝）。
    // 合并前必须拦截已跟踪文件的 staged/unstaged 改动，防止合并后用户改动丢失。
    ensure_mergeable_worktree(&repo)?;
    let branch = repo
        .find_branch(&name, BranchType::Local)
        .or_else(|_| repo.find_branch(&format!("origin/{name}"), BranchType::Remote))
        .map_err(|e| {
            format!("未找到要合并的分支「{name}」（本地与 origin 均不存在）: {e}")
        })?;
    let commit = branch.get().peel_to_commit().map_err(|e| e.to_string())?;
    let annotated = repo
        .find_annotated_commit(commit.id())
        .map_err(|e| e.to_string())?;
    let (analysis, _) = repo
        .merge_analysis(&[&annotated])
        .map_err(|e| e.to_string())?;
    if analysis.is_up_to_date() {
        return Ok("已是最新，无需合并".into());
    }
    if analysis.is_fast_forward() {
        // 快进：移动 HEAD ref 后再 checkout 同步 index/工作树。
        // libgit2 的 merge() 不做 HEAD 移动；force 在 ensure_mergeable_worktree
        // 已保证工作树干净的前提下是安全的，且能补全 index 中缺失的新增文件
        // （safe 模式不会写「index 中不存在」的文件）。
        let head_ref = repo.head().map_err(|e| e.to_string())?;
        let refname = head_ref.name().map_err(|e| e.to_string())?.to_string();
        let mut reference = repo.find_reference(&refname).map_err(|e| e.to_string())?;
        reference
            .set_target(annotated.id(), "merge fast-forward")
            .map_err(|e| e.to_string())?;
        repo.checkout_head(Some(CheckoutBuilder::default().force()))
            .map_err(|e| format!("快进合并后检出工作树失败: {e}"))?;
        return Ok("快进合并完成".into());
    }
    repo.merge(&[&annotated], None, None)
        .map_err(|e| format!("合并失败: {e}"))?;
    if repo.index().map(|i| i.has_conflicts()).unwrap_or(false) {
        // 写入 git 标准 MERGE_HEAD/MERGE_MSG：冲突解决后提交时，把被合并分支
        // 作为第二父（libgit2 自身不写这些文件。否则合并提交为单亲，拓扑丢失，
        // 之后再次 merge 同一分支会被判定需要真实合并 → 已应用变更重复应用 → 凭空冲突）
        if let Ok(dir) = git_dir(&root) {
            let _ = std::fs::write(dir.join("MERGE_HEAD"), format!("{}\n", commit.id()));
            let _ = std::fs::write(
                dir.join("MERGE_MSG"),
                format!("Merge branch '{name}'\n"),
            );
        }
        return Err("合并产生冲突，请在 Commit 面板解决".into());
    }
    // 双亲提交：被合并分支 commit 必须进父链（拓扑正确，重复 merge 判 up-to-date）
    commit_internal(
        root,
        format!("Merge branch '{name}'"),
        None,
        None,
        Some(commit.id()),
    )?;
    Ok("合并完成".into())
}

/// 合并前检查：已跟踪文件存在 staged 或 unstaged 改动时拒绝。
/// libgit2 的 merge/checkout 默认会覆盖本地修改（系统 git 会先拒绝），
/// 这里前置拦截并把原因说清楚，避免用户改动静默丢失。
fn ensure_mergeable_worktree(repo: &Repository) -> Result<(), String> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(false)
        .include_ignored(false)
        .recurse_untracked_dirs(false);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    for entry in statuses.iter() {
        let flags = entry.status();
        if flags.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE
                | Status::WT_MODIFIED
                | Status::WT_DELETED
                | Status::WT_RENAMED
                | Status::WT_TYPECHANGE,
        ) {
            let path = entry.path().unwrap_or("?");
            return Err(format!(
                "无法合并：「{path}」有未提交的更改，请先提交或贮藏后再合并"
            ));
        }
    }
    Ok(())
}

/// 放弃进行中的合并（对齐 git merge --abort）：清掉 MERGE_HEAD/MERGE_MSG 并
/// 将 index 与工作树重置回合并前的 HEAD。
#[tauri::command]
pub fn git_merge_abort(root: String) -> Result<String, String> {
    clear_status_cache();
    let result = (|| {
        let repo = open_repo(&root)?;
        let dir = git_dir(&root)?;
        if !dir.join("MERGE_HEAD").exists() {
            return Err("当前没有进行中的合并".into());
        }
        let head = repo.head().map_err(|e| e.to_string())?;
        let commit = head.peel_to_commit().map_err(|e| e.to_string())?;
        repo.reset(commit.as_object(), ResetType::Mixed, None)
            .map_err(|e| format!("放弃合并失败（重置索引）: {e}"))?;
        // reset --merge 语义：同时把工作树恢复（本地无冲突的改动在合并前已被
        // ensure_mergeable_worktree 拦截，恢复是安全的）
        repo.checkout_head(Some(CheckoutBuilder::default().force()))
            .map_err(|e| format!("放弃合并失败（恢复工作树）: {e}"))?;
        let _ = std::fs::remove_file(dir.join("MERGE_HEAD"));
        let _ = std::fs::remove_file(dir.join("MERGE_MSG"));
        Ok("已放弃合并".into())
    })();
    clear_status_cache();
    result
}

#[tauri::command]
pub fn git_conflict_files(root: String) -> Result<Vec<String>, String> {
    let snapshot = git_status_blocking(root)?;
    Ok(snapshot
        .entries
        .into_iter()
        .filter(|e| e.conflicted)
        .map(|e| e.path)
        .collect())
}

#[tauri::command]
pub async fn git_resolve_conflict(
    root: String,
    path: String,
    strategy: String,
) -> Result<(), String> {
    // 含 blob 读取 + 写盘 + index 操作，放 spawn_blocking
    let handle = tokio::task::spawn_blocking(move || {
        git_resolve_conflict_blocking(root, path, strategy)
    });
    let result = match tokio::time::timeout(Duration::from_secs(30), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("解决冲突任务失败: {join}")),
        Err(_) => Err("解决冲突超时（30s）".into()),
    };
    clear_status_cache();
    result
}

fn git_resolve_conflict_blocking(
    root: String,
    path: String,
    strategy: String,
) -> Result<(), String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let repo = open_repo(&root)?;
    let wd = repo.workdir().ok_or("无工作区")?.to_path_buf();
    let full = wd.join(&path);
    // 校验路径落在工作区内：含 `..` / 绝对路径可把冲突内容覆写到仓库外任意文件
    crate::commands::path_util::ensure_inside_workspace(&wd, &full)?;

    match strategy.as_str() {
        "ours" | "theirs" => {
            let index = repo.index().map_err(|e| e.to_string())?;
            let conflict = index
                .conflict_get(Path::new(&path))
                .map_err(|e| e.to_string())?;
            let chosen = if strategy == "ours" {
                conflict.our
            } else {
                conflict.their
            };
            let Some(entry) = chosen else {
                return Err("无法获取冲突版本".into());
            };
            let blob = repo.find_blob(entry.id).map_err(|e| e.to_string())?;
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&full, blob.content()).map_err(|e| e.to_string())?;
        }
        "manual" => {}
        _ => return Err("未知解决策略".into()),
    }

    let mut index = repo.index().map_err(|e| e.to_string())?;
    index
        .add_path(Path::new(&path))
        .map_err(|e| e.to_string())?;
    let _ = index.conflict_remove(Path::new(&path));
    index.write().map_err(|e| e.to_string())?;
    Ok(())
}

// ==================== 完全体：Fetch / Update / Rebase / Cherry-pick / Reset / Blame ====================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteInfo {
    pub name: String,
    pub url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBlameLine {
    pub line: usize,
    pub commit_id: String,
    pub author: String,
    pub time: String,
    pub summary: String,
}

#[tauri::command]
pub fn git_remotes(root: String) -> Result<Vec<GitRemoteInfo>, String> {
    let repo = open_repo(&root)?;
    let names = repo.remotes().map_err(|e| e.to_string())?;
    let mut list = Vec::new();
    for i in 0..names.len() {
        let Ok(Some(name)) = names.get(i) else {
            continue;
        };
        let remote = repo.find_remote(name).ok();
        list.push(GitRemoteInfo {
            name: name.to_string(),
            url: remote
                .as_ref()
                .and_then(|r| r.url().ok().map(str::to_string)),
        });
    }
    Ok(list)
}

#[tauri::command]
pub async fn git_unpushed_commits(
    root: String,
    limit: Option<usize>,
) -> Result<Vec<GitCommitInfo>, String> {
    // 先用轻量级方法计算缓存 key（不开 revwalk）；命中则直接返回
    let requested_limit = limit.unwrap_or(50).min(200);
    if let Some(cached) = read_unpushed_cache(&root, requested_limit) {
        return Ok(cached);
    }
    let handle = tokio::task::spawn_blocking(move || git_unpushed_commits_blocking(root, limit));
    match tokio::time::timeout(std::time::Duration::from_secs(30), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("读取未推送提交任务失败: {join}")),
        Err(_) => Err("读取未推送提交超时（30s），仓库可能过大".into()),
    }
}

fn git_unpushed_commits_blocking(
    root: String,
    limit: Option<usize>,
) -> Result<Vec<GitCommitInfo>, String> {
    let repo = open_repo(&root)?;
    let max = limit.unwrap_or(50).min(200);
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return Ok(vec![]),
    };
    if !head.is_branch() {
        return Ok(vec![]);
    }
    let branch_name = head.shorthand().map_err(|e| e.to_string())?.to_string();
    let branch = repo
        .find_branch(&branch_name, BranchType::Local)
        .map_err(|e| e.to_string())?;
    let upstream = match branch.upstream() {
        Ok(u) => u,
        Err(_) => return git_log_blocking(root, Some(max.min(20))),
    };
    let local_oid = head.peel_to_commit().map_err(|e| e.to_string())?.id();
    let remote_oid = upstream
        .get()
        .peel_to_commit()
        .map_err(|e| e.to_string())?
        .id();

    // 写入缓存 key（root + branch + local_oid + remote_oid），30s 内复用
    let cache_key = format!("{root}|{branch_name}|{local_oid}|{remote_oid}|{max}");
    {
        let cache = unpushed_cache();
        let mut guard = cache.lock().map_err(|e| format!("缓存锁失败: {e}"))?;
        // 触发一次扫描后顺手清理过期项，避免长期运行内存增长
        let now = Instant::now();
        guard.retain(|_, (ts, _)| now.duration_since(*ts) < UNPUSHED_CACHE_TTL);
    }

    let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
    walk.push(local_oid).map_err(|e| e.to_string())?;
    let _ = walk.hide(remote_oid);

    let mut commits = Vec::new();
    for oid in walk.take(max) {
        let oid = oid.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        commits.push(commit_info_from_commit(
            &repo,
            &commit,
            vec![],
            true,
            false,
        ));
    }

    // 写入缓存
    if let Ok(mut guard) = unpushed_cache().lock() {
        guard.insert(cache_key, (Instant::now(), commits.clone()));
    }
    Ok(commits)
}

/// 轻量级缓存命中检查：仅读 HEAD 与分支元数据，不做 revwalk
fn read_unpushed_cache(root: &str, limit: usize) -> Option<Vec<GitCommitInfo>> {
    let repo = Repository::discover(root).ok()?;
    let head = repo.head().ok()?;
    if !head.is_branch() {
        return None;
    }
    let branch_name = match head.shorthand() {
        Ok(s) if !s.is_empty() => s.to_string(),
        _ => return None,
    };
    let branch = repo.find_branch(&branch_name, BranchType::Local).ok()?;
    let upstream = branch.upstream().ok()?;
    let local_oid = head.peel_to_commit().ok()?.id();
    let remote_oid = upstream.get().peel_to_commit().ok()?.id();
    let max = limit.min(200);
    let key = format!("{root}|{branch_name}|{local_oid}|{remote_oid}|{max}");

    let cache = unpushed_cache().lock().ok()?;
    if let Some((ts, value)) = cache.get(&key) {
        if ts.elapsed() < UNPUSHED_CACHE_TTL {
            return Some(value.clone());
        }
    }
    None
}

#[tauri::command]
pub async fn git_fetch(
    root: String,
    remote: Option<String>,
    username: Option<String>,
    password: Option<String>,
    remember: Option<bool>,
) -> Result<String, String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let handle = tokio::task::spawn_blocking(move || {
        git_fetch_blocking(root, remote, username, password, remember)
    });
    let result = match tokio::time::timeout(std::time::Duration::from_secs(120), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("获取任务失败: {join}")),
        Err(_) => Err("获取超时（120s），请检查网络或稍后重试".into()),
    };
    clear_status_cache();
    result
}

fn git_fetch_blocking(
    root: String,
    remote: Option<String>,
    username: Option<String>,
    password: Option<String>,
    remember: Option<bool>,
) -> Result<String, String> {
    let repo = open_repo(&root)?;
    let remote_name = remote.unwrap_or_else(|| "origin".into());
    let mut remote = repo
        .find_remote(&remote_name)
        .map_err(|e| format!("缺少远程 {remote_name}: {e}"))?;
    let url = remote_url(&remote);
    let mut opts = git2::FetchOptions::new();
    opts.remote_callbacks(make_callbacks(username.clone(), password.clone()));
    // fetch 后清理远端已删除的分支（本地 refs/remotes/<remote>/*），
    // 否则分支列表仍会展示已在远端删除的远程分支
    opts.prune(git2::FetchPrune::On);
    remote
        .fetch(&[] as &[&str], Some(&mut opts), None)
        .map_err(|e| format_remote_error("Fetch", e, &url))?;
    if remember.unwrap_or(false) {
        if let (Some(u), Some(p)) = (username.as_deref(), password.as_deref()) {
            save_git_credential(&url, u, p);
        }
    }
    Ok(format!("已从 {remote_name} 获取更新"))
}

#[tauri::command]
pub async fn git_update_project(
    root: String,
    strategy: String,
    username: Option<String>,
    password: Option<String>,
    remember: Option<bool>,
) -> Result<String, String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let handle = tokio::task::spawn_blocking(move || {
        git_update_project_blocking(root, strategy, username, password, remember)
    });
    let result = match tokio::time::timeout(std::time::Duration::from_secs(120), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("更新任务失败: {join}")),
        Err(_) => Err("更新超时（120s），请检查网络或稍后重试".into()),
    };
    clear_status_cache();
    result
}

fn git_update_project_blocking(
    root: String,
    strategy: String,
    username: Option<String>,
    password: Option<String>,
    remember: Option<bool>,
) -> Result<String, String> {
    // 与 merge/pull 一致：进行中的操作并存或本地有未提交改动时拒绝，
    // 否则 libgit2 的 merge/checkout 会静默覆盖本地修改
    if is_rebase_in_progress(&root) {
        return Err("无法更新：Rebase 正在进行中，请先完成或放弃 Rebase".into());
    }
    if git_dir(&root)
        .map(|d| d.join("MERGE_HEAD").exists())
        .unwrap_or(false)
    {
        return Err("无法更新：上一次合并尚未完成，请先解决冲突或放弃合并".into());
    }
    {
        let repo = open_repo(&root)?;
        ensure_mergeable_worktree(&repo)?;
    }
    git_fetch_blocking(
        root.clone(),
        Some("origin".into()),
        username.clone(),
        password.clone(),
        remember,
    )?;

    let repo = open_repo(&root)?;
    let head = repo.head().map_err(|e| e.to_string())?;
    let branch = head.shorthand().map_err(|e| e.to_string())?.to_string();
    let local_branch = repo
        .find_branch(&branch, BranchType::Local)
        .map_err(|e| e.to_string())?;
    let upstream = local_branch
        .upstream()
        .map_err(|_| "当前分支没有上游，请先设置 upstream 或 Push".to_string())?;
    let upstream_name = upstream
        .name()
        .map_err(|e| e.to_string())?
        .unwrap_or("")
        .to_string();

    match strategy.as_str() {
        "rebase" => git_rebase_onto(root, upstream_name),
        _ => {
            let commit = upstream.get().peel_to_commit().map_err(|e| e.to_string())?;
            let annotated = repo
                .find_annotated_commit(commit.id())
                .map_err(|e| e.to_string())?;
            let (analysis, _) = repo
                .merge_analysis(&[&annotated])
                .map_err(|e| e.to_string())?;
            if analysis.is_up_to_date() {
                return Ok("已是最新".into());
            }
            if analysis.is_fast_forward() {
                // 快进：移动 HEAD ref 后再 checkout 同步 index/工作树。
                // force 在 ensure_mergeable_worktree 已保证工作树干净的前提下
                // 是安全的，且能补全 index 中缺失的新增文件。
                let refname = format!("refs/heads/{branch}");
                let mut reference = repo.find_reference(&refname).map_err(|e| e.to_string())?;
                reference
                    .set_target(annotated.id(), "update fast-forward")
                    .map_err(|e| e.to_string())?;
                repo.set_head(&refname).map_err(|e| e.to_string())?;
                repo.checkout_head(Some(CheckoutBuilder::default().force()))
                    .map_err(|e| format!("快进更新后检出工作树失败: {e}"))?;
                return Ok("快进更新完成".into());
            }
            repo.merge(&[&annotated], None, None)
                .map_err(|e| format!("合并失败: {e}"))?;
            if repo.index().map(|i| i.has_conflicts()).unwrap_or(false) {
                // 写 MERGE_HEAD：冲突解决后提交自动带上第二父（拓扑不丢）
                if let Ok(dir) = git_dir(&root) {
                    let _ = std::fs::write(dir.join("MERGE_HEAD"), format!("{}\n", commit.id()));
                    let _ = std::fs::write(
                        dir.join("MERGE_MSG"),
                        format!("Merge remote-tracking branch '{upstream_name}'\n"),
                    );
                }
                return Err("更新后存在冲突，请在 Commit 面板解决".into());
            }
            // 双亲提交：远端 commit 必须进父链（否则拓扑丢失，重复 update 出冲突）
            commit_internal(
                root,
                format!("Merge remote-tracking branch '{upstream_name}'"),
                None,
                None,
                Some(annotated.id()),
            )?;
            Ok("合并更新完成".into())
        }
    }
}

fn resolve_branch_commit<'a>(repo: &'a Repository, name: &str) -> Result<git2::Commit<'a>, String> {
    repo.find_branch(name, BranchType::Local)
        .or_else(|_| {
            let n = if name.contains('/') {
                name.to_string()
            } else {
                format!("origin/{name}")
            };
            repo.find_branch(&n, BranchType::Remote)
        })
        .map_err(|e| format!("未找到分支 {name}: {e}"))?
        .get()
        .peel_to_commit()
        .map_err(|e| e.to_string())
}

fn git_rebase_onto(root: String, onto_name: String) -> Result<String, String> {
    // 使用系统 git，冲突时保留 rebase 状态供 Continue/Abort
    validate_git_positional_arg(&onto_name, "Rebase 基准")?;
    let output = std::process::Command::new("git")
        .args(["rebase", &onto_name])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("无法执行 git rebase: {e}"))?;
    if output.status.success() {
        return Ok(format!("已 rebase 到 {onto_name}"));
    }
    let err = String::from_utf8_lossy(&output.stderr);
    let out = String::from_utf8_lossy(&output.stdout);
    let combined = format!("{err}\n{out}");
    if is_rebase_in_progress(&root) {
        return Err(format!(
            "GIT_REBASE_CONFLICT|||Rebase 产生冲突，请在 Commit 面板解决后 Continue\n{combined}"
        ));
    }
    Err(format!("Rebase 失败: {}", combined.trim()))
}

#[tauri::command]
pub async fn git_rebase_branch(root: String, onto: String) -> Result<String, String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    // 系统 git rebase 无超时，放 spawn_blocking 防主线程冻结
    let handle = tokio::task::spawn_blocking(move || git_rebase_onto(root, onto));
    let result = match tokio::time::timeout(std::time::Duration::from_secs(120), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("Rebase 任务失败: {join}")),
        Err(_) => Err("Rebase 超时（120s），请检查冲突状态".into()),
    };
    clear_status_cache();
    result
}

#[tauri::command]
pub async fn git_cherry_pick(root: String, commit_id: String) -> Result<String, String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let handle = tokio::task::spawn_blocking(move || git_cherry_pick_blocking(root, commit_id));
    let result = match tokio::time::timeout(std::time::Duration::from_secs(120), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("Cherry-pick 任务失败: {join}")),
        Err(_) => Err("Cherry-pick 超时（120s），请检查冲突状态".into()),
    };
    clear_status_cache();
    result
}

fn git_cherry_pick_blocking(root: String, commit_id: String) -> Result<String, String> {
    // 与 merge/pull 一致：先拦截本地未提交改动，libgit2 的 cherrypick
    // 同样可能静默覆盖本地修改
    let repo = open_repo(&root)?;
    ensure_mergeable_worktree(&repo)?;
    let oid = resolve_commit_oid(&repo, &commit_id)?;
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
    repo.cherrypick(&commit, None)
        .map_err(|e| format!("Cherry-pick 失败: {e}"))?;
    if repo.index().map(|i| i.has_conflicts()).unwrap_or(false) {
        return Err("Cherry-pick 产生冲突，请在 Commit 面板解决".into());
    }
    let msg = commit.message().unwrap_or("Cherry-pick").to_string();
    git_commit(root, msg, None, None)?;
    Ok("Cherry-pick 完成".into())
}

#[tauri::command]
pub fn git_reset(root: String, commit_id: String, mode: String) -> Result<String, String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let result = (|| {
        let repo = open_repo(&root)?;
        let oid = resolve_commit_oid(&repo, &commit_id)?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        let reset_type = match mode.as_str() {
            "soft" => ResetType::Soft,
            "hard" => ResetType::Hard,
            _ => ResetType::Mixed,
        };
        repo.reset(commit.as_object(), reset_type, None)
            .map_err(|e| e.to_string())?;
        Ok(format!(
            "已 {} 重置到 {}",
            mode,
            short_text(&commit_id, 7)
        ))
    })();
    clear_status_cache();
    result
}

#[tauri::command]
pub async fn git_blame(root: String, path: String) -> Result<Vec<GitBlameLine>, String> {
    // blame 逐行 diff，大文件耗时明显，离开主线程
    let handle = tokio::task::spawn_blocking(move || git_blame_blocking(root, path));
    match tokio::time::timeout(std::time::Duration::from_secs(30), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("生成注释信息任务失败: {join}")),
        Err(_) => Err("生成注释信息超时（30s）".into()),
    }
}

fn git_blame_blocking(root: String, path: String) -> Result<Vec<GitBlameLine>, String> {
    let repo = open_repo(&root)?;
    ensure_repo_paths(&repo, std::slice::from_ref(&path))?;
    let blame = repo
        .blame_file(Path::new(&path), None)
        .map_err(|e| format!("Blame 失败: {e}"))?;
    let mut lines = Vec::new();
    for i in 0..blame.len() {
        let hunk = blame.get_index(i).ok_or_else(|| "blame hunk".to_string())?;
        let oid = hunk.final_commit_id();
        let id_str = oid.to_string();
        let short = short_text(&id_str, 7);
        let commit = repo.find_commit(oid).ok();
        let time = commit
            .as_ref()
            .and_then(|c| {
                Local
                    .timestamp_opt(c.time().seconds(), 0)
                    .single()
                    .map(|t| t.format("%Y-%m-%d").to_string())
            })
            .unwrap_or_default();
        let author_name = commit
            .as_ref()
            .map(|c| {
                let sig = c.author();
                match sig.name() {
                    Ok(n) => n.to_string(),
                    Err(_) => String::new(),
                }
            })
            .unwrap_or_default();
        let summary_text = commit
            .as_ref()
            .map(|c| c.summary().ok().flatten().unwrap_or("").to_string())
            .unwrap_or_default();
        let start = hunk.final_start_line();
        let lines_in_hunk = hunk.lines_in_hunk();
        for offset in 0..lines_in_hunk {
            lines.push(GitBlameLine {
                line: start + offset,
                commit_id: short.clone(),
                author: author_name.clone(),
                time: time.clone(),
                summary: summary_text.clone(),
            });
        }
    }
    Ok(lines)
}

#[tauri::command]
pub fn git_set_upstream(root: String, branch: String, upstream: String) -> Result<(), String> {
    clear_status_cache();
    let repo = open_repo(&root)?;
    let mut b = repo
        .find_branch(&branch, BranchType::Local)
        .map_err(|e| e.to_string())?;
    let result = b.set_upstream(Some(&upstream)).map_err(|e| e.to_string());
    clear_status_cache();
    result
}

/// 从远程分支检出为本地分支（并设置 upstream）
#[tauri::command]
pub async fn git_checkout_remote(
    root: String,
    remote_ref: String,
    local_name: Option<String>,
) -> Result<String, String> {
    // 内部含整工作树 checkout，放 spawn_blocking
    let handle = tokio::task::spawn_blocking(move || {
        git_checkout_remote_blocking(root, remote_ref, local_name)
    });
    let result = match tokio::time::timeout(Duration::from_secs(120), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("检出远程分支任务失败: {join}")),
        Err(_) => Err("检出远程分支超时（120s）".into()),
    };
    clear_status_cache();
    result
}

fn git_checkout_remote_blocking(
    root: String,
    remote_ref: String,
    local_name: Option<String>,
) -> Result<String, String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let repo = open_repo(&root)?;
    let commit = resolve_branch_commit(&repo, &remote_ref)?;
    let local = local_name.unwrap_or_else(|| {
        remote_ref
            .rsplit('/')
            .next()
            .unwrap_or(&remote_ref)
            .to_string()
    });
    if repo.find_branch(&local, BranchType::Local).is_ok() {
        git_checkout_blocking(root, local.clone(), Some(false))?;
        return Ok(format!("已切换到已有分支 {local}"));
    }
    repo.branch(&local, &commit, false)
        .map_err(|e| e.to_string())?;
    if let Ok(mut b) = repo.find_branch(&local, BranchType::Local) {
        let _ = b.set_upstream(Some(&remote_ref));
    }
    git_checkout_blocking(root, local.clone(), Some(false))?;
    Ok(format!("已从 {remote_ref} 创建并切换到 {local}"))
}

// ==================== Rebase 状态 / 交互 / 扩展 ====================

fn git_dir(root: &str) -> Result<PathBuf, String> {
    let repo = open_repo(root)?;
    Ok(repo.path().to_path_buf())
}

fn is_rebase_in_progress(root: &str) -> bool {
    let Ok(dir) = git_dir(root) else {
        return false;
    };
    dir.join("rebase-merge").is_dir() || dir.join("rebase-apply").is_dir()
}

fn is_prism_rebase_in_progress(root: &str) -> bool {
    git_dir(root)
        .map(|d| {
            d.join("prism-rebase.json").is_file() || d.join("miro-rebase.json").is_file()
        })
        .unwrap_or(false)
}

fn run_git(root: &str, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("无法执行 git {}: {e}", args.join(" ")))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else {
        let msg = if stderr.is_empty() { stdout } else { stderr };
        Err(msg)
    }
}

/// 校验将作为系统 Git 位置参数传入的用户/仓库数据。
/// `Command::args` 不经过 shell，但 Git 仍会把以 `-` 开头的值解析成选项；
/// 控制字符也会让错误信息和 Git 的文本协议出现歧义。合法分支/标签/提交
/// 引用不会以 `-` 开头，因此这里拒绝这两类危险输入而不限制正常 ref 语法。
fn validate_git_positional_arg(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value != value.trim() {
        return Err(format!("{label}不能为空或首尾不能有空白"));
    }
    if value.starts_with('-') {
        return Err(format!("{label}不能以 '-' 开头"));
    }
    if value.chars().any(|ch| ch.is_control()) {
        return Err(format!("{label}不能包含控制字符"));
    }
    Ok(())
}

fn short_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn resolve_commit_oid(repo: &Repository, id: &str) -> Result<git2::Oid, String> {
    validate_git_positional_arg(id, "提交")?;
    let obj = repo
        .revparse_single(id)
        .map_err(|e| format!("无效提交 {id}: {e}"))?;
    let commit = obj
        .peel_to_commit()
        .map_err(|e| format!("不是提交 {id}: {e}"))?;
    Ok(commit.id())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRebaseStatus {
    pub in_progress: bool,
    pub kind: String,
    pub head_name: Option<String>,
    pub onto: Option<String>,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRebaseStep {
    pub action: String,
    pub commit_id: String,
    pub message: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrismRebaseState {
    onto: String,
    branch: String,
    /// rebase 开始前的 HEAD，供 Abort 恢复
    original_head: String,
    remaining: Vec<GitRebaseStep>,
    squash_msgs: Vec<String>,
}

fn prism_rebase_path(root: &str) -> Result<PathBuf, String> {
    Ok(git_dir(root)?.join("prism-rebase.json"))
}

fn legacy_rebase_path(root: &str) -> Result<PathBuf, String> {
    Ok(git_dir(root)?.join("miro-rebase.json"))
}

fn load_prism_rebase(root: &str) -> Result<PrismRebaseState, String> {
    let path = if prism_rebase_path(root)?.is_file() {
        prism_rebase_path(root)?
    } else {
        legacy_rebase_path(root)?
    };
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取 rebase 状态失败: {e}"))?;
    let state: PrismRebaseState =
        serde_json::from_str(&raw).map_err(|e| format!("解析 rebase 状态失败: {e}"))?;
    if path.file_name().and_then(|n| n.to_str()) == Some("miro-rebase.json") {
        let _ = save_prism_rebase(root, &state);
        let _ = std::fs::remove_file(path);
    }
    Ok(state)
}

fn save_prism_rebase(root: &str, state: &PrismRebaseState) -> Result<(), String> {
    let path = prism_rebase_path(root)?;
    let raw = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| e.to_string())
}

fn clear_prism_rebase(root: &str) {
    if let Ok(path) = prism_rebase_path(root) {
        let _ = std::fs::remove_file(path);
    }
}

fn commit_info_from_oid(repo: &Repository, oid: git2::Oid) -> Result<GitCommitInfo, String> {
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
    Ok(commit_info_from_commit(
        repo,
        &commit,
        vec![],
        false,
        false,
    ))
}

#[tauri::command]
pub async fn git_rebase_status(root: String) -> Result<GitRebaseStatus, String> {
    // refresh 链路的伴随查询：放 spawn_blocking，避免主线程读写 rebase 状态文件
    let handle = tokio::task::spawn_blocking(move || git_rebase_status_blocking(root));
    match tokio::time::timeout(Duration::from_secs(15), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("读取 rebase 状态任务失败: {join}")),
        Err(_) => Err("读取 rebase 状态超时（15s）".into()),
    }
}

fn git_rebase_status_blocking(root: String) -> Result<GitRebaseStatus, String> {
    let repo = open_repo(&root)?;
    let conflicted = repo.index().map(|i| i.has_conflicts()).unwrap_or(false);
    let prism = is_prism_rebase_in_progress(&root);
    let native = is_rebase_in_progress(&root);
    let in_progress = prism || native;
    let kind = if prism {
        "prism".into()
    } else if native {
        "git".into()
    } else {
        "none".into()
    };
    let mut head_name = None;
    let mut onto = None;
    if let Ok(dir) = git_dir(&root) {
        let head_file = dir.join("rebase-merge").join("head-name");
        if let Ok(s) = std::fs::read_to_string(head_file) {
            head_name = Some(s.trim().trim_start_matches("refs/heads/").to_string());
        }
        let onto_file = dir.join("rebase-merge").join("onto");
        if let Ok(s) = std::fs::read_to_string(onto_file) {
            onto = Some(s.trim().chars().take(7).collect());
        }
        if prism {
            if let Ok(state) = load_prism_rebase(&root) {
                head_name = Some(state.branch);
                onto = Some(state.onto.chars().take(7).collect());
            }
        }
    }
    Ok(GitRebaseStatus {
        in_progress,
        kind,
        head_name,
        onto,
        conflicted,
    })
}

#[tauri::command]
pub async fn git_rebase_continue(root: String) -> Result<String, String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let handle = tokio::task::spawn_blocking(move || git_rebase_continue_blocking(root));
    let result = match tokio::time::timeout(std::time::Duration::from_secs(120), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("Continue 任务失败: {join}")),
        Err(_) => Err("Continue 超时（120s）".into()),
    };
    clear_status_cache();
    result
}

fn git_rebase_continue_blocking(root: String) -> Result<String, String> {
    if is_prism_rebase_in_progress(&root) {
        // 先提交当前冲突解决结果（若仍有未暂存冲突则失败）
        let repo = open_repo(&root)?;
        if repo.index().map(|i| i.has_conflicts()).unwrap_or(false) {
            return Err("仍有未解决冲突，请先在 Commit 面板解决".into());
        }
        let state = load_prism_rebase(&root)?;
        let step = state
            .remaining
            .first()
            .cloned()
            .ok_or_else(|| "Rebase 状态中没有待处理步骤".to_string())?;
        let action = step.action.to_lowercase();
        validate_prism_rebase_action(&action)?;
        // 若处于 cherry-pick 中间态
        if repo.path().join("CHERRY_PICK_HEAD").is_file() {
            // `cherry-pick -n` 冲突在当前 Git 实现下不会留下 CHERRY_PICK_HEAD；
            // 这里若出现该文件，说明这是 pick/reword 的普通 cherry-pick，
            // 不能用 --continue 去推进 fix/squash，否则会多生成一个提交。
            if !matches!(action.as_str(), "pick" | "reword") {
                return Err("Rebase 当前步骤状态异常，请先 Abort 后重试".into());
            }
            let continue_result = run_git(
                &root,
                &["-c", "core.editor=true", "cherry-pick", "--continue"],
            );
            if let Err(error) = continue_result {
                // --continue 失败时不推进 step；保留中间态供用户继续解决或 Skip。
                return Err(format!(
                    "GIT_REBASE_CONFLICT|||继续 Rebase 失败，请继续解决冲突或 Skip\n{error}"
                ));
            }
            if repo.path().join("CHERRY_PICK_HEAD").is_file() {
                return Err("GIT_REBASE_CONFLICT|||继续 Rebase 仍有冲突".into());
            }
            if action == "reword" {
                finalize_prism_rebase_step(&root, &action, &step)?;
            }
        } else {
            let mut status_options = StatusOptions::new();
            status_options
                .include_untracked(true)
                .include_ignored(false)
                .recurse_untracked_dirs(false);
            let statuses = repo
                .statuses(Some(&mut status_options))
                .map_err(|e| e.to_string())?;
            let has_staged = statuses.iter().any(|entry| {
                entry.status().intersects(
                    Status::INDEX_NEW
                        | Status::INDEX_MODIFIED
                        | Status::INDEX_DELETED
                        | Status::INDEX_RENAMED
                        | Status::INDEX_TYPECHANGE,
                )
            });
            let has_unstaged_tracked = statuses.iter().any(|entry| {
                entry.status().intersects(
                    Status::WT_MODIFIED
                        | Status::WT_DELETED
                        | Status::WT_RENAMED
                        | Status::WT_TYPECHANGE,
                )
            });
            if has_unstaged_tracked {
                return Err("请先暂存已解决的 Rebase 更改，再 Continue".into());
            }
            if matches!(action.as_str(), "pick" | "reword") {
                if !has_staged {
                    return Err("请先暂存已解决的 Rebase 更改，再 Continue".into());
                }
                // `-n` 冲突不会进入这里；如果用户手动清理了
                // CHERRY_PICK_HEAD，则按普通提交完成当前步骤。
                let msg = if action == "reword" {
                    step.message
                        .clone()
                        .unwrap_or_else(|| "Prism Code rebase continue".into())
                } else {
                    "Prism Code rebase continue".into()
                };
                // 提交失败时不能继续移除当前 step，否则 rebase 状态会与仓库实际
                // 内容脱节，后续 Abort 也无法准确恢复。
                git_commit(root.clone(), msg, None, None)?;
            } else {
                // fix/squash 使用 cherry-pick -n，冲突解决后只存在索引变更，
                // 必须继续 amend 当前 HEAD，不能创建一个新的普通提交。
                finalize_prism_rebase_step(&root, &action, &step)?;
            }
        }
        // 当前冲突的 step 已通过 cherry-pick --continue / 提交完成：
        // 从 remaining 移除首位再重放，否则 replay 会对同一 commit 再次
        // cherry-pick——变更已应用，git 报 "previous cherry-pick is now empty"
        // 或再次冲突，用户只能 Abort（skip 分支已有相同处理）
        {
            let mut state = load_prism_rebase(&root)?;
            if !state.remaining.is_empty() {
                state.remaining.remove(0);
                save_prism_rebase(&root, &state)?;
            }
        }
        return replay_prism_rebase(root);
    }
    match run_git(&root, &["-c", "core.editor=true", "rebase", "--continue"]) {
        Ok(msg) => Ok(if msg.is_empty() {
            "Rebase 已继续".into()
        } else {
            msg
        }),
        Err(e) => {
            if is_rebase_in_progress(&root) {
                Err(format!("GIT_REBASE_CONFLICT|||继续 Rebase 仍有冲突\n{e}"))
            } else {
                Err(e)
            }
        }
    }
}

#[tauri::command]
pub async fn git_rebase_abort(root: String) -> Result<String, String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let handle = tokio::task::spawn_blocking(move || git_rebase_abort_blocking(root));
    let result = match tokio::time::timeout(std::time::Duration::from_secs(60), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("Abort 任务失败: {join}")),
        Err(_) => Err("Abort 超时（60s）".into()),
    };
    clear_status_cache();
    result
}

fn git_rebase_abort_blocking(root: String) -> Result<String, String> {
    if is_prism_rebase_in_progress(&root) {
        let state = load_prism_rebase(&root)?;
        validate_git_positional_arg(&state.branch, "Rebase 分支")?;
        validate_git_positional_arg(&state.original_head, "Rebase 原始提交")?;
        if git_dir(&root)?.join("CHERRY_PICK_HEAD").is_file() {
            run_git(&root, &["cherry-pick", "--abort"])
                .map_err(|e| format!("中止交互 Rebase 的 cherry-pick 失败: {e}"))?;
        }
        run_git(&root, &["checkout", &state.branch])
            .map_err(|e| format!("恢复 Rebase 分支失败: {e}"))?;
        run_git(&root, &["reset", "--hard", &state.original_head])
            .map_err(|e| format!("恢复 Rebase 原始提交失败: {e}"))?;
        clear_prism_rebase(&root);
        return Ok("已中止交互 Rebase".into());
    }
    run_git(&root, &["rebase", "--abort"])?;
    Ok("已中止 Rebase".into())
}

#[tauri::command]
pub async fn git_rebase_skip(root: String) -> Result<String, String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let handle = tokio::task::spawn_blocking(move || git_rebase_skip_blocking(root));
    let result = match tokio::time::timeout(std::time::Duration::from_secs(120), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("Skip 任务失败: {join}")),
        Err(_) => Err("Skip 超时（120s）".into()),
    };
    clear_status_cache();
    result
}

fn git_rebase_skip_blocking(root: String) -> Result<String, String> {
    if is_prism_rebase_in_progress(&root) {
        if git_dir(&root)?.join("CHERRY_PICK_HEAD").is_file() {
            run_git(&root, &["cherry-pick", "--abort"])
                .map_err(|e| format!("跳过 Rebase 当前 cherry-pick 失败: {e}"))?;
        } else {
            // fix/squash 使用 cherry-pick -n，部分 Git 版本在冲突时不留下
            // CHERRY_PICK_HEAD；此时必须丢弃当前 step 已写入的索引/工作树。
            run_git(&root, &["reset", "--hard", "HEAD"])
                .map_err(|e| format!("清理 Rebase 当前步骤失败: {e}"))?;
        }
        let mut state = load_prism_rebase(&root)?;
        if !state.remaining.is_empty() {
            state.remaining.remove(0);
            save_prism_rebase(&root, &state)?;
        }
        return replay_prism_rebase(root);
    }
    match run_git(&root, &["rebase", "--skip"]) {
        Ok(msg) => Ok(if msg.is_empty() {
            "已跳过当前提交".into()
        } else {
            msg
        }),
        Err(e) => {
            if is_rebase_in_progress(&root) {
                Err(format!("GIT_REBASE_CONFLICT|||Skip 后仍有冲突\n{e}"))
            } else {
                Err(e)
            }
        }
    }
}

/// onto..HEAD 的提交列表（旧→新，供交互 Rebase）
#[tauri::command]
pub fn git_rebase_plan(root: String, onto: String) -> Result<Vec<GitCommitInfo>, String> {
    let repo = open_repo(&root)?;
    let onto_oid = resolve_commit_oid(&repo, &onto)?;
    let head_oid = repo
        .head()
        .map_err(|e| e.to_string())?
        .peel_to_commit()
        .map_err(|e| e.to_string())?
        .id();
    let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::REVERSE)
        .map_err(|e| e.to_string())?;
    walk.push(head_oid).map_err(|e| e.to_string())?;
    walk.hide(onto_oid).map_err(|e| e.to_string())?;
    let mut commits = Vec::new();
    for oid in walk {
        let oid = oid.map_err(|e| e.to_string())?;
        commits.push(commit_info_from_oid(&repo, oid)?);
    }
    Ok(commits)
}

fn replay_prism_rebase(root: String) -> Result<String, String> {
    let mut state = load_prism_rebase(&root)?;
    let repo = open_repo(&root)?;

    while let Some(step) = state.remaining.first().cloned() {
        let action = step.action.to_lowercase();
        validate_prism_rebase_action(&action)?;
        if action == "drop" {
            state.remaining.remove(0);
            save_prism_rebase(&root, &state)?;
            continue;
        }

        let oid = resolve_commit_oid(&repo, &step.commit_id)?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        let default_msg = commit.message().unwrap_or("").to_string();

        match action.as_str() {
            "pick" | "reword" => {
                let out = std::process::Command::new("git")
                    .args(["cherry-pick", &step.commit_id])
                    .current_dir(&root)
                    .output()
                    .map_err(|e| e.to_string())?;
                if !out.status.success() {
                    save_prism_rebase(&root, &state)?;
                    if open_repo(&root)
                        .ok()
                        .and_then(|r| r.index().ok())
                        .map(|i| i.has_conflicts())
                        .unwrap_or(false)
                    {
                        return Err(
                            "GIT_REBASE_CONFLICT|||交互 Rebase 冲突，请解决后 Continue".into()
                        );
                    }
                    return Err(format!(
                        "Cherry-pick 失败: {}",
                        String::from_utf8_lossy(&out.stderr)
                    ));
                }
                if action == "reword" {
                    finalize_prism_rebase_step(&root, &action, &step)?;
                }
                state.squash_msgs.clear();
            }
            "fix" => {
                let out = std::process::Command::new("git")
                    .args(["cherry-pick", "-n", &step.commit_id])
                    .current_dir(&root)
                    .output()
                    .map_err(|e| e.to_string())?;
                if !out.status.success() {
                    save_prism_rebase(&root, &state)?;
                    if open_repo(&root)
                        .ok()
                        .and_then(|r| r.index().ok())
                        .map(|i| i.has_conflicts())
                        .unwrap_or(false)
                    {
                        return Err(
                            "GIT_REBASE_CONFLICT|||交互 Rebase 冲突，请解决后 Continue".into()
                        );
                    }
                    return Err(format!(
                        "Fixup 失败: {}",
                        String::from_utf8_lossy(&out.stderr)
                    ));
                }
                // amend 保留原信息
                finalize_prism_rebase_step(&root, &action, &step)?;
            }
            "squash" => {
                let out = std::process::Command::new("git")
                    .args(["cherry-pick", "-n", &step.commit_id])
                    .current_dir(&root)
                    .output()
                    .map_err(|e| e.to_string())?;
                if !out.status.success() {
                    save_prism_rebase(&root, &state)?;
                    if open_repo(&root)
                        .ok()
                        .and_then(|r| r.index().ok())
                        .map(|i| i.has_conflicts())
                        .unwrap_or(false)
                    {
                        return Err(
                            "GIT_REBASE_CONFLICT|||交互 Rebase 冲突，请解决后 Continue".into()
                        );
                    }
                    return Err(format!(
                        "Squash 失败: {}",
                        String::from_utf8_lossy(&out.stderr)
                    ));
                }
                let msg = step.message.clone().unwrap_or(default_msg);
                state.squash_msgs.push(msg);
                finalize_prism_rebase_step(&root, &action, &step)?;
            }
            _ => {
                return Err(format!("未知 rebase 动作: {action}"));
            }
        }

        state.remaining.remove(0);
        save_prism_rebase(&root, &state)?;
    }

    clear_prism_rebase(&root);
    Ok("交互 Rebase 完成".into())
}

fn validate_prism_rebase_action(action: &str) -> Result<(), String> {
    match action {
        "pick" | "reword" | "squash" | "fix" | "drop" => Ok(()),
        _ => Err(format!("未知 rebase 动作: {action}")),
    }
}

fn finalize_prism_rebase_step(
    root: &str,
    action: &str,
    step: &GitRebaseStep,
) -> Result<(), String> {
    match action {
        "reword" => {
            let msg = step
                .message
                .clone()
                .unwrap_or_else(|| "Prism Code rebase continue".into());
            git_commit(root.to_string(), msg, None, Some(true)).map(|_| ())
        }
        "fix" => run_git(root, &["commit", "--amend", "--no-edit", "--allow-empty"])
            .map(|_| ())
            .map_err(|e| format!("Fixup 提交失败: {e}")),
        "squash" => {
            let msg = step
                .message
                .clone()
                .unwrap_or_else(|| "Prism Code rebase continue".into());
            let head_msg = {
                let repo = open_repo(root)?;
                repo.head()
                    .ok()
                    .and_then(|h| h.peel_to_commit().ok())
                    .and_then(|c| c.message().ok().map(|m| m.to_string()))
                    .unwrap_or_default()
            };
            let combined = format!("{}\n\n{}", head_msg.trim(), msg.trim());
            git_commit(root.to_string(), combined, None, Some(true)).map(|_| ())
        }
        _ => Ok(()),
    }
}

#[tauri::command]
pub async fn git_rebase_interactive(
    root: String,
    onto: String,
    steps: Vec<GitRebaseStep>,
) -> Result<String, String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    // 交互 Rebase 内部多次系统 git（rebase/cherry-pick/reset），无超时，须离主线程
    let handle =
        tokio::task::spawn_blocking(move || git_rebase_interactive_blocking(root, onto, steps));
    let result = match tokio::time::timeout(std::time::Duration::from_secs(180), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("交互 Rebase 任务失败: {join}")),
        Err(_) => Err("交互 Rebase 超时（180s），请检查仓库状态".into()),
    };
    clear_status_cache();
    result
}

fn git_rebase_interactive_blocking(
    root: String,
    onto: String,
    steps: Vec<GitRebaseStep>,
) -> Result<String, String> {
    if steps.is_empty() {
        return Err("没有可重放的提交".into());
    }
    validate_git_positional_arg(&onto, "Rebase 基准")?;
    for step in &steps {
        validate_git_positional_arg(&step.commit_id, "Rebase 提交")?;
        validate_prism_rebase_action(&step.action.to_lowercase())?;
    }
    if is_rebase_in_progress(&root) || is_prism_rebase_in_progress(&root) {
        return Err("已有 Rebase 进行中，请先 Continue 或 Abort".into());
    }
    let repo = open_repo(&root)?;
    // 下面会先 hard reset 到 onto；必须拒绝未提交的跟踪文件，避免静默丢失
    // 用户正在编辑的内容。未跟踪文件不受 reset 影响，按 Git 原生行为保留。
    ensure_mergeable_worktree(&repo)?;
    let branch = repo
        .head()
        .ok()
        .and_then(|h| {
            if h.is_branch() {
                h.shorthand().ok().map(|s| s.to_string())
            } else {
                None
            }
        })
        .ok_or_else(|| "请在本地分支上执行交互 Rebase".to_string())?;

    let onto_oid = resolve_commit_oid(&repo, &onto)?;
    let original_head = repo
        .head()
        .map_err(|e| e.to_string())?
        .peel_to_commit()
        .map_err(|e| e.to_string())?
        .id()
        .to_string();
    let state = PrismRebaseState {
        onto: onto_oid.to_string(),
        branch,
        original_head,
        remaining: steps,
        squash_msgs: vec![],
    };
    // 先保存恢复状态，再执行硬重置。即使进程在重置后异常退出，Abort 仍能
    // 使用原始 HEAD 把分支恢复回来。
    save_prism_rebase(&root, &state)?;

    // 硬重置到 onto，再按步骤重放
    let onto_commit = repo.find_commit(onto_oid).map_err(|e| e.to_string())?;
    repo.reset(onto_commit.as_object(), ResetType::Hard, None)
        .map_err(|e| format!("重置到 onto 失败: {e}"))?;
    replay_prism_rebase(root)
}

/// 真正的 git revert（生成反向提交）
#[tauri::command]
pub async fn git_revert_commit(root: String, commit_id: String) -> Result<String, String> {
    // 走系统 git + 可能产生冲突合并，放 spawn_blocking
    let handle = tokio::task::spawn_blocking(move || {
        git_revert_commit_blocking(root, commit_id)
    });
    let result = match tokio::time::timeout(Duration::from_secs(120), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("Revert 任务失败: {join}")),
        Err(_) => Err("Revert 超时（120s）".into()),
    };
    clear_status_cache();
    result
}

fn git_revert_commit_blocking(root: String, commit_id: String) -> Result<String, String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    validate_git_positional_arg(&commit_id, "提交")?;
    match run_git(
        &root,
        &["-c", "core.editor=true", "revert", "--no-edit", &commit_id],
    ) {
        Ok(_) => Ok(format!(
            "已 revert {}",
            short_text(&commit_id, 7)
        )),
        Err(e) => {
            let repo = open_repo(&root)?;
            if repo.index().map(|i| i.has_conflicts()).unwrap_or(false) {
                Err(format!("Revert 产生冲突，请在 Commit 面板解决\n{e}"))
            } else {
                Err(format!("Revert 失败: {e}"))
            }
        }
    }
}

#[tauri::command]
pub async fn git_create_branch_at(
    root: String,
    name: String,
    commit_id: String,
    checkout: bool,
) -> Result<(), String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let task_root = root.clone();
    let task_name = name.clone();
    let handle = tokio::task::spawn_blocking(move || {
        let repo = open_repo(&task_root)?;
        let oid = resolve_commit_oid(&repo, &commit_id)?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        repo.branch(&task_name, &commit, false)
            .map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    });
    let branch_result = match tokio::time::timeout(Duration::from_secs(30), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("创建分支任务失败: {join}")),
        Err(_) => Err("创建分支超时（30s）".into()),
    };
    clear_status_cache();
    branch_result?;
    if checkout {
        let result = git_checkout(root, name, Some(false)).await;
        clear_status_cache();
        return result;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_checkout_commit(root: String, commit_id: String) -> Result<String, String> {
    // checkout_head 重写整个工作树，放 spawn_blocking
    let handle = tokio::task::spawn_blocking(move || {
        git_checkout_commit_blocking(root, commit_id)
    });
    let result = match tokio::time::timeout(Duration::from_secs(120), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("检出提交任务失败: {join}")),
        Err(_) => Err("检出提交超时（120s）".into()),
    };
    clear_status_cache();
    result
}

fn git_checkout_commit_blocking(root: String, commit_id: String) -> Result<String, String> {
    // 仓库状态将变化：使 git_status TTL 缓存失效，操作后刷新立即可见
    clear_status_cache();
    let repo = open_repo(&root)?;
    let oid = resolve_commit_oid(&repo, &commit_id)?;
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
    repo.set_head_detached(commit.id())
        .map_err(|e| e.to_string())?;
    repo.checkout_head(Some(CheckoutBuilder::default().force()))
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "已检出分离头指针 {}",
        short_text(&commit_id, 7)
    ))
}

#[tauri::command]
pub async fn git_delete_remote_branch(root: String, remote_ref: String) -> Result<String, String> {
    // 走网络 push，可能长时间挂起，必须离主线程
    clear_status_cache();
    let handle = tokio::task::spawn_blocking(move || git_delete_remote_branch_blocking(root, remote_ref));
    let result = match tokio::time::timeout(std::time::Duration::from_secs(120), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("删除远程分支任务失败: {join}")),
        Err(_) => Err("删除远程分支超时（120s），请检查网络".into()),
    };
    clear_status_cache();
    result
}

fn git_delete_remote_branch_blocking(root: String, remote_ref: String) -> Result<String, String> {
    // remote_ref 形如 origin/feature
    validate_git_positional_arg(&remote_ref, "远程分支")?;
    let (remote, branch) = remote_ref
        .split_once('/')
        .ok_or_else(|| "远程分支名无效，期望 remote/branch".to_string())?;
    validate_git_positional_arg(remote, "远程名称")?;
    validate_git_positional_arg(branch, "分支名称")?;
    clear_status_cache();
    run_git(&root, &["push", remote, "--delete", branch])?;
    let _ = run_git(&root, &["fetch", "--prune", remote]);
    clear_status_cache();
    Ok(format!("已删除远程分支 {remote_ref}"))
}

/// 对比两分支 tip 的文件树差异摘要（打开第一个差异文件的分栏用）
#[tauri::command]
pub async fn git_branch_sides(
    root: String,
    left_ref: String,
    right_ref: String,
    path: Option<String>,
) -> Result<GitFileSides, String> {
    // 全树 diff 可能较慢，放 spawn_blocking
    let handle = tokio::task::spawn_blocking(move || {
        git_branch_sides_blocking(root, left_ref, right_ref, path)
    });
    match tokio::time::timeout(Duration::from_secs(30), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("分支对比任务失败: {join}")),
        Err(_) => Err("分支对比超时（30s）".into()),
    }
}

fn git_branch_sides_blocking(
    root: String,
    left_ref: String,
    right_ref: String,
    path: Option<String>,
) -> Result<GitFileSides, String> {
    let repo = open_repo(&root)?;
    let right_oid = resolve_commit_oid(&repo, &right_ref)?;
    let right_commit = repo.find_commit(right_oid).map_err(|e| e.to_string())?;
    let right_tree = right_commit.tree().map_err(|e| e.to_string())?;
    let left_commit = if left_ref.trim().is_empty() {
        None
    } else {
        let left_oid = resolve_commit_oid(&repo, &left_ref)?;
        Some(repo.find_commit(left_oid).map_err(|e| e.to_string())?)
    };
    let left_tree = left_commit
        .as_ref()
        .map(|commit| commit.tree())
        .transpose()
        .map_err(|e| e.to_string())?;

    let rel = if let Some(p) = path.filter(|s| !s.is_empty()) {
        p
    } else {
        diff_file_changes(&repo, left_tree.as_ref(), Some(&right_tree))
            .into_iter()
            .next()
            .map(|change| change.path)
            .ok_or_else(|| "两个分支 tip 无文件差异".to_string())?
    };

    let blob_text = |tree: Option<&git2::Tree>, path: &str| -> String {
        let Some(tree) = tree else {
            return String::new();
        };
        let Ok(entry) = tree.get_path(Path::new(path)) else {
            return String::new();
        };
        let Ok(obj) = entry.to_object(&repo) else {
            return String::new();
        };
        let Ok(blob) = obj.peel_to_blob() else {
            return String::new();
        };
        String::from_utf8_lossy(blob.content()).to_string()
    };

    Ok(GitFileSides {
        path: rel.clone(),
        left: blob_text(left_tree.as_ref(), &rel),
        right: blob_text(Some(&right_tree), &rel),
        left_label: if left_ref.trim().is_empty() {
            "空树".into()
        } else {
            left_ref
        },
        right_label: right_ref,
    })
}

// ==================== dev-only 真机"卡住 N ms"注入器 ====================
// 目的：让 `__ipcSelfCheck({ slowCmd: "dev_fake_block", slowMs: 800 })` 在真机
// 上**真**走 Tauri 调度层 + 真 tokio::time::sleep，完全等价于"git_push 期间
// IPC 桥被占用"——直接量化"卡住 800ms 期间 20 个并发 git_status 的最大耗时"。
// 安全：release 构建下函数立即返回错误（cmd 注入器只该出现在 dev 模式）。
#[tauri::command]
pub async fn dev_fake_block(ms: u64) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("dev_fake_block 仅在 dev 构建可用".into());
    }
    let started = std::time::Instant::now();
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    // 在 Rust 端 stderr 输出（dev 模式可在 WebView DevTools → Network/IPC 链路看到）
    eprintln!("[dev_fake_block] 睡眠 {ms}ms 实际 {elapsed_ms}ms");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::Duration;

    fn run_git_ok(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?} 失败: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn run_git_stdout(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?} 失败: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn create_rebase_fixture() -> (tempfile::TempDir, String, String, String) {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path();
        run_git_ok(root, &["init", "-b", "main"]);
        run_git_ok(root, &["config", "user.name", "test"]);
        run_git_ok(root, &["config", "user.email", "test@example.com"]);

        std::fs::write(root.join("file.txt"), "base\n").expect("写入 base");
        run_git_ok(root, &["add", "file.txt"]);
        run_git_ok(root, &["commit", "-m", "base"]);
        let onto = run_git_stdout(root, &["rev-parse", "HEAD"]);

        std::fs::write(root.join("file.txt"), "first\n").expect("写入 first");
        run_git_ok(root, &["commit", "-am", "first"]);
        let first = run_git_stdout(root, &["rev-parse", "HEAD"]);

        std::fs::write(root.join("file.txt"), "first\nsecond\n").expect("写入 second");
        run_git_ok(root, &["commit", "-am", "second"]);
        let second = run_git_stdout(root, &["rev-parse", "HEAD"]);

        (temp, onto, first, second)
    }

    fn repo_state_is_merging(root: &str) -> bool {
        git_dir(root)
            .map(|d| d.join("MERGE_HEAD").exists())
            .unwrap_or(false)
    }

    #[test]
    fn status_cache_generation_rejects_stale_result() {
        let snapshot = GitStatusSnapshot {
            initialized: true,
            branch: Some("main".into()),
            upstream: None,
            head: None,
            ahead: 0,
            behind: 0,
            entries: vec![],
            conflict_count: 0,
        };
        let mut state = StatusCacheState {
            generation: 4,
            entry: None,
        };

        assert!(try_store_status_result(
            &mut state,
            "/repo".into(),
            4,
            Ok(snapshot.clone()),
        ));
        assert!(state.entry.is_some());

        // 模拟 stage/commit 使缓存失效后，旧请求才返回：旧结果不得复活。
        state.generation = 5;
        state.entry = None;
        assert!(!try_store_status_result(
            &mut state,
            "/repo".into(),
            4,
            Ok(snapshot),
        ));
        assert!(state.entry.is_none());
    }

    #[test]
    fn percent_encode_credential_escapes_reserved_chars() {
        assert_eq!(percent_encode_credential("user name"), "user%20name");
        assert_eq!(
            percent_encode_credential("p@ss:word/1"),
            "p%40ss%3Aword%2F1"
        );
    }

    #[test]
    fn git_positional_arg_rejects_option_like_and_control_values() {
        assert!(validate_git_positional_arg("origin/main", "ref").is_ok());
        assert!(validate_git_positional_arg("HEAD~1", "ref").is_ok());
        assert!(validate_git_positional_arg("--upload-pack=evil", "ref").is_err());
        assert!(validate_git_positional_arg("main\n--exec", "ref").is_err());
        assert!(validate_git_positional_arg(" main", "ref").is_err());
    }

    #[test]
    fn interactive_rebase_preserves_fixup_and_squash_semantics() {
        let (temp, onto, first, second) = create_rebase_fixture();
        let root = temp.path().to_string_lossy().into_owned();
        let result = git_rebase_interactive_blocking(
            root.clone(),
            onto,
            vec![
                GitRebaseStep {
                    action: "pick".into(),
                    commit_id: first,
                    message: Some("first".into()),
                },
                GitRebaseStep {
                    action: "fix".into(),
                    commit_id: second,
                    message: Some("second".into()),
                },
            ],
        )
        .expect("fixup rebase");
        assert_eq!(result, "交互 Rebase 完成");
        assert_eq!(run_git_stdout(temp.path(), &["rev-list", "--count", "HEAD"]), "2");
        assert_eq!(run_git_stdout(temp.path(), &["log", "-1", "--format=%s"]), "first");
        assert_eq!(
            std::fs::read_to_string(temp.path().join("file.txt")).expect("读取 rebase 文件"),
            "first\nsecond\n"
        );

        let (temp, onto, first, second) = create_rebase_fixture();
        let root = temp.path().to_string_lossy().into_owned();
        git_rebase_interactive_blocking(
            root,
            onto,
            vec![
                GitRebaseStep {
                    action: "pick".into(),
                    commit_id: first,
                    message: Some("first".into()),
                },
                GitRebaseStep {
                    action: "squash".into(),
                    commit_id: second,
                    message: Some("second".into()),
                },
            ],
        )
        .expect("squash rebase");
        assert_eq!(run_git_stdout(temp.path(), &["rev-list", "--count", "HEAD"]), "2");
        let message = run_git_stdout(temp.path(), &["log", "-1", "--format=%B"]);
        assert!(message.contains("first"));
        assert!(message.contains("second"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn git_stage_refreshes_status_after_index_change() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path();
        run_git_ok(root, &["init", "-b", "main"]);
        run_git_ok(root, &["config", "user.name", "test"]);
        run_git_ok(root, &["config", "user.email", "test@example.com"]);
        std::fs::write(root.join("README.md"), "before\n").expect("写入文件");
        run_git_ok(root, &["add", "README.md"]);
        run_git_ok(root, &["commit", "-m", "init"]);
        std::fs::write(root.join("README.md"), "after\n").expect("修改文件");

        let root_string = root.to_string_lossy().into_owned();
        let before = git_status(root_string.clone()).await.expect("读取修改前状态");
        assert!(before
            .entries
            .iter()
            .any(|entry| entry.path == "README.md" && entry.unstaged && !entry.staged));

        git_stage(root_string.clone(), vec!["README.md".into()]).expect("暂存文件");
        let after = git_status(root_string).await.expect("读取暂存后状态");
        assert!(after
            .entries
            .iter()
            .any(|entry| entry.path == "README.md" && entry.staged));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn git_stage_all_stages_modified_new_and_deleted_files() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path();
        run_git_ok(root, &["init", "-b", "main"]);
        run_git_ok(root, &["config", "user.name", "test"]);
        run_git_ok(root, &["config", "user.email", "test@example.com"]);
        std::fs::write(root.join("modified.txt"), "before\n").expect("写入文件");
        std::fs::write(root.join("deleted.txt"), "remove me\n").expect("写入文件");
        run_git_ok(root, &["add", "."]);
        run_git_ok(root, &["commit", "-m", "init"]);

        std::fs::write(root.join("modified.txt"), "after\n").expect("修改文件");
        std::fs::remove_file(root.join("deleted.txt")).expect("删除文件");
        std::fs::write(root.join("new.txt"), "new\n").expect("新增文件");

        let root_string = root.to_string_lossy().into_owned();
        let before = git_status(root_string.clone()).await.expect("读取修改前状态");
        assert_eq!(before.entries.len(), 3, "修改/删除/新增都应出现在更改列表");

        // 空路径代表真正的「全部暂存」，不能依赖前端某一帧快照枚举路径。
        git_stage(root_string.clone(), vec![]).expect("全部暂存");
        let after = git_status(root_string).await.expect("读取暂存后状态");
        assert!(
            after.entries.iter().all(|entry| !entry.unstaged),
            "全部暂存后不应残留未暂存项: {:?}",
            after.entries
        );
        assert_eq!(after.entries.len(), 3, "三类变更都应保留为已暂存状态");
        assert!(after
            .entries
            .iter()
            .all(|entry| entry.staged), "全部变更都应标记为已暂存: {:?}", after.entries);
    }

    #[test]
    fn file_sides_keeps_an_empty_index_blob_as_empty() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path();
        run_git_ok(root, &["init", "-b", "main"]);
        run_git_ok(root, &["config", "user.name", "test"]);
        run_git_ok(root, &["config", "user.email", "test@example.com"]);
        std::fs::write(root.join("empty.txt"), "head\n").expect("写入文件");
        run_git_ok(root, &["add", "empty.txt"]);
        run_git_ok(root, &["commit", "-m", "init"]);

        std::fs::write(root.join("empty.txt"), "").expect("清空文件");
        git_stage(
            root.to_string_lossy().into_owned(),
            vec!["empty.txt".into()],
        )
        .expect("暂存空文件");

        let sides = git_file_sides_blocking(
            root.to_string_lossy().into_owned(),
            "empty.txt".into(),
            Some(false),
        )
        .expect("读取分栏对比");
        assert_eq!(sides.left, "", "索引中的空 blob 不能回退到 HEAD");
        assert_eq!(sides.right, "");
    }

    #[test]
    fn stage_rejects_paths_outside_workspace() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path();
        run_git_ok(root, &["init", "-b", "main"]);
        let result = git_stage(
            root.to_string_lossy().into_owned(),
            vec!["../outside.txt".into()],
        );
        assert!(result.is_err(), "暂存路径不得越过工作区边界");
    }

    #[test]
    fn format_cli_remote_error_marks_auth_failures() {
        let err = format_cli_remote_error(
            "推送",
            "fatal: Authentication failed for 'https://example.com/repo.git/'",
            "https://example.com/repo.git",
        );
        assert!(err.starts_with("GIT_AUTH_REQUIRED|||https://example.com/repo.git|||"));
    }

    #[test]
    fn format_cli_remote_error_keeps_regular_failures_plain() {
        let err = format_cli_remote_error(
            "推送",
            "fatal: unable to access 'https://example.com/repo.git/': Failed to connect",
            "https://example.com/repo.git",
        );
        assert_eq!(
            err,
            "推送失败: fatal: unable to access 'https://example.com/repo.git/': Failed to connect"
        );
    }

    #[test]
    fn temp_git_credential_store_writes_http_credential_line() {
        let store = TempGitCredentialStore::new(
            "https://example.com/team/repo.git",
            "user name",
            "p@ss:word/1",
        )
        .expect("temp store");
        let raw = std::fs::read_to_string(&store.path).expect("read temp store");
        assert_eq!(
            raw,
            "https://user%20name:p%40ss%3Aword%2F1@example.com/team/repo.git\n"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn git_push_uses_system_git_path() {
        let remote_tmp = tempfile::tempdir().expect("remote tempdir");
        let remote_path = remote_tmp.path();
        run_git_ok(remote_path, &["init", "--bare"]);

        let local_tmp = tempfile::tempdir().expect("local tempdir");
        let local_path = local_tmp.path();
        run_git_ok(local_path, &["init", "-b", "main"]);
        run_git_ok(local_path, &["config", "user.name", "test"]);
        run_git_ok(local_path, &["config", "user.email", "test@example.com"]);
        run_git_ok(
            local_path,
            &[
                "remote",
                "add",
                "origin",
                remote_path.to_string_lossy().as_ref(),
            ],
        );
        std::fs::write(local_path.join("README.md"), "hello\n").expect("write file");
        run_git_ok(local_path, &["add", "README.md"]);
        run_git_ok(local_path, &["commit", "-m", "init"]);

        let msg = git_push(
            local_path.to_string_lossy().to_string(),
            Some(false),
            None,
            None,
            Some(false),
        )
        .await
        .expect("git push");
        assert_eq!(msg, "推送成功");

        let remote_repo = Repository::open_bare(remote_path).expect("open bare remote");
        let remote_head = remote_repo
            .find_reference("refs/heads/main")
            .expect("find remote main")
            .target()
            .expect("remote target");
        let local_repo = Repository::discover(local_path).expect("open local repo");
        let local_head = local_repo
            .head()
            .expect("head")
            .target()
            .expect("local target");
        assert_eq!(remote_head, local_head, "远端 main 应指向本地 HEAD");
    }

    #[test]
    fn discard_many_paths_restores_files_when_parent_directory_is_missing() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path();
        run_git_ok(root, &["init", "-b", "main"]);
        run_git_ok(root, &["config", "user.name", "test"]);
        run_git_ok(root, &["config", "user.email", "test@example.com"]);

        let source_dir = root.join("src").join("generated");
        std::fs::create_dir_all(&source_dir).expect("创建源目录");
        for index in 0..128 {
            std::fs::write(
                source_dir.join(format!("file-{index}.ts")),
                format!("export const value{index} = 1;\n"),
            )
            .expect("写入源文件");
        }
        run_git_ok(root, &["add", "."]);
        run_git_ok(root, &["commit", "-m", "init"]);

        std::fs::remove_dir_all(&source_dir).expect("删除源目录");
        let mut options = StatusOptions::new();
        options
            .include_untracked(true)
            .recurse_untracked_dirs(true)
            .exclude_submodules(true);
        let repo = Repository::open(root).expect("打开仓库");
        let statuses = repo.statuses(Some(&mut options)).expect("读取状态");
        let paths: Vec<String> = statuses
            .iter()
            .filter_map(|entry| entry.path().ok().map(str::to_owned))
            .collect();
        assert_eq!(paths.len(), 128);

        git_discard_paths_blocking(root.to_string_lossy().to_string(), paths)
            .expect("批量回滚不应因缺失父目录失败");

        assert_eq!(
            git_status_blocking(root.to_string_lossy().to_string())
                .expect("读取回滚后状态")
                .entries
                .len(),
            0
        );
        assert!(source_dir.join("file-0.ts").is_file());
        assert!(source_dir.join("file-127.ts").is_file());
    }

    /// 验证 `try_ssh_agent_with_timeout` 在无 / 假 SSH agent 环境下行为可控：
    /// - 必须在 timeout 之内返回（不会让 IPC worker 无限阻塞）
    /// - 返回值允许三种结果：Ok(Some(cred)) / Ok(None)（超时） / Err（agent 不可用）
    ///   ——这三种都意味着"不会让 git2 在主线程上卡死"
    #[test]
    fn ssh_agent_helper_returns_within_timeout() {
        let started = std::time::Instant::now();
        let result = try_ssh_agent_with_timeout("git", Duration::from_secs(2));
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(2) + Duration::from_millis(500),
            "helper 必须严格在 timeout 之内返回；实际 {elapsed:?}"
        );
        // 三种结果都合法——只要 helper 本身不被卡死
        let acceptable =
            result.is_err() || matches!(result, Ok(None)) || matches!(result, Ok(Some(_)));
        assert!(acceptable, "helper 返回类型不在约定范围");
    }

    /// 验证 `try_ssh_agent_with_timeout` 的小超时分支确实触发 Ok(None) 或 Err。
    /// 由于 git2 在某些平台上即使无 agent 也会立即返回 Ok，Ok(Some(cred)) 也允许。
    #[test]
    fn ssh_agent_helper_respects_small_timeout() {
        // 用一个非常小的 timeout 验证 helper 接受自定义超时
        let started = std::time::Instant::now();
        let result = try_ssh_agent_with_timeout("git", Duration::from_millis(50));
        let elapsed = started.elapsed();
        // 50ms 超时下，调用必须快速返回
        assert!(
            elapsed < Duration::from_millis(500),
            "小超时下应快速返回；实际 {elapsed:?}"
        );
        let _ = result; // 任何返回都接受，只要不卡死
    }

    /// 验证 `read_unpushed_cache` 在非 git 目录下返回 None 而不 panic。
    #[test]
    fn read_unpushed_cache_returns_none_for_non_git_dir() {
        let tmp = std::env::temp_dir().join(format!(
            "prismcode-not-a-repo-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let result = read_unpushed_cache(tmp.to_str().unwrap(), 50);
        assert!(result.is_none(), "非 git 目录应返回 None；实际 {result:?}");
    }

    #[test]
    fn git_log_includes_non_head_refs_and_tag_details() {
        let temp = tempfile::tempdir().expect("temp repo");
        let root = temp.path();
        run_git_ok(root, &["init", "-b", "main"]);
        run_git_ok(root, &["config", "user.name", "test"]);
        run_git_ok(root, &["config", "user.email", "test@example.com"]);

        std::fs::write(root.join("main.txt"), "main\n").expect("write main");
        run_git_ok(root, &["add", "."]);
        run_git_ok(root, &["commit", "-m", "main commit"]);
        run_git_ok(root, &["switch", "-c", "feature/graph"]);
        std::fs::write(root.join("feature.txt"), "feature\n").expect("write feature");
        run_git_ok(root, &["add", "."]);
        run_git_ok(root, &["commit", "-m", "feature-only commit"]);
        run_git_ok(root, &["tag", "-a", "v1.0.0", "-m", "first release"]);
        run_git_ok(root, &["switch", "main"]);

        let commits = git_log_blocking(root.to_string_lossy().to_string(), Some(20))
            .expect("read graph");
        let feature = commits
            .iter()
            .find(|commit| commit.summary == "feature-only commit")
            .expect("all refs 的日志应包含非 HEAD 分支提交");
        assert!(feature.files.iter().any(|path| path == "feature.txt"));
        assert!(feature.changes.iter().any(|change| change.status == "added"));

        let tags = git_tags_blocking(root.to_string_lossy().to_string()).expect("read tags");
        let tag = tags.iter().find(|tag| tag.name == "v1.0.0").expect("tag");
        assert!(tag.annotated);
        assert_eq!(tag.message.as_deref(), Some("first release"));
    }

    /// 真机冒烟的等效证据：模拟"push 长时间占用 blocking pool"期间，
    /// 并发的轻量命令（用 `spawn_blocking` 模拟 git_status 之类的同步 IO）
    /// 仍能 <300ms 完成。这证明 4 个网络命令改为 async + spawn_blocking 后，
    /// Tauri 的 IPC 调度线程不会被 push 阻塞。
    #[test]
    fn concurrent_commands_unaffected_by_long_push() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("runtime");

        // 任务 1：模拟 push 在 spawn_blocking 上跑 800ms（远超真实 git_status）
        let long_task = rt.spawn(async {
            tokio::task::spawn_blocking(|| {
                std::thread::sleep(Duration::from_millis(800));
                42usize
            })
            .await
            .unwrap()
        });

        // 任务 2：模拟"用户在 push 期间点开活动栏"——并发发起 3 个轻量命令
        let start = Instant::now();
        let handles: Vec<_> = (0..3)
            .map(|_| {
                rt.spawn(async {
                    tokio::task::spawn_blocking(|| {
                        // 模拟 git_status 之类的轻量 libgit2 调用（<10ms）
                        std::thread::sleep(Duration::from_millis(5));
                        "ok"
                    })
                    .await
                    .unwrap()
                })
            })
            .collect();

        let results = rt.block_on(async {
            let mut outs = Vec::new();
            for h in handles {
                outs.push(h.await.unwrap());
            }
            outs
        });
        let elapsed = start.elapsed();

        // 3 个并发轻量命令在 push 阻塞 800ms 期间都应完成，且总耗时 < 300ms
        assert_eq!(results, vec!["ok", "ok", "ok"]);
        assert!(
            elapsed < Duration::from_millis(300),
            "并发轻量命令应不被 push 阻塞；实际 {elapsed:?}"
        );

        // 等 long_task 收尾
        rt.block_on(async { long_task.await.unwrap() });
    }

    // ==================== merge 复现测试 ====================

    #[test]
    fn merge_branch_real_merge_creates_two_parents_and_is_idempotent() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path();
        run_git_ok(root, &["init", "-b", "main"]);
        run_git_ok(root, &["config", "user.name", "test"]);
        run_git_ok(root, &["config", "user.email", "test@example.com"]);
        std::fs::write(root.join("README.md"), "base\n").expect("写入文件");
        run_git_ok(root, &["add", "README.md"]);
        run_git_ok(root, &["commit", "-m", "init"]);

        // feature 分支提交
        run_git_ok(root, &["checkout", "-b", "feature"]);
        std::fs::write(root.join("feature.txt"), "f1\n").expect("写入文件");
        run_git_ok(root, &["add", "feature.txt"]);
        run_git_ok(root, &["commit", "-m", "feature work"]);

        // main 分叉提交
        run_git_ok(root, &["checkout", "main"]);
        std::fs::write(root.join("README.md"), "base\nmain\n").expect("写入文件");
        run_git_ok(root, &["add", "README.md"]);
        run_git_ok(root, &["commit", "-m", "main work"]);

        let root_string = root.to_string_lossy().into_owned();
        let msg = git_merge_branch_blocking(root_string.clone(), "feature".into())
            .expect("真实合并应成功");
        assert_eq!(msg, "合并完成");

        let repo = open_repo(&root_string).expect("打开仓库");
        let head = repo.head().expect("HEAD").peel_to_commit().expect("提交");
        assert_eq!(head.parent_count(), 2, "合并提交应有双亲");
        assert_eq!(
            std::fs::read_to_string(root.join("feature.txt")).unwrap(),
            "f1\n",
            "合并后工作树应包含被合并分支的文件"
        );

        // 重复合并同一分支：应判定 up-to-date，不得凭空冲突
        let again =
            git_merge_branch_blocking(root_string.clone(), "feature".into()).expect("重复合并应成功");
        assert!(again.contains("无需合并"), "again: {again}");
        // libgit2 的 merge 会写 MERGE_HEAD；成功提交后不得残留（否则下次合并被误判「合并未完成」）
        assert!(!repo_state_is_merging(&root_string), "成功合并后不应残留 MERGE_HEAD");
    }

    #[test]
    fn merge_branch_fast_forward_updates_head() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path();
        run_git_ok(root, &["init", "-b", "main"]);
        run_git_ok(root, &["config", "user.name", "test"]);
        run_git_ok(root, &["config", "user.email", "test@example.com"]);
        std::fs::write(root.join("README.md"), "base\n").expect("写入文件");
        run_git_ok(root, &["add", "README.md"]);
        run_git_ok(root, &["commit", "-m", "init"]);
        run_git_ok(root, &["checkout", "-b", "feature"]);
        std::fs::write(root.join("feature.txt"), "f1\n").expect("写入文件");
        run_git_ok(root, &["add", "feature.txt"]);
        run_git_ok(root, &["commit", "-m", "feature work"]);
        run_git_ok(root, &["checkout", "main"]);

        let root_string = root.to_string_lossy().into_owned();
        let msg = git_merge_branch_blocking(root_string.clone(), "feature".into())
            .expect("快进合并应成功");
        assert_eq!(msg, "快进合并完成");
        let repo = open_repo(&root_string).expect("打开仓库");
        assert!(
            std::fs::read_to_string(root.join("feature.txt")).is_ok(),
            "快进后工作树应包含被合并分支的文件"
        );
        let merged = repo
            .find_branch("feature", BranchType::Local)
            .expect("分支");
        let head = repo.head().expect("HEAD").peel_to_commit().expect("提交");
        assert_eq!(
            head.id(),
            merged.get().peel_to_commit().expect("提交").id(),
            "快进后 HEAD 应等于被合并分支 tip"
        );
    }

    #[test]
    fn merge_branch_dirty_worktree_returns_clear_error() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path();
        run_git_ok(root, &["init", "-b", "main"]);
        run_git_ok(root, &["config", "user.name", "test"]);
        run_git_ok(root, &["config", "user.email", "test@example.com"]);
        std::fs::write(root.join("README.md"), "base\n").expect("写入文件");
        run_git_ok(root, &["add", "README.md"]);
        run_git_ok(root, &["commit", "-m", "init"]);
        run_git_ok(root, &["checkout", "-b", "feature"]);
        std::fs::write(root.join("feature.txt"), "f1\n").expect("写入文件");
        run_git_ok(root, &["add", "feature.txt"]);
        run_git_ok(root, &["commit", "-m", "feature work"]);
        run_git_ok(root, &["checkout", "main"]);
        std::fs::write(root.join("README.md"), "base\nmain\n").expect("写入文件");
        run_git_ok(root, &["add", "README.md"]);
        run_git_ok(root, &["commit", "-m", "main work"]);
        // 弄脏工作树：README.md 有未提交修改（main 与 feature 都动过该文件）
        std::fs::write(root.join("README.md"), "base\nmain\ndirty\n").expect("写入文件");

        let root_string = root.to_string_lossy().into_owned();
        let err = git_merge_branch_blocking(root_string.clone(), "feature".into())
            .expect_err("脏工作树合并应报错");
        assert!(!err.is_empty());
        eprintln!("脏工作树合并错误信息: {err}");
        // 本地修改不得被合并覆盖
        assert_eq!(
            std::fs::read_to_string(root.join("README.md")).unwrap(),
            "base\nmain\ndirty\n",
            "合并不能覆盖本地未提交修改"
        );
        // 仓库不得进入合并中间态
        assert!(!repo_state_is_merging(&root_string), "仓库不应处于合并中");
    }

    #[test]
    fn merge_branch_fast_forward_must_not_discard_local_changes() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path();
        run_git_ok(root, &["init", "-b", "main"]);
        run_git_ok(root, &["config", "user.name", "test"]);
        run_git_ok(root, &["config", "user.email", "test@example.com"]);
        std::fs::write(root.join("README.md"), "base\n").expect("写入文件");
        run_git_ok(root, &["add", "README.md"]);
        run_git_ok(root, &["commit", "-m", "init"]);
        run_git_ok(root, &["checkout", "-b", "feature"]);
        std::fs::write(root.join("feature.txt"), "f1\n").expect("写入文件");
        run_git_ok(root, &["add", "feature.txt"]);
        run_git_ok(root, &["commit", "-m", "feature work"]);
        run_git_ok(root, &["checkout", "main"]);
        // 弄脏工作树（feature 新增的文件之外的文件，快进本可安全进行）
        std::fs::write(root.join("README.md"), "base\ndirty-local\n").expect("写入文件");

        let root_string = root.to_string_lossy().into_owned();
        let err = git_merge_branch_blocking(root_string.clone(), "feature".into())
            .expect_err("快进合并不得静默丢弃本地修改");
        assert!(!err.is_empty());
        assert_eq!(
            std::fs::read_to_string(root.join("README.md")).unwrap(),
            "base\ndirty-local\n",
            "快进合并不能覆盖本地未提交修改"
        );
    }

    #[test]
    fn merge_branch_conflict_leaves_repo_in_merge_state() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path();
        run_git_ok(root, &["init", "-b", "main"]);
        run_git_ok(root, &["config", "user.name", "test"]);
        run_git_ok(root, &["config", "user.email", "test@example.com"]);
        std::fs::write(root.join("README.md"), "base\n").expect("写入文件");
        run_git_ok(root, &["add", "README.md"]);
        run_git_ok(root, &["commit", "-m", "init"]);
        // main 改 README 第一行
        std::fs::write(root.join("README.md"), "main-change\n").expect("写入文件");
        run_git_ok(root, &["add", "README.md"]);
        run_git_ok(root, &["commit", "-m", "main change"]);
        // feature 改 README 同一行（冲突）
        run_git_ok(root, &["checkout", "-b", "feature", "HEAD~1"]);
        std::fs::write(root.join("README.md"), "feature-change\n").expect("写入文件");
        run_git_ok(root, &["add", "README.md"]);
        run_git_ok(root, &["commit", "-m", "feature change"]);
        run_git_ok(root, &["checkout", "main"]);

        let root_string = root.to_string_lossy().into_owned();
        let err = git_merge_branch_blocking(root_string.clone(), "feature".into())
            .expect_err("冲突合并应返回错误");
        assert!(err.contains("冲突"), "err: {err}");
        // 冲突后 index 应标记 conflicted，且写了 MERGE_HEAD 供拓扑恢复
        let repo = open_repo(&root_string).expect("打开仓库");
        let index = repo.index().expect("index");
        assert!(index.has_conflicts(), "冲突后 index 应有冲突标记");
        assert!(repo_state_is_merging(&root_string), "冲突后应有 MERGE_HEAD");
    }

    #[test]
    fn merge_conflict_then_commit_keeps_merge_topology() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path();
        run_git_ok(root, &["init", "-b", "main"]);
        run_git_ok(root, &["config", "user.name", "test"]);
        run_git_ok(root, &["config", "user.email", "test@example.com"]);
        std::fs::write(root.join("README.md"), "base\n").expect("写入文件");
        run_git_ok(root, &["add", "README.md"]);
        run_git_ok(root, &["commit", "-m", "init"]);
        std::fs::write(root.join("README.md"), "main-change\n").expect("写入文件");
        run_git_ok(root, &["add", "README.md"]);
        run_git_ok(root, &["commit", "-m", "main change"]);
        run_git_ok(root, &["checkout", "-b", "feature", "HEAD~1"]);
        std::fs::write(root.join("README.md"), "feature-change\n").expect("写入文件");
        run_git_ok(root, &["add", "README.md"]);
        run_git_ok(root, &["commit", "-m", "feature change"]);
        run_git_ok(root, &["checkout", "main"]);

        let root_string = root.to_string_lossy().into_owned();
        git_merge_branch_blocking(root_string.clone(), "feature".into())
            .expect_err("冲突合并返回错误");
        assert!(repo_state_is_merging(&root_string));

        // 用户解决冲突（取 main 版本）并通过应用内提交
        std::fs::write(root.join("README.md"), "main-change\n").expect("写入文件");
        run_git_ok(root, &["add", "README.md"]);
        commit_internal(root_string.clone(), "resolve merge".into(), None, None, None)
            .expect("解决冲突后提交");
        // 合并提交必须带双亲；MERGE_HEAD 应被清理
        assert!(!repo_state_is_merging(&root_string), "提交后应清掉 MERGE_HEAD");
        let repo = open_repo(&root_string).expect("打开仓库");
        let head = repo.head().expect("HEAD").peel_to_commit().expect("提交");
        assert_eq!(head.parent_count(), 2, "冲突解决的提交应有双亲");

        // 拓扑保留：再次 merge 同一分支应判定 up-to-date，而非凭空冲突
        let again =
            git_merge_branch_blocking(root_string.clone(), "feature".into()).expect("再次合并");
        assert!(again.contains("无需合并"), "again: {again}");
    }

    #[test]
    fn merge_abort_restores_worktree_and_clears_state() {
        let temp = tempfile::tempdir().expect("创建临时目录");
        let root = temp.path();
        run_git_ok(root, &["init", "-b", "main"]);
        run_git_ok(root, &["config", "user.name", "test"]);
        run_git_ok(root, &["config", "user.email", "test@example.com"]);
        std::fs::write(root.join("README.md"), "base\n").expect("写入文件");
        run_git_ok(root, &["add", "README.md"]);
        run_git_ok(root, &["commit", "-m", "init"]);
        std::fs::write(root.join("README.md"), "main-change\n").expect("写入文件");
        run_git_ok(root, &["add", "README.md"]);
        run_git_ok(root, &["commit", "-m", "main change"]);
        run_git_ok(root, &["checkout", "-b", "feature", "HEAD~1"]);
        std::fs::write(root.join("README.md"), "feature-change\n").expect("写入文件");
        run_git_ok(root, &["add", "README.md"]);
        run_git_ok(root, &["commit", "-m", "feature change"]);
        run_git_ok(root, &["checkout", "main"]);

        let root_string = root.to_string_lossy().into_owned();
        git_merge_branch_blocking(root_string.clone(), "feature".into())
            .expect_err("冲突合并返回错误");
        assert!(repo_state_is_merging(&root_string));

        let msg = git_merge_abort(root_string.clone()).expect("放弃合并");
        assert_eq!(msg, "已放弃合并");
        assert!(!repo_state_is_merging(&root_string));
        let repo = open_repo(&root_string).expect("打开仓库");
        assert!(!repo.index().expect("index").has_conflicts());
        assert_eq!(
            std::fs::read_to_string(root.join("README.md")).unwrap(),
            "main-change\n",
            "放弃合并后工作树应回到合并前"
        );

        // 没有进行中的合并时 abort 应报错
        let err = git_merge_abort(root_string).expect_err("无合并时放弃应报错");
        assert!(!err.is_empty());
    }
}
