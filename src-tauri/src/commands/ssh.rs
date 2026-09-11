//! 极简 SSH Shell（ssh2）。
//!
//! - Shell：交互式远程终端，输出经 `ssh://data/{id}` 推送
//! - 主机密钥：校验 `~/.ssh/known_hosts` + `~/.prismcode/known_hosts`
//! - 密码凭据：`~/.prismcode/ssh-credentials.json`（0600）

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use ssh2::{CheckResult, HashType, KnownHostFileKind, KnownHostKeyFormat, Session};
use tauri::{AppHandle, Emitter, Manager, State};

type CmdResult<T> = Result<T, String>;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// `password` | `key`
    pub auth_kind: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
    /// 用户已确认信任未知主机密钥（TOFU 写入）
    pub accept_unknown_host_key: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSecretStored {
    pub password: Option<String>,
    pub passphrase: Option<String>,
}

struct ShellSession {
    stop: Arc<AtomicBool>,
    channel: Arc<Mutex<ssh2::Channel>>,
}

pub struct SshState {
    shells: Mutex<HashMap<String, ShellSession>>,
}

impl Default for SshState {
    fn default() -> Self {
        Self {
            shells: Mutex::new(HashMap::new()),
        }
    }
}

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest);
        }
        if let Ok(home) = std::env::var("USERPROFILE") {
            return PathBuf::from(home).join(rest);
        }
    }
    if path == "~" {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home);
        }
    }
    PathBuf::from(path)
}

fn prism_dir() -> Option<PathBuf> {
    crate::user_data::user_data_dir()
}

fn ssh_cred_store_path() -> Option<PathBuf> {
    Some(prism_dir()?.join("ssh-credentials.json"))
}

fn app_known_hosts_path() -> Option<PathBuf> {
    Some(prism_dir()?.join("known_hosts"))
}

fn system_known_hosts_path() -> PathBuf {
    expand_home("~/.ssh/known_hosts")
}

fn set_file_private(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
}

fn host_key_fingerprint(sess: &Session) -> String {
    if let Some(hash) = sess.host_key_hash(HashType::Sha256) {
        return format!("SHA256:{}", STANDARD_NO_PAD.encode(hash));
    }
    if let Some(hash) = sess.host_key_hash(HashType::Md5) {
        let hex: Vec<String> = hash.iter().map(|b| format!("{b:02x}")).collect();
        return format!("MD5:{}", hex.join(":"));
    }
    "unknown".into()
}

fn verify_or_trust_host_key(sess: &Session, host: &str, port: u16, accept: bool) -> CmdResult<()> {
    let (key, key_type) = sess
        .host_key()
        .ok_or_else(|| "无法获取服务器主机密钥".to_string())?;
    let fmt: KnownHostKeyFormat = key_type.into();
    let fingerprint = host_key_fingerprint(sess);

    let mut known = sess
        .known_hosts()
        .map_err(|e| format!("初始化 known_hosts 失败: {e}"))?;

    // 系统 + 应用 known_hosts 一并载入（文件不存在则忽略）
    for path in [system_known_hosts_path(), app_known_hosts_path().unwrap_or_default()] {
        if path.as_os_str().is_empty() || !path.exists() {
            continue;
        }
        let _ = known.read_file(&path, KnownHostFileKind::OpenSSH);
    }

    match known.check_port(host, port, key) {
        CheckResult::Match => Ok(()),
        CheckResult::Mismatch => Err(format!(
            "主机密钥不匹配（可能遭受中间人攻击）\n{host}:{port}\n指纹: {fingerprint}"
        )),
        CheckResult::Failure => Err("校验主机密钥失败".into()),
        CheckResult::NotFound => {
            if !accept {
                return Err(format!(
                    "SSH_HOST_KEY_UNKNOWN|{fingerprint}|{host}:{port}"
                ));
            }
            // 只写入应用 known_hosts，避免把系统条目整库拷贝出去
            let path = app_known_hosts_path().ok_or_else(|| "无法定位凭据目录".to_string())?;
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            // 锁内完成 读-改-写：并发首次连接同一主机时交错会丢记录
            let _guard = known_hosts_lock().lock().map_err(|e| e.to_string())?;
            let mut app_known = sess
                .known_hosts()
                .map_err(|e| format!("初始化 known_hosts 失败: {e}"))?;
            if path.exists() {
                let _ = app_known.read_file(&path, KnownHostFileKind::OpenSSH);
            }
            let entry_host = if port == 22 {
                host.to_string()
            } else {
                format!("[{host}]:{port}")
            };
            app_known
                .add(&entry_host, key, "prismcode", fmt)
                .map_err(|e| format!("写入 known_hosts 失败: {e}"))?;
            app_known
                .write_file(&path, KnownHostFileKind::OpenSSH)
                .map_err(|e| format!("保存 known_hosts 失败: {e}"))?;
            set_file_private(&path);
            Ok(())
        }
    }
}

/// 标准超时 / 非阻塞类错误（可无限次轮询）
fn is_timeout_io_error(err: &std::io::Error) -> bool {
    use std::io::ErrorKind;
    match err.kind() {
        ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted => return true,
        _ => {}
    }
    let msg = err.to_string().to_ascii_lowercase();
    msg.contains("timed out")
        || msg.contains("timeout")
        || msg.contains("would block")
        || msg.contains("eagain")
        || msg.contains("socket timeout")
}

/// libssh2 短超时轮询时偶发的瞬时错误；连续出现过多则视为真断连
fn is_soft_transport_error(err: &std::io::Error) -> bool {
    let msg = err.to_string().to_ascii_lowercase();
    msg.contains("transport read") || msg.contains("error receiving on socket")
}

fn is_retryable_io_error(err: &std::io::Error) -> bool {
    is_timeout_io_error(err) || is_soft_transport_error(err)
}

fn connect_session(cfg: &SshConnectConfig) -> CmdResult<Session> {
    let host = cfg.host.trim();
    if host.is_empty() {
        return Err("主机不能为空".into());
    }
    let user = cfg.username.trim();
    if user.is_empty() {
        return Err("用户名不能为空".into());
    }
    let port = if cfg.port == 0 { 22 } else { cfg.port };

    let addr = format!("{host}:{port}");
    let mut last_err = None;
    let tcp = {
        let addrs = addr
            .to_socket_addrs()
            .map_err(|e| format!("解析地址失败 {addr}: {e}"))?;
        let mut connected = None;
        for socket_addr in addrs {
            match TcpStream::connect_timeout(&socket_addr, Duration::from_secs(15)) {
                Ok(stream) => {
                    connected = Some(stream);
                    break;
                }
                Err(e) => last_err = Some(e),
            }
        }
        connected.ok_or_else(|| {
            format!(
                "连接失败 {addr}: {}",
                last_err
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "无可用地址".into())
            )
        })?
    };
    tcp.set_nodelay(true).map_err(|e| e.to_string())?;

    let mut sess = Session::new().map_err(|e| format!("创建 SSH 会话失败: {e}"))?;
    sess.set_tcp_stream(tcp);
    sess.set_timeout(30_000);
    sess.handshake()
        .map_err(|e| format!("SSH 握手失败: {e}"))?;

    let accept = cfg.accept_unknown_host_key.unwrap_or(false);
    verify_or_trust_host_key(&sess, host, port, accept)?;

    match cfg.auth_kind.as_str() {
        "key" => {
            let key_path = cfg
                .private_key_path
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("~/.ssh/id_ed25519");
            let key = expand_home(key_path);
            if !key.exists() {
                let rsa = expand_home("~/.ssh/id_rsa");
                if rsa.exists() {
                    let pass = cfg.passphrase.as_deref();
                    sess.userauth_pubkey_file(user, None, &rsa, pass)
                        .map_err(|e| format!("公钥认证失败: {e}"))?;
                } else {
                    return Err(format!("私钥不存在: {}", key.display()));
                }
            } else {
                let pass = cfg.passphrase.as_deref();
                sess.userauth_pubkey_file(user, None, &key, pass)
                    .map_err(|e| format!("公钥认证失败: {e}"))?;
            }
        }
        _ => {
            let password = cfg
                .password
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "密码不能为空".to_string())?;
            sess.userauth_password(user, password)
                .map_err(|e| format!("密码认证失败: {e}"))?;
        }
    }

    if !sess.authenticated() {
        return Err("SSH 认证未通过".into());
    }

    sess.set_keepalive(true, 30);
    Ok(sess)
}

fn write_all_retry(ch: &mut ssh2::Channel, data: &[u8]) -> std::io::Result<()> {
    let mut offset = 0;
    let mut spins = 0;
    while offset < data.len() {
        match ch.write(&data[offset..]) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "SSH 通道写入返回 0",
                ));
            }
            Ok(n) => {
                offset += n;
                spins = 0;
            }
            Err(err) if is_retryable_io_error(&err) => {
                spins += 1;
                if spins > 100 {
                    return Err(err);
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(err) => return Err(err),
        }
    }
    let _ = ch.flush();
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProfileStored {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_kind: String,
    pub private_key_path: String,
    pub remember_secret: Option<bool>,
}

fn ssh_profiles_path() -> Option<PathBuf> {
    Some(prism_dir()?.join("ssh-profiles.json"))
}

#[tauri::command]
pub fn ssh_profiles_load() -> CmdResult<Vec<SshProfileStored>> {
    let path = ssh_profiles_path().ok_or_else(|| "无法定位配置目录".to_string())?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let profiles: Vec<SshProfileStored> =
        serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(profiles)
}

#[tauri::command]
pub fn ssh_profiles_save(profiles: Vec<SshProfileStored>) -> CmdResult<()> {
    let path = ssh_profiles_path().ok_or_else(|| "无法定位配置目录".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let trimmed: Vec<_> = profiles.into_iter().take(20).collect();
    let raw = serde_json::to_string_pretty(&trimmed).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| e.to_string())?;
    set_file_private(&path);
    Ok(())
}

// ==================== SSH 凭据（磁盘 0600） ====================

static CRED_STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn cred_store_lock() -> &'static Mutex<()> {
    CRED_STORE_LOCK.get_or_init(|| Mutex::new(()))
}

/// TOFU known_hosts 写入锁：并发首次连接同一主机时读-改-写交错
/// 会把先写入的主机密钥记录覆盖丢
static KNOWN_HOSTS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn known_hosts_lock() -> &'static Mutex<()> {
    KNOWN_HOSTS_LOCK.get_or_init(|| Mutex::new(()))
}

fn load_cred_map_from_disk(path: &Path) -> CmdResult<HashMap<String, SshSecretStored>> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn save_cred_map_to_disk(path: &Path, map: &HashMap<String, SshSecretStored>) -> CmdResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    // 新建即 0600：消除「先 0644 写盘再 chmod」的瞬时权限窗口
    write_private(path, &raw).map_err(|e| e.to_string())?;
    set_file_private(path);
    Ok(())
}

/// 以 0600 权限写入文本文件（Unix；Windows 无此语义，权限由目录 ACL 管控）
fn write_private(path: &Path, content: &str) -> std::io::Result<()> {
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

fn filter_nonempty_secret(secret: &SshSecretStored) -> Option<SshSecretStored> {
    if secret.password.as_ref().is_some_and(|p| !p.is_empty())
        || secret.passphrase.as_ref().is_some_and(|p| !p.is_empty())
    {
        Some(secret.clone())
    } else {
        None
    }
}

#[tauri::command]
pub fn ssh_secret_get(profile_id: String) -> CmdResult<Option<SshSecretStored>> {
    let path = ssh_cred_store_path().ok_or_else(|| "无法定位凭据目录".to_string())?;
    let _guard = cred_store_lock().lock().map_err(|e| e.to_string())?;
    let map = load_cred_map_from_disk(&path)?;
    Ok(map.get(&profile_id).and_then(filter_nonempty_secret))
}

#[tauri::command]
pub fn ssh_secret_set(profile_id: String, secret: SshSecretStored) -> CmdResult<()> {
    let path = ssh_cred_store_path().ok_or_else(|| "无法定位凭据目录".to_string())?;
    let _guard = cred_store_lock().lock().map_err(|e| e.to_string())?;
    let mut map = load_cred_map_from_disk(&path)?;

    let next = SshSecretStored {
        password: secret.password.filter(|s| !s.is_empty()),
        passphrase: secret.passphrase.filter(|s| !s.is_empty()),
    };
    if next.password.is_none() && next.passphrase.is_none() {
        map.remove(&profile_id);
    } else {
        let merged = if let Some(existing) = map.remove(&profile_id) {
            SshSecretStored {
                password: next.password.or(existing.password),
                passphrase: next.passphrase.or(existing.passphrase),
            }
        } else {
            next
        };
        map.insert(profile_id, merged);
    }
    save_cred_map_to_disk(&path, &map)
}

#[tauri::command]
pub fn ssh_secret_remove(profile_id: String) -> CmdResult<()> {
    let path = ssh_cred_store_path().ok_or_else(|| "无法定位凭据目录".to_string())?;
    let _guard = cred_store_lock().lock().map_err(|e| e.to_string())?;
    let mut map = load_cred_map_from_disk(&path)?;
    if map.remove(&profile_id).is_none() {
        return Ok(());
    }
    save_cred_map_to_disk(&path, &map)
}

// ==================== SSH Shell ====================

/// 建立 SSH 会话 + PTY + shell（纯同步阻塞，最长 ~75s，须在 spawn_blocking 内执行）。
/// 返回 stop 标志与通道，供插入会话表 + 启动读线程。
fn ssh_connect_channel(
    config: &SshConnectConfig,
    cols: u32,
    rows: u32,
) -> CmdResult<(Arc<AtomicBool>, Arc<Mutex<ssh2::Channel>>)> {
    let sess = connect_session(config)?;
    sess.set_timeout(30_000);

    let mut channel = sess
        .channel_session()
        .map_err(|e| format!("打开通道失败: {e}"))?;
    let cols = cols.max(20);
    let rows = rows.max(5);
    channel
        .request_pty("xterm-256color", None, Some((cols, rows, 0, 0)))
        .map_err(|e| format!("申请 PTY 失败: {e}"))?;
    channel
        .shell()
        .map_err(|e| format!("启动远程 shell 失败: {e}"))?;

    sess.set_timeout(0);
    sess.set_blocking(false);

    Ok((Arc::new(AtomicBool::new(false)), Arc::new(Mutex::new(channel))))
}

#[tauri::command]
pub async fn ssh_shell_open(
    app: AppHandle,
    state: State<'_, SshState>,
    id: String,
    config: SshConnectConfig,
    cols: u32,
    rows: u32,
) -> CmdResult<()> {
    {
        let shells = state.shells.lock().map_err(|e| e.to_string())?;
        if shells.contains_key(&id) {
            return Err("该 SSH 会话已存在".into());
        }
    }

    // 连接全流程（DNS 解析 + TCP + 握手 + 认证 + PTY + shell，最长 ~75s）
    // 是纯同步阻塞，放 spawn_blocking 避免冻结主线程
    let config_c = config.clone();
    let connect = tokio::task::spawn_blocking(move || {
        ssh_connect_channel(&config_c, cols, rows)
    });
    let (stop, channel) = match tokio::time::timeout(std::time::Duration::from_secs(90), connect)
        .await
    {
        Ok(Ok(r)) => r?,
        Ok(Err(join)) => return Err(format!("SSH 连接任务失败: {join}")),
        Err(_) => return Err("SSH 连接超时（90s），请检查网络或主机可达性".into()),
    };

    {
        let mut shells = state.shells.lock().map_err(|e| e.to_string())?;
        // 连接耗时（最长 90s）期间可能有并发同 id 打开先完成：此时本次连接
        // 作废并清理自己的通道，不能覆盖已存在的会话（覆盖会让先建立的
        // 连接失去引用，SSH 会话与 TCP 连接静默泄漏）
        if shells.contains_key(&id) {
            drop(shells);
            stop.store(true, Ordering::SeqCst);
            if let Ok(mut ch) = channel.lock() {
                let _ = ch.send_eof();
                let _ = ch.close();
            }
            return Err("该 SSH 会话已存在".into());
        }
        shells.insert(
            id.clone(),
            ShellSession {
                stop: Arc::clone(&stop),
                channel: Arc::clone(&channel),
            },
        );
    }

    let reader_id = id.clone();
    thread::spawn(move || {
        let event_data = format!("ssh://data/{reader_id}");
        let event_exit = format!("ssh://exit/{reader_id}");
        let event_error = format!("ssh://error/{reader_id}");
        let mut buf = [0u8; 8192];
        let mut last_error: Option<String> = None;
        let mut soft_err_streak = 0u32;
        // 跨 chunk 增量 UTF-8 解码：多字节字符跨 8KB chunk 边界时先保留不完整
        // 尾字节，拼到下一 chunk 再解码，避免逐 chunk lossy 把边界字符损坏成
        // U+FFFD（中文终端输出乱码）
        let mut pending: Vec<u8> = Vec::with_capacity(4);
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let read_result = {
                let mut ch = match channel.lock() {
                    Ok(g) => g,
                    Err(_) => break,
                };
                if ch.eof() {
                    Ok(0)
                } else {
                    ch.read(&mut buf)
                }
            };
            match read_result {
                Ok(0) => break,
                Ok(n) => {
                    soft_err_streak = 0;
                    // 拼接残留 + 本轮数据，解码完整前缀，保留不完整尾部
                    pending.extend_from_slice(&buf[..n]);
                    match std::str::from_utf8(&pending) {
                        Ok(s) => {
                            let _ = app.emit(&event_data, s);
                            pending.clear();
                        }
                        Err(e) => {
                            let valid = e.valid_up_to();
                            if valid > 0 {
                                let s = std::str::from_utf8(&pending[..valid]).unwrap_or_default();
                                let _ = app.emit(&event_data, s);
                            }
                            match e.error_len() {
                                // 不完整序列（被 chunk 截断）：保留待拼
                                None => {
                                    let _ = pending.drain(..valid);
                                }
                                // 真正无效字节：丢弃（等效 lossy），其后等下轮
                                Some(bad_len) => {
                                    let _ = pending.drain(..valid + bad_len);
                                }
                            }
                        }
                    }
                }
                Err(err) => {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    if is_timeout_io_error(&err) {
                        soft_err_streak = 0;
                        thread::sleep(Duration::from_millis(16));
                        continue;
                    }
                    if is_soft_transport_error(&err) {
                        // 瞬时 transport read（网络抖动等）不应立即判定断连。
                        // 真断连时 channel 会收到 eof（Read 返回 Ok(0)）或稳定硬错误，
                        // 软错误计数只作为长期无进展的兜底（400 次 × 25ms ≈ 10s）。
                        soft_err_streak = soft_err_streak.saturating_add(1);
                        if soft_err_streak <= 400 {
                            thread::sleep(Duration::from_millis(25));
                            continue;
                        }
                    }
                    let closing = channel.lock().map(|ch| ch.eof()).unwrap_or(true);
                    if closing || stop.load(Ordering::SeqCst) {
                        break;
                    }
                    last_error = Some(format!("SSH 通道读取失败: {err}"));
                    break;
                }
            }
        }
        if let Some(msg) = last_error {
            if !stop.load(Ordering::SeqCst) {
                let _ = app.emit(&event_error, msg);
            }
        }
        // 读循环退出（EOF/错误/stop）：若会话仍在表中则回收（stop + 关通道）。
        // 用户主动 ssh_shell_close 时条目已被移除，这里 remove 返回 None 不会重复关闭；
        // 远程 exit / 断连路径在此回收，避免会话泄漏导致同 id 无法重连
        let removed: Option<ShellSession> = {
            let state = app.try_state::<SshState>();
            match state {
                Some(s) => s.shells.lock().ok().and_then(|mut m| m.remove(&reader_id)),
                None => None,
            }
        };
        if let Some(shell) = removed {
            shell.stop.store(true, Ordering::SeqCst);
            if let Ok(mut ch) = shell.channel.lock() {
                let _ = ch.send_eof();
                let _ = ch.close();
                // 不 wait_close：libssh2 会强制阻塞模式等远端关通道，死网络下
                // 无限阻塞会永久泄漏本读线程；close + drop 已回收本地资源
            }
        }
        let _ = app.emit(&event_exit, ());
    });

    Ok(())
}

#[tauri::command]
pub fn ssh_shell_write(state: State<'_, SshState>, id: String, data: String) -> CmdResult<()> {
    let channel = {
        let shells = state.shells.lock().map_err(|e| e.to_string())?;
        let shell = shells.get(&id).ok_or_else(|| "SSH 会话不存在".to_string())?;
        if shell.stop.load(Ordering::SeqCst) {
            return Err("SSH 会话已关闭".into());
        }
        Arc::clone(&shell.channel)
    };
    let mut ch = channel.lock().map_err(|e| e.to_string())?;
    write_all_retry(&mut ch, data.as_bytes()).map_err(|e| format!("写入失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn ssh_shell_resize(state: State<'_, SshState>, id: String, cols: u32, rows: u32) -> CmdResult<()> {
    let channel = {
        let shells = state.shells.lock().map_err(|e| e.to_string())?;
        let shell = shells.get(&id).ok_or_else(|| "SSH 会话不存在".to_string())?;
        if shell.stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        Arc::clone(&shell.channel)
    };
    let cols = cols.max(20);
    let rows = rows.max(5);
    let mut ch = channel.lock().map_err(|e| e.to_string())?;
    let _ = ch.request_pty_size(cols, rows, None, None);
    Ok(())
}

#[tauri::command]
pub fn ssh_shell_close(state: State<'_, SshState>, id: String) -> CmdResult<()> {
    // 先取出会话数据再放锁：wait_close 会强制阻塞模式等远端关通道，死网络下
    // 可无限阻塞；持锁调用会把 open/write/resize 全部冻结
    let shell = {
        let mut shells = state.shells.lock().map_err(|e| e.to_string())?;
        shells.remove(&id)
    };
    if let Some(shell) = shell {
        shell.stop.store(true, Ordering::SeqCst);
        if let Ok(mut ch) = shell.channel.lock() {
            let _ = ch.send_eof();
            let _ = ch.close();
            // 不 wait_close（理由同上：死网络下无限阻塞）；close + drop 已回收本地资源
        }
    }
    Ok(())
}
