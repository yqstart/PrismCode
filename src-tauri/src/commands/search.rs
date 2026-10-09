use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use super::path_util::{ensure_inside_workspace, resolve_inside_workspace, walk_files};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchHit {
    pub path: String,
    pub name: String,
    pub relative: String,
    pub score: i32,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContentHit {
    pub path: String,
    pub relative: String,
    pub line: usize,
    pub column: usize,
    pub preview: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    pub changed_files: usize,
    pub replacements: usize,
    pub files: Vec<String>,
    /// 因超过 2MB 大小上限被跳过的文件数（与 search_content 的护栏对齐）
    pub skipped_large_files: usize,
}

fn char_key(value: char) -> char {
    value.to_lowercase().next().unwrap_or(value)
}

/// 子序列评分：连续字符、路径/单词边界和 CamelHump 首字母优先。
fn subsequence_score(query: &str, candidate: &str) -> Option<i32> {
    let query_chars: Vec<char> = query.chars().filter(|ch| !ch.is_whitespace()).collect();
    let candidate_chars: Vec<char> = candidate.chars().collect();
    if query_chars.is_empty() || candidate_chars.is_empty() {
        return None;
    }

    let mut score = 0;
    let mut search_from = 0;
    let mut previous_match: Option<usize> = None;
    for query_char in query_chars.iter().copied() {
        let query_key = char_key(query_char);
        let index = (search_from..candidate_chars.len())
            .find(|index| char_key(candidate_chars[*index]) == query_key)?;
        let current = candidate_chars[index];
        let previous = index
            .checked_sub(1)
            .and_then(|i| candidate_chars.get(i))
            .copied();
        let at_boundary = index == 0
            || previous.is_some_and(|ch| !ch.is_alphanumeric())
            || previous.is_some_and(|ch| ch.is_lowercase()) && current.is_uppercase();

        score += 12;
        if at_boundary {
            score += 24;
        }
        if previous_match.is_some_and(|previous_index| previous_index + 1 == index) {
            score += 18;
        } else if let Some(previous_index) = previous_match {
            score -= ((index - previous_index - 1) as i32).min(12);
        }
        previous_match = Some(index);
        search_from = index + 1;
    }

    score -= (candidate_chars.len().saturating_sub(query_chars.len()) as i32).min(80);
    Some(score)
}

/// WebStorm 风格的文件模糊匹配：文件名优先，同时接受路径限定和 CamelHump。
/// query 需为已小写字符串，避免遍历时重复规范化。
fn segment_contains_score(query_lc: &str, name: &str, relative: &str) -> Option<i32> {
    let query = query_lc.trim().replace('\\', "/");
    if query.is_empty() {
        return None;
    }

    let name_lc = name.to_lowercase();
    let relative_normalized = relative.replace('\\', "/");
    let relative_lc = relative_normalized.to_lowercase();
    let mut best: Option<i32> = None;
    let mut consider = |score: Option<i32>| {
        if let Some(score) = score {
            best = Some(best.map_or(score, |current| current.max(score)));
        }
    };

    if !query.contains('/') {
        if name_lc == query {
            consider(Some(1_000));
        } else if name_lc.starts_with(&query) {
            consider(Some(900 - (name_lc.len() as i32).min(80)));
        } else if let Some(index) = name_lc.find(&query) {
            consider(Some(
                800 - (index as i32).min(80) - (name_lc.len() as i32).min(80),
            ));
        }
        consider(subsequence_score(&query, name).map(|score| 560 + score));
    }

    if relative_lc == query {
        consider(Some(950));
    } else if relative_lc.ends_with(&query) {
        consider(Some(850 - (relative_lc.len() as i32).min(120)));
    } else if let Some(index) = relative_lc.find(&query) {
        consider(Some(
            720 - (index as i32).min(120) - (relative_lc.len() as i32).min(120),
        ));
    } else {
        consider(subsequence_score(&query, &relative_normalized).map(|score| 320 + score));
    }

    best
}

#[cfg(test)]
mod score_tests {
    use super::segment_contains_score;

    #[test]
    fn file_search_supports_camel_hump_subsequence() {
        assert!(segment_contains_score(
            "tfi",
            "TracFormItem.vue",
            "src/components/TracFormItem.vue",
        )
        .is_some());
    }

    #[test]
    fn file_search_supports_path_qualified_query() {
        let exact = segment_contains_score(
            "document/index",
            "index.vue",
            "src/views/document/index.vue",
        );
        let unrelated = segment_contains_score(
            "document/index",
            "index.vue",
            "src/views/dashboard/index.vue",
        );
        assert!(exact.is_some());
        assert!(unrelated.is_none());
    }
}

fn match_ext(path: &Path, extensions: &Option<Vec<String>>) -> bool {
    let Some(exts) = extensions else {
        return true;
    };
    if exts.is_empty() {
        return true;
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    exts.iter()
        .any(|e| e.trim_start_matches('.').eq_ignore_ascii_case(&ext))
}

const WALK_CACHE_MAX_BYTES: usize = 24 * 1024 * 1024;

fn entry_bytes(files: &[PathBuf]) -> usize {
    files.iter().map(|path| path.as_os_str().len() + 32).sum()
}

/// 文件列表缓存（root + 忽略规则 为 key），避免每次搜索重复全量遍历目录树。
/// 搜索结果天然按最新磁盘状态返回，故不主动失效；工作区切换会改变 root，自动换 key。
struct WalkCache {
    /// key → (写入时间, 文件列表)；TTL 过期后视为未命中，重新遍历
    map: HashMap<String, (std::time::Instant, Arc<Vec<PathBuf>>)>,
    order: Vec<String>,
    bytes: usize,
    max: usize,
    byte_budget: usize,
}

/// 文件列表缓存有效期：新建/删除文件后最多 3s 内出现在搜索结果
const WALK_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(3);

impl WalkCache {
    fn new(max: usize) -> Self {
        Self::with_budget(max, WALK_CACHE_MAX_BYTES)
    }

    fn with_budget(max: usize, byte_budget: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: Vec::new(),
            bytes: 0,
            max,
            byte_budget,
        }
    }

    fn cache_key(root: &str, extra_ignores: &[String]) -> String {
        format!("{root}\u{0}{}", extra_ignores.join("\u{1}"))
    }

    fn remove_key(&mut self, key: &str) {
        if let Some((_, files)) = self.map.remove(key) {
            self.bytes = self.bytes.saturating_sub(entry_bytes(&files));
        }
        if let Some(pos) = self.order.iter().position(|item| item == key) {
            self.order.remove(pos);
        }
    }

    fn drop_expired(&mut self) {
        let expired: Vec<String> = self
            .map
            .iter()
            .filter(|(_, (written_at, _))| written_at.elapsed() >= WALK_CACHE_TTL)
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            self.remove_key(&key);
        }
    }

    fn evict_overflow(&mut self) {
        while self.bytes > self.byte_budget || self.order.len() > self.max {
            let Some(lru) = self.order.first().cloned() else {
                break;
            };
            self.remove_key(&lru);
        }
    }

    fn get(&mut self, key: &str) -> Option<Arc<Vec<PathBuf>>> {
        let expired = match self.map.get(key) {
            Some((written_at, _)) => written_at.elapsed() >= WALK_CACHE_TTL,
            None => return None,
        };
        if expired {
            self.remove_key(key);
            return None;
        }
        if let Some(pos) = self.order.iter().position(|item| item == key) {
            self.order.remove(pos);
        }
        self.order.push(key.to_string());
        self.map.get(key).map(|(_, files)| Arc::clone(files))
    }

    fn insert(&mut self, key: String, files: Arc<Vec<PathBuf>>) {
        self.drop_expired();
        self.remove_key(&key);
        if entry_bytes(&files) > self.byte_budget {
            return;
        }
        self.bytes += entry_bytes(&files);
        self.map
            .insert(key.clone(), (std::time::Instant::now(), files));
        self.order.push(key);
        self.evict_overflow();
    }
}

/// 全局文件列表缓存（进程级单例）
fn walk_cache() -> &'static Mutex<WalkCache> {
    static CACHE: std::sync::OnceLock<Mutex<WalkCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(WalkCache::new(32)))
}

/// 获取（带缓存的）工作区文件列表。磁盘已变化时结果可能短暂滞后，搜索内容本身始终读最新。
fn cached_walk_files(root: &Path, extra: &[String]) -> Result<Arc<Vec<PathBuf>>, String> {
    let root_str = root.to_string_lossy().to_string();
    let key = WalkCache::cache_key(&root_str, extra);
    {
        let mut cache = walk_cache().lock().unwrap();
        if let Some(files) = cache.get(&key) {
            return Ok(files);
        }
    }
    let files = Arc::new(walk_files(root, extra)?);
    let mut cache = walk_cache().lock().unwrap();
    cache.insert(key, Arc::clone(&files));
    Ok(files)
}

/// 在 spawn_blocking 中跑一个同步闭包，带超时（对齐 git 网络命令的防阻塞约定）。
async fn run_blocking<T, F>(timeout_secs: u64, err_prefix: &str, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let handle = tokio::task::spawn_blocking(f);
    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), handle).await {
        Ok(Ok(r)) => r,
        Ok(Err(join)) => Err(format!("{err_prefix}: {join}")),
        Err(_) => Err(format!("{err_prefix}超时（{timeout_secs}s），请重试或缩小范围").into()),
    }
}

/// 搜索代际计数器：新搜索启动时 +1；进行中的旧搜索闭包读它发现已过期，
/// 立即提前返回，释放 spawn_blocking 线程（Rust 无法取消线程，只能靠
/// 自检快速退出——否则连续触发搜索会把线程池占满造成「卡死」假象）。
static SEARCH_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const SEARCH_SUPERSEDED: &str = "__MIROCODE_SEARCH_SUPERSEDED__";

/// 判断当前代际是否已过期（有更新的搜索启动即视为过期）。
fn gen_stale(born: u64) -> bool {
    SEARCH_GEN.load(std::sync::atomic::Ordering::Relaxed) != born
}

/// 生成一个新代际，返回当前代际号。
fn next_gen() -> u64 {
    SEARCH_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
}

#[tauri::command]
pub async fn search_files(
    root: String,
    query: String,
    max_results: Option<usize>,
    extensions: Option<Vec<String>>,
    extra_ignores: Option<Vec<String>>,
) -> Result<Vec<FileSearchHit>, String> {
    let extra = extra_ignores.unwrap_or_default();
    let max = max_results.unwrap_or(80);
    let q = query.trim().to_string();
    if q.is_empty() || max == 0 {
        return Ok(vec![]);
    }
    // query 小写只算一次（segment_contains_score 不再重复 to_lowercase）
    let q_lc = q.to_lowercase();
    // 本请求代际：新搜索启动会递增 SEARCH_GEN，旧任务检测到过期立即退出
    let gen = next_gen();

    run_blocking(8, "文件搜索", move || {
        let root_path = PathBuf::from(&root);
        ensure_inside_workspace(&root_path, &root_path)?;

        let mut hits = Vec::with_capacity(max.min(4096));
        for path in cached_walk_files(&root_path, &extra)?.iter() {
            // 每 256 个文件检查一次是否过期，过期立即返回释放线程
            if gen_stale(gen) {
                // 代际是进程级的，可能是另一个窗口发起了搜索；不能把当前
                // 已收集的部分结果当成完整结果交给前端。
                return Err(SEARCH_SUPERSEDED.into());
            }
            if !match_ext(&path, &extensions) {
                continue;
            }
            let name = path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let relative = path
                .strip_prefix(&root_path)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| path.to_string_lossy().to_string());

            let score = segment_contains_score(&q_lc, &name, &relative).unwrap_or(-1);
            if score < 0 {
                continue;
            }
            hits.push(FileSearchHit {
                path: path.to_string_lossy().to_string(),
                name,
                relative,
                score,
            });
        }
        hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.relative.cmp(&b.relative)));
        hits.truncate(max);
        Ok(hits)
    })
    .await
}

#[tauri::command]
pub async fn search_content(
    root: String,
    query: String,
    case_sensitive: Option<bool>,
    max_results: Option<usize>,
    extensions: Option<Vec<String>>,
    extra_ignores: Option<Vec<String>>,
    #[allow(unused_variables)] context_lines: Option<usize>,
) -> Result<Vec<ContentHit>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }
    let case_sensitive = case_sensitive.unwrap_or(false);
    let max = max_results.unwrap_or(500);
    if max == 0 {
        return Ok(vec![]);
    }
    let extra = extra_ignores.unwrap_or_default();
    let query_lc = query.to_lowercase();
    let gen = next_gen();

    run_blocking(15, "内容搜索", move || {
        let root_path = PathBuf::from(&root);
        ensure_inside_workspace(&root_path, &root_path)?;

        let mut hits = Vec::new();
        for path in cached_walk_files(&root_path, &extra)?.iter() {
            // 每 64 个文件检查一次是否过期（内容搜索读文件较慢，检查更频繁）
            if gen_stale(gen) {
                // 代际是进程级的，可能是另一个窗口发起了搜索；不能把当前
                // 已收集的部分结果当成完整结果交给前端。
                return Err(SEARCH_SUPERSEDED.into());
            }
            if !match_ext(&path, &extensions) {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else {
                continue;
            };
            if bytes.contains(&0) || bytes.len() > 2_000_000 {
                continue;
            }
            let Ok(text) = String::from_utf8(bytes) else {
                continue;
            };
            let relative = path
                .strip_prefix(&root_path)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| path.to_string_lossy().to_string());

            for (idx, line) in text.lines().enumerate() {
                if idx % 64 == 0 && gen_stale(gen) {
                    return Err(SEARCH_SUPERSEDED.into());
                }
                let found = if case_sensitive {
                    line.find(&query)
                } else {
                    line.to_lowercase().find(&query_lc)
                };
                if let Some(col) = found {
                    hits.push(ContentHit {
                        path: path.to_string_lossy().to_string(),
                        relative: relative.clone(),
                        line: idx + 1,
                        column: col + 1,
                        preview: line.trim().chars().take(240).collect(),
                    });
                    if hits.len() >= max {
                        if gen_stale(gen) {
                            return Err(SEARCH_SUPERSEDED.into());
                        }
                        return Ok(hits);
                    }
                }
            }
        }
        Ok(hits)
    })
    .await
}

#[tauri::command]
pub async fn replace_in_files(
    root: String,
    query: String,
    replacement: String,
    case_sensitive: Option<bool>,
    paths: Option<Vec<String>>,
    dry_run: Option<bool>,
    extensions: Option<Vec<String>>,
    extra_ignores: Option<Vec<String>>,
) -> Result<ReplaceResult, String> {
    if query.is_empty() {
        return Err("搜索内容不能为空".into());
    }
    let case_sensitive = case_sensitive.unwrap_or(false);
    let dry_run = dry_run.unwrap_or(true);
    let extra = extra_ignores.unwrap_or_default();

    run_blocking(120, "内容替换", move || {
        let root_path = PathBuf::from(&root);
        ensure_inside_workspace(&root_path, &root_path)?;

        let files: Vec<PathBuf> = if let Some(paths) = paths {
            paths
                .into_iter()
                .map(|path| resolve_inside_workspace(&root_path, Path::new(&path)))
                .collect::<Result<_, _>>()?
        } else {
            cached_walk_files(&root_path, &extra)?
                .iter()
                .filter(|p| match_ext(p, &extensions))
                .cloned()
                .collect()
        };

        let mut changed_files = 0usize;
        let mut replacements = 0usize;
        let mut touched = Vec::new();
        let mut skipped_large_files = 0usize;

        // 外层 120s 超时无法取消线程：闭包内自检截止时间提前停写。
        // 否则超时返回后线程仍在后台覆写文件，用户重试会与旧任务并发写同一批文件
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(110);
        let mut processed = 0usize;

        for path in files {
            processed += 1;
            if processed % 50 == 0 && std::time::Instant::now() > deadline {
                return Err("替换超时（110s），已停止继续写入，请缩小范围重试".into());
            }
            ensure_inside_workspace(&root_path, &path)?;
            // 大小护栏：与 search_content 对齐（2MB）。全工作区替换时几百 MB 的
            // 产物/数据文件整读会内存暴涨，且替换它们通常不是用户意图；
            // 超限跳过并计数，在结果里显式报告而非静默。
            const MAX_REPLACE_BYTES: u64 = 2_000_000;
            if fs::metadata(&path).map(|m| m.len() > MAX_REPLACE_BYTES).unwrap_or(false) {
                skipped_large_files += 1;
                continue;
            }
            let Ok(bytes) = fs::read(&path) else {
                continue;
            };
            if bytes.contains(&0) {
                continue;
            }
            let Ok(text) = String::from_utf8(bytes) else {
                continue;
            };

            let (next, count) = if case_sensitive {
                let count = text.matches(&query).count();
                if count == 0 {
                    continue;
                }
                (text.replace(&query, &replacement), count)
            } else {
                // 大小写不敏感：仅按 ASCII 折叠。to_lowercase 对部分 Unicode
                // 字符会改变字节长度（İ→i̇、ẞ→ß），lower 与 text 字节偏移错位，
                // &text[last..start] 会在非字符边界切片 panic（整个替换失败）；
                // to_ascii_lowercase 保持字节长度，偏移一一对应，切片安全
                // （非 ASCII 字符不折叠，等价大小写敏感，中文场景无影响）
                let lower: String = text.chars().map(|c| c.to_ascii_lowercase()).collect();
                let needle: String = query.chars().map(|c| c.to_ascii_lowercase()).collect();
                if !lower.contains(&needle) {
                    continue;
                }
                let mut out = String::with_capacity(text.len());
                let mut last = 0usize;
                let mut count = 0usize;
                let mut search_at = 0usize;
                while let Some(rel) = lower[search_at..].find(&needle) {
                    let start = search_at + rel;
                    out.push_str(&text[last..start]);
                    out.push_str(&replacement);
                    // ASCII 折叠不改变长度：needle.len() == query.len()
                    last = start + needle.len();
                    search_at = last;
                    count += 1;
                }
                out.push_str(&text[last..]);
                (out, count)
            };

            if count == 0 {
                continue;
            }
            changed_files += 1;
            replacements += count;
            touched.push(path.to_string_lossy().to_string());
            if !dry_run {
                fs::write(&path, next).map_err(|e| e.to_string())?;
            }
        }

        Ok(ReplaceResult {
            changed_files,
            replacements,
            files: touched,
            skipped_large_files,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn sample(name: &str) -> Arc<Vec<PathBuf>> {
        Arc::new(vec![PathBuf::from(name)])
    }

    #[test]
    fn evicts_lru_by_byte_budget() {
        let mut cache = WalkCache::with_budget(32, 160);
        cache.insert("a".into(), sample(&"a".repeat(40)));
        cache.insert("b".into(), sample(&"b".repeat(40)));
        cache.insert("c".into(), sample(&"c".repeat(40)));
        assert!(!cache.map.contains_key("a"));
        assert!(cache.map.contains_key("b"));
        assert!(cache.map.contains_key("c"));
        assert!(cache.bytes <= 160);
    }

    #[test]
    fn expired_entry_is_dropped_on_write() {
        let mut cache = WalkCache::new(32);
        cache.insert("old".into(), sample("old"));
        if let Some(entry) = cache.map.get_mut("old") {
            entry.0 = std::time::Instant::now()
                .checked_sub(Duration::from_secs(4))
                .expect("回拨时间");
        }
        cache.insert("new".into(), sample("new"));
        assert!(!cache.map.contains_key("old"));
        assert!(cache.map.contains_key("new"));
        assert_eq!(cache.bytes, entry_bytes(cache.map.get("new").expect("new").1.as_ref()));
    }

    #[test]
    fn oversized_entry_is_not_cached() {
        let mut cache = WalkCache::with_budget(32, 64);
        cache.insert("huge".into(), sample(&"h".repeat(128)));
        assert!(cache.map.is_empty());
        assert_eq!(cache.bytes, 0);
    }
}
