# Prism Code：内存收敛 + Java（JDTLS）语言支持 实施计划

## 背景与目标

用户反馈两台显示器各开一个项目窗口（每个项目里用内置终端跑一个前端 dev server）时，活动监视器内存总量约 2GB，单项目约 800MB；同时需要在现有编辑器里加入 Java 代码支持，实现方式参考 `~/Desktop/WorkSpace/Lithe-IDEA`（Swift/Rust 原生 IDE：Rust Core 承担 LSP 进程/协议，Tauri Windows 宿主只做进程发现；JDTLS 由 `third_party/jdtls/manifest.json` + `scripts/prepare-jdtls.*` 打包，`-Xms256m -Xmx1024m` 上限，`-data` 目录按 workspace 指纹哈希）。

本计划做两件事，且两件事共享同一套内存护栏：

1. **内存收敛**：先建立可复现的度量口径（Prism 自身进程 vs 终端里用户任务的进程分开统计），再逐项修掉「无界增长 / 重复拷贝 / 该释放不释放」的具体点。
2. **Java 语言支持**：在 Rust 侧新增通用 LSP 宿主（帧编解码 + 子进程生命周期），前端新增 LSP 客户端与 Java 会话，Monaco 侧注册 Java 语言与补全/悬浮/签名/跳转/引用/重命名/代码操作/大纲/折叠/格式化 provider；JDTLS + 精简 JRE 随安装包内置，离线可用；功能范围为**语言智能 + 运行/测试**（终端驱动的 Maven/Gradle 目标与 JUnit，不引入调试器）。

已确认的取舍（用户已选择，实施时不再讨论）：

| 决策 | 取值 |
|---|---|
| Java 运行时供给 | 打包内置：JDTLS 归档 + jlink 精简的 Temurin 21 运行时 |
| 功能范围 | 语言智能（补全/诊断/悬浮/签名/跳转/引用/重命名/格式化/大纲/代码操作/反编译类只读查看）+ 运行与测试（终端驱动的构建工具目标） |
| 内存优化的行为边界 | 允许有界化：对比标签上限、非活动 Diff 释放视图、终端回滚 3000→1000 行、Git Log 上限、窗口隐藏时暂停文件监听刷新 |
| JDTLS 版本 | 1.61.0（2026-09-03，需 Java 21，已由内置运行时满足） |

---

## 阶段 A：度量基线与护栏

### A1. 新增 `scripts/memory-report.mjs`（Node ESM，无第三方依赖）

- 采集：`ps -axo pid,ppid,rss,command`（一次）；`pgrep -x prismcode` 找主进程（可用 `--pid` 覆盖）；按父子关系聚合主进程树；终端子进程单列为「终端里运行的用户任务（不属于 Prism 自身）」。
- WebKit 归属：对每个 `com.apple.WebKit.WebContent` 进程执行 `footprint <pid>`，取 `phys_footprint`；若输出中的 `Shared with` 段包含 `prismcode [<pid>]`，把该 WebContent 计入 Prism 窗口，否则归「其他 WebKit 应用」。同一命令对 `com.apple.WebKit.GPU` / `Networking` 同样处理。
- Java 语言服务：命令行含 `org.eclipse.equinox.launcher` 的 `java` 进程单列一行。
- 输出：Markdown 表（进程类 / 进程数 / phys_footprint 合计 / 说明）+ 两行合计：`Prism 自身合计`（主进程 + 归到 Prism 的 WebKit 辅助进程 + Java 语言服务）与 `终端子进程合计`；`--json` 输出机器可读结果，`--with-pty` 时把终端子进程树逐条列出。
- 非 macOS：`footprint` 与 WebKit 归属不可用，对应列打印 `n/a`，仍输出 `ps` 聚合结果。
- `package.json` 新增脚本 `"measure:memory": "node scripts/memory-report.mjs"`。

验收：`pnpm measure:memory` 输出的 Prism 自身合计与手工 `footprint <WebContent pid> | tail -3` 的结果一致（误差 <5%）；打开两个项目窗口时，两行合计之和与活动监视器「内存」列总和对照在 ±10% 内。

---

## 阶段 B：内存收敛（Rust 侧）

### B1. `src-tauri/src/commands/search.rs`：遍历缓存加字节预算并去掉深拷贝

现状（`search.rs:178-248`）：`WalkCache` 最多 32 个 key，value 是**整个工作区的递归路径列表**（无字节上限），`get()` 命中时 `files.clone()` 深拷贝一份；过期条目只在同 key 被再次写入时覆盖，不会被清理。

改动：

1. `map` 的值类型 `(Instant, Vec<PathBuf>)` → `(Instant, Arc<Vec<PathBuf>>)`；`get()` 返回 `Option<Arc<Vec<PathBuf>>>`（去掉 `files.clone()`）。
2. 新增
```rust
const WALK_CACHE_MAX_BYTES: usize = 24 * 1024 * 1024;
fn entry_bytes(files: &[PathBuf]) -> usize { files.iter().map(|p| p.as_os_str().len() + 32).sum() }
```
   `WalkCache` 增加 `bytes: usize` 字段。
3. `insert`：替换/淘汰条目前先扣减对应字节；插入后 `while self.bytes > WALK_CACHE_MAX_BYTES || self.order.len() > self.max { 淘汰 LRU }`（`max` 仍为 32）；单个条目 `entry_bytes(files) > WALK_CACHE_MAX_BYTES` 时**不写缓存**（仍把列表返回给本次调用）。
4. `get`：命中但已过 `WALK_CACHE_TTL`（3s）时移除该条目并扣减字节。
5. 三个调用点 `search.rs:309`、`:373`、`:456` 适配 `Arc<Vec<PathBuf>>`（`for path in cached_walk_files(...)?.iter()`）。

错误处理：无新增错误路径；缓存未命中即重新遍历，行为与现在一致。

单测（`#[cfg(test)] mod tests`，风格对齐 `commands/tooling.rs` 的既有测试）：`evicts_lru_by_byte_budget`、`expired_entry_is_dropped_on_write`、`oversized_entry_is_not_cached`。

### B2. `src-tauri/src/commands/git.rs`：整文件 IPC 与无界缓存加护栏

1. 新增
```rust
const MAX_TEXT_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
const PAYLOAD_TOO_LARGE: &str = "文件过大，无法在编辑器中打开对比";
```
   在 `git_file_sides`（`:1439`）、`git_head_text`（`:1404`）、`git_diff`（`:1317`）、`git_conflict_sides`（`:1492`）打包返回值之前逐个文本判断 `text.len() > MAX_TEXT_PAYLOAD_BYTES` → 返回 `Err(PAYLOAD_TOO_LARGE.to_string())`（前端对比标签/提交面板已有 `showNotice` 兜底，不会静默）。
2. `unpushed_cache`（`:19-27`）新增容量上限 `const UNPUSHED_CACHE_MAX_ENTRIES: usize = 8;`，写入后按插入时间淘汰最旧条目。
3. 不做 `git_status` 截断：提交面板依赖完整列表，截断会造成「文件看不见」的静默错误；如后续实测证明它是热点，再单独设计带 `truncated` 标志的方案。

单测：`oversized_side_is_rejected`、`unpushed_cache_respects_capacity`。

---

## 阶段 C：内存收敛（前端）

### C1. 对比（Diff/合并）标签有界化

问题：`CompareTab` 里存 `left`/`right` 全文（`src/stores/compare.ts:19-33`），标签数量无上限；`EditorArea.vue:925-933` 用 `v-show` 保活，每个标签常驻 2 个 Monaco model 与一个 diffEditor。

改动：

1. `src/features/git/compareTabs.ts`（新增，纯函数便于 node 直测）：
```ts
export const MAX_COMPARE_TABS = 6;
/** 返回插入新标签后应保留的标签 id 序列：超出上限时丢弃最旧的非激活标签 */
export function planCompareTabEviction(
  ids: readonly string[], activeId: string | null, incomingId: string,
): string[];
```
2. `src/stores/compare.ts`：`upsertTab` 在 push 前调用 `planCompareTabEviction`，对被淘汰的 id 执行与 `closeTab` 相同的清理（只从 `tabs` 移除；`activeId` 保持新标签）。
3. `src/features/git/CompareView.vue`：新增
```ts
watch(() => props.active, (active) => { if (active) createView(); else destroyView(); });
```
   `destroyView()`（`:53-61`）已存在；内容由 `syncDocs()` 从 store 回填，因此切回时重建，`setRightContent` 已在每次编辑时写回 store，不丢改动。

验收：连续打开 7 个 diff 标签后 `compareTabs.length === 6` 且最旧的非激活标签被关闭；切走再切回，内容一致（滚动位置不保留，可接受）。

### C2. 查找引用后释放主线程 TypeScript 程序

问题：`src/features/editor/typeService/tsService.ts` 的 `TsLanguageService` 单例持有 `service`/`fileContents`/`fileVersions`/`scriptNames`，只增不减；`findReferences.ts:7` 会为每次引用查询准备程序（含相对 import 闭包），查询结束不释放。

改动：

1. `tsService.ts` 新增
```ts
/** 释放语言服务程序（保留已加载的 ts 模块与 root/source 配置） */
disposeProgram(): void;
```
   清空 `service`、`fileContents`、`fileVersions`、`scriptNames`。
2. `src/features/editor/typeService/index.ts` 导出 `export function releaseTypeScriptProgram(): void { tsService.disposeProgram(); }`。
3. `findReferences.ts`：结果产出后（`finally`）调用 `scheduleTypeScriptProgramRelease()`；同一模块内实现 8s 防抖定时器 `const PROGRAM_RELEASE_DELAY_MS = 8_000;`，新的引用查询开始时 `cancelTypeScriptProgramRelease()`。
4. `ensureTypeScriptProgram(root, ...)`：`tsService.currentRoot !== root` 时先 `disposeProgram()`（工作区切换立即释放）。
5. 不做「把 typescript 模块也卸载」：ES 模块一旦动态 import 就常驻模块注册表，真正卸载需要把类型服务搬进 Worker 并 terminate，成本远大于收益。

验收：`pnpm test:editor-monaco`、`pnpm test:monaco-language` 通过；连续两次「查找引用」结果一致（第二次为重建程序后结果）；`node --experimental-strip-types scripts/type-service-selfcheck.ts` 增补断言：查询结束后 host 缓存已清空（该脚本已在仓库中，仅未被 package.json 收编）。

### C3. 终端回滚区

`src/features/sessions/terminalInputBridge.ts:443`：`scrollback: 3000` → `scrollback: 1000`，并把紧邻注释改写为「每个会话常驻一份回滚缓冲；1000 行足够覆盖 dev server 日志场景，同时避免多终端叠加占用 WebView 内存」。

### C4. 隐藏窗口降载

问题：窗口隐藏时 watcher 事件照常 flush 并触发 `useGitStore().refresh()`（每次 5 路 IPC）（`src/stores/workspace.ts:324-396`、`:418-475`）。

改动（`src/stores/workspace.ts`）：

1. `flushWatchChanges()` 开头：`if (document.visibilityState === "hidden") return;`（保留 `pendingWatchPaths` 与 `pendingGitRefresh` 标志）。
2. `onWatchEvent` 里把 `gitTouched` 记入模块级 `let pendingGitRefresh = false;`（隐藏期间累积）。
3. 新增 `document.addEventListener("visibilitychange", ...)`（在已有 `startWatch` 的注册位置旁）：可见时若 `pendingWatchPaths.size` 非空则 `scheduleWatchFlush()`，若 `pendingGitRefresh` 则 `scheduleGitRefresh()` 并清标志；`stopWatch()` 里不再需要额外清理。
4. 新增 `const MAX_PENDING_WATCH_PATHS = 2000;`：`pendingWatchPaths.size >= MAX_PENDING_WATCH_PATHS` 时清空集合并置 `pendingWatchNeedsTreeRefresh = true`（隐藏期间无界增长的兜底）。

验收：窗口隐藏 5 分钟，IPC 计数不再随时间线性增长（DevTools Network/`invoke` 计数或 `pnpm measure:memory` 前后对比）；窗口恢复后资源树与 Git 状态在一次刷新内追平。

### C5. Git Log 上限

`src/stores/git.ts`：新增 `const MAX_LOG_COMMITS = 400;`；`loadMoreLog()` 在 `logLimit.value >= MAX_LOG_COMMITS` 时不再增加，并 `workspace.showNotice(t("gitLog.limitReached", { count: MAX_LOG_COMMITS }), 3200)`；i18n 新增该 key（两种语言）。

### C6. 明确不做的项（避免重复评估）

Monaco 首屏静态加载（`dist/index.html` 已 modulepreload `monaco-core` 3.8MB、`monaco-langs` 35.9KB、`vue-vendor` 85.8KB）保持现状：打开任一文件即需要，懒加载只在「无编辑器的空窗口」有收益，而 `MonacoEditor.vue`/`CompareView.vue`/`ProblemsPanel.vue` 都直接依赖 `setup.ts` 导出的 `monaco`，改动面与收益不成比例；`marked` 双份（入口 chunk 与 monaco-core 内各一份）、i18n 双语 catalog 同时打包、`CHANGELOG.md?raw` 进首屏，均为 <5MB 量级，不动。

---

## 阶段 D：通用 LSP 宿主（Rust）

### D1. 新增 `src-tauri/src/commands/lsp.rs`

设计边界：Rust 只做「进程 + 帧 + 生命周期」，**不做协议语义**（请求 id 关联、文档版本、capability 协商都在前端 TS，因为文档状态本来就活在 Monaco model 里）；协议层在 TS 侧可用 `node --experimental-strip-types` 直测。

纯函数与常量：

```rust
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const LSP_READ_BUF_BYTES: usize = 32 * 1024;
const LSP_STDERR_LOG_LINES: usize = 500;
const LSP_STOP_GRACE_MS: u64 = 2000;

pub fn frame_message(body: &str) -> Vec<u8>;   // "Content-Length: {byte_len}\r\n\r\n{body}"
pub struct FrameParser { /* 增量缓冲 */ }
impl FrameParser { pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, String>; }
```

`FrameParser::push` 语义：按 `\r\n\r\n` 定位头尾、解析 `Content-Length`、按字节长度切出 UTF-8 正文；头超 `MAX_HEADER_BYTES`、正文超 `MAX_MESSAGE_BYTES`、缺 `Content-Length`、正文非 UTF-8 均返回中文错误串（`"LSP 消息帧无效: ..."`）并清空缓冲（不 panic、不静默丢弃后续帧）。

状态与命令：

```rust
pub struct LspState { sessions: Mutex<HashMap<String, LspSession>> }   // Default + .manage()
struct LspSession { window: String, stdin: Arc<Mutex<ChildStdin>>, child: Arc<Mutex<Child>>,
                    stop: Arc<AtomicBool>, stderr_log: Arc<Mutex<VecDeque<String>>> }

#[tauri::command] async fn lsp_start(window: tauri::WebviewWindow, state: State<'_, LspState>,
    session_id: String, program: String, args: Vec<String>,
    cwd: Option<String>, env: HashMap<String, String>) -> Result<u32, String>;
#[tauri::command] async fn lsp_send(state: State<'_, LspState>, session_id: String, message: String) -> Result<(), String>;
#[tauri::command] async fn lsp_stop(state: State<'_, LspState>, session_id: String) -> Result<(), String>;
#[tauri::command] async fn lsp_logs(state: State<'_, LspState>, session_id: String) -> Result<Vec<String>, String>;
pub fn stop_window_sessions(app: &AppHandle, window_label: &str);   // 窗口销毁时调用
pub fn stop_all_sessions(app: &AppHandle);                           // 应用退出时调用
```

- `lsp_start`：`session_id` 已存在 → `Err("语言服务会话已存在: {session_id}")`；用 `std::process::Command` 配 `stdin/stdout/stderr(piped)` 启动（不经过 shell，避免注入与 PATH 差异）；stdout 读线程按 `FrameParser` 解析并 `window.emit("lsp://message/{session_id}", frame)`；stderr 读线程按行写入 ring buffer（保留最近 `LSP_STDERR_LOG_LINES` 行）并 `window.emit("lsp://stderr/{session_id}", line)`；stdout EOF 后 `child.wait()`，`window.emit("lsp://exit/{session_id}", code)` 并从 `LspState` 移除会话。返回子进程 pid（用于状态展示）。
- `lsp_send`：未知会话 → `Err("语言服务会话不存在: {session_id}")`；否则写 `frame_message` 到 stdin。
- `lsp_stop`：幂等（会话不存在返回 `Ok(())`）；关闭 stdin → 每 50ms `try_wait` → 超过 `LSP_STOP_GRACE_MS` 仍存活则 `kill()`；移除会话。
- `lsp_logs`：返回 ring buffer 快照（供「查看 Java 日志」）。

单测：`frame_message` 以中文正文校验字节长度；`FrameParser` 覆盖整帧、逐字节分片、一次多帧、超长头、缺 `Content-Length`、非 UTF-8 正文；`lsp_stop` 未知会话幂等（用不存在的 id）。

### D2. 接线 `src-tauri/src/lib.rs`、`src-tauri/src/commands/mod.rs`

1. `commands/mod.rs` 末尾追加 `pub mod java;`、`pub mod lsp;`（保持字母序，`java` 在 `git` 之后、`lsp` 在 `path_util` 之前）。
2. `lib.rs:343-347` 的 `.manage(...)` 链追加 `.manage(commands::lsp::LspState::default())`。
3. `lib.rs:391-491` 的 `generate_handler!` 追加 `commands::lsp::{lsp_start, lsp_send, lsp_stop, lsp_logs}` 与 E1 的三个 java 命令。
4. `lib.rs:519-527` 的 `RunEvent::WindowEvent { label, event: WindowEvent::Destroyed }` 分支在现有 `clear_window(label)` 之外调用 `commands::lsp::stop_window_sessions(app, label)`。
5. `lib.rs:508-517` 的 `RunEvent::ExitRequested` 分支追加 `commands::lsp::stop_all_sessions(app)`。

验收：`cargo check --manifest-path src-tauri/Cargo.toml`；窗口关闭后 `pgrep -fl org.eclipse.equinox.launcher` 无残留。

---

## 阶段 E：Java 运行时、启动计划与打包

### E1. 新增 `src-tauri/src/commands/java.rs`

常量：

```rust
const JDTLS_VERSION: &str = "1.61.0";
const JDTLS_DIR_NAME: &str = "jdtls";
const JRE_DIR_NAME: &str = "jre";
const JAVA_CACHE_DIR: &str = "java";
const JDT_WORKSPACE_RETENTION_DAYS: u64 = 30;
const JAVA_HEAP_CLAMP: (u32, u32) = (512, 4096);
```

纯函数（全部配单测）：

```rust
pub fn normalize_workspace_identity(root: &Path) -> String;      // 统一 '/'、词法折叠 '.'/'..'、去尾 '/'
pub fn workspace_key(root: &Path) -> String;                     // sha256(identity + '\0' + JDTLS_VERSION) 小写 hex
pub fn platform_config_dir() -> &'static str;                    // mac arm64: config_mac_arm / mac x86_64: config_mac / linux: config_linux / windows: config_win
pub fn clamp_heap_mb(value: u32) -> u32;                         // 512..=4096
pub fn build_jdtls_args(jre: &Path, lombok: Option<&Path>, launcher_jar: &Path, config_dir: &Path, data_dir: &Path, heap_mb: u32) -> Vec<String>;
pub fn select_stale_workspace_dirs(entries: &[(String, SystemTime)], now: SystemTime, days: u64) -> Vec<String>;
```

`build_jdtls_args` 输出顺序（固定，不重复、不允许被调用方再拼）：

```
[-javaagent:<lombok.jar>]           # 仅当 lombok 存在
-Xms256m
-Xmx{clamped_heap}m
-XX:MaxMetaspaceSize=512m
-Dfile.encoding=UTF-8
--add-modules=ALL-SYSTEM
--add-opens=java.base/java.util=ALL-UNNAMED
--add-opens=java.base/java.lang=ALL-UNNAMED
-Declipse.application=org.eclipse.jdt.ls.core.id1
-Declipse.product=org.eclipse.jdt.ls.core.product
-Dosgi.bundles.defaultStartLevel=4
-Dlog.level=WARNING
-jar <launcher_jar>
-configuration <config_dir>
-data <data_dir>
```

相对 Lithe 的两处差异（照抄会踩坑）：`-Dlog.level=ALL` 改为 `WARNING`（Lithe 用 ALL，日志写入量与 IO 明显更大）；`-data` 只按 workspace 根哈希，不叠加结构指纹（指纹会因 `pom.xml` 改动频繁产生新索引目录，磁盘与首次导入成本翻倍；构建文件变化由 JDTLS 自身重导入处理）。

命令（进程/文件 IO 一律 `tauri::async_runtime::spawn_blocking`，与 `commands/tooling.rs` 一致）：

```rust
#[derive(serde::Serialize)]
pub struct JavaRuntimeInfo { jre_home: String, java_bin: String, java_version: String,
                             jdtls_root: String, jdtls_version: String, lombok: bool }
#[derive(serde::Serialize)]
pub struct JavaLaunchPlan { program: String, args: Vec<String>, cwd: String,
                            data_dir: String, config_dir: String, env: HashMap<String, String>,
                            workspace_key: String }   // 64 位小写 hex，前端据此拼安全 sessionId

#[tauri::command] async fn java_probe_runtime(app: AppHandle, jre_path: Option<String>, jdtls_path: Option<String>) -> Result<JavaRuntimeInfo, String>;
#[tauri::command] async fn java_launch_plan(app: AppHandle, root: String, heap_mb: u32, jre_path: Option<String>, jdtls_path: Option<String>) -> Result<JavaLaunchPlan, String>;
#[tauri::command] async fn java_rebuild_index(app: AppHandle, root: String, jre_path: Option<String>, jdtls_path: Option<String>) -> Result<(), String>;
```

- 资源根（`resource_roots`）：`app.path().resource_dir()`、可执行文件同级目录、环境变量 `PRISMCODE_JAVA_ROOT`（dev 指向仓库 `.artifacts`）。
- JDTLS 定位顺序：设置里的 `jdtls_path` → `<root>/jdtls/<JDTLS_VERSION>` → `<root>/jdtls` → 项目侧 `.artifacts/jdtls/<JDTLS_VERSION>`；校验 `plugins/org.eclipse.equinox.launcher_*.jar`（排序取第一个）、`<platform_config_dir>`、`lombok/lombok.jar`（缺失记 `lombok: false`，不报错）；失败返回稳定前缀 `"jdtls-missing: ..."`。
- JRE 定位顺序：设置里的 `jre_path` → `<root>/jre` → 环境变量 `PRISMCODE_JRE_HOME`；校验 `<jre>/bin/java`（Windows `java.exe`）存在；失败返回 `"jre-missing: ..."`。`java_version` 由 `<java_bin> -version` 解析 `version "` 之后的串（失败 → `"jre-invalid: 无法执行 java"`），按 `java_bin` 路径缓存到 `OnceLock<Mutex<HashMap<String, JavaRuntimeInfo>>>`。
- 工作区目录：`~/.prismcode/java/data/<workspace_key>`（`-data`）与 `~/.prismcode/java/config/<workspace_key>`（`-configuration`）。`config` 目录是**每工作区一份可写副本**：源是 JDTLS 安装目录里的 `config_*`，首次创建或 `config.ini` 与源不一致时清空重建后整目录复制（JDTLS README 明确要求 `-configuration` 指向用户可写目录，不能指向安装目录；单份共享配置目录在双窗口并发时会有 Equinox 存储区竞争）。
- `prune_stale_workspaces`：进程内只跑一次（`static PRUNED: OnceLock<()>`），用 `select_stale_workspace_dirs` 找出 30 天未修改的 `data/*` 目录并连同同名 `config/*` 删除，失败只记日志。
- `env`：`JAVA_HOME=<jre_home>`、`PATH=<jre_home>/bin:<原 PATH>`（JDTLS 内部的 Gradle/Maven 解析需要）、`JAVA_TOOL_OPTIONS=""`（屏蔽用户环境注入的 JVM 选项，避免覆盖我们的内存上限）。
- `java_rebuild_index`：**由前端先停止会话**，再按 `workspace_key` 只删除 `data/<key>` 与 `config/<key>`，其他项目缓存保留。

单测：`build_jdtls_args` 参数顺序与 `-Xmx` 唯一（传入 8192 时出现 `-Xmx4096m`）、lombok 存在/缺失两种形态；`workspace_key` 对 `/a/b/`、`/a/./b`、`/a/../a/b`、`C:\a\b` 与 `c:/a/b` 的稳定性；`select_stale_workspace_dirs` 的边界（正好 30 天不删、31 天删）；`clamp_heap_mb`。

### E2. 打包与发布

1. `third_party/jdtls/manifest.json`（新增）：

```json
{
  "version": "1.61.0",
  "archiveURL": "https://download.eclipse.org/jdtls/milestones/1.61.0/jdt-language-server-1.61.0-202609031315.tar.gz",
  "archiveSHA256": "<下载 https://download.eclipse.org/jdtls/milestones/1.61.0/jdt-language-server-1.61.0-202609031315.tar.gz.sha256 取其中哈希填入>",
  "licenseURL": "https://www.eclipse.org/org/documents/epl-2.0/EPL-2.0.txt",
  "licenseSHA256": "<下载后填入>",
  "lombokVersion": "1.18.46",
  "lombokURL": "https://repo.maven.apache.org/maven2/org/projectlombok/lombok/1.18.46/lombok-1.18.46.jar",
  "lombokSHA256": "01f7b1a015e33e2b62d5f5f37053306357ab1415fd181fcba7794f5d198c1126",
  "lombokLicenseURL": "https://raw.githubusercontent.com/projectlombok/lombok/v1.18.46/LICENSE",
  "lombokLicenseSHA256": "76479448741d7a7a3a97b6afd9ab9699d95621faafc65a1b8e9149342ea00feb"
}
```

2. `third_party/jre/manifest.json`（新增）：Temurin 21 JDK，四平台条目由
`https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=<aarch64|x64>&image_type=jdk&os=<mac|windows|linux>&vendor=eclipse`
的 `binary.package.link` 与 `binary.package.checksum` 填入，并记录解压根目录名（`binary.package.name` 去扩展名）供脚本使用。不要手写 URL。

3. `scripts/prepare-jdtls.mjs`（新增，四平台通用 Node 脚本，风格对齐 `scripts/sync-icon-assets.mjs`）：
   读 manifest → 下载（`fetch` 流式写文件，失败重试 3 次）到 `.artifacts/downloads/` → `node:crypto` 校验 SHA-256 → 解压到 `.artifacts/jdtls/<version>/`（`tar -xzf`；Windows 用系统 `tar.exe`）→ 下载并校验 lombok jar 到 `.artifacts/jdtls/<version>/lombok/lombok.jar` → 校验 `plugins/`、当前平台 `config_*`、`lombok/lombok.jar` 三项齐备 → 打印产物路径。已存在且哈希匹配时跳过下载（缓存友好）。

4. `scripts/prepare-jre.mjs`（新增）：
   下载并校验平台 JDK 到 `.artifacts/downloads/jdk/` → 解压 → 用解压出的 JDK 自带 `bin/jlink` 生成 `.artifacts/jre`：

```
--add-modules java.se,jdk.attach,jdk.compiler,jdk.javadoc,jdk.jartool,jdk.unsupported,jdk.zipfs,jdk.httpserver,jdk.management,jdk.management.agent,jdk.crypto.ec,jdk.localedata,jdk.jdwp.agent
--strip-debug --no-header-files --no-man-pages --compress=zip-6
```

   （`--compress=zip-6` 被该 jlink 拒绝时回退 `--compress=2`。）macOS 上对 `.artifacts/jre` 里的 Mach-O（`bin/*`、`lib/libjli.dylib`、`lib/server/libjvm.dylib` 等）逐个 `codesign --force --sign -`，保证嵌套二进制在 ad-hoc 签名包内可执行。脚本结束时打印 `du -sh .artifacts/jre`。
   用途说明：`jdk.compiler` 是「运行单个 `.java` 文件」（JRE 21 源码模式）与 JDTLS 内部编译所必需；模块集合是起点，按验证结果可加模块——若出现模块缺失，直接改为整包 Temurin JDK 21（跳过 jlink，把解压目录当 `.artifacts/jre`）。

5. `src-tauri/tauri.jdtls.conf.json`（新增）：

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "bundle": { "resources": { "../.artifacts/jdtls": "jdtls", "../.artifacts/jre": "jre" } }
}
```

6. `.github/workflows/release.yml`：
   - 在 `pnpm install --frozen-lockfile` 之后、`tauri-action` 之前加步骤 `Prepare Java runtime`：`node scripts/prepare-jdtls.mjs && node scripts/prepare-jre.mjs`；
   - 给四个 matrix 条目的 `args` 由 `""` 改为 `"--config src-tauri/tauri.jdtls.conf.json"`；
   - 加 `actions/cache@v4` 缓存 `.artifacts/downloads`，key 用 `third_party/jdtls/manifest.json` + `third_party/jre/manifest.json` 的内容哈希。
7. `.gitignore` 追加 `/.artifacts/`。
8. `THIRD-PARTY-NOTICES.md` 追加 JDTLS（EPL-2.0）、Temurin 21（GPLv2+CE）、Lombok（MIT）三条与许可证文本落点（随打包步骤一起改，不单列）。

验收：`node scripts/prepare-jdtls.mjs && node scripts/prepare-jre.mjs` 在 macOS arm64 产出 `.artifacts/jdtls/1.61.0/{plugins,config_mac_arm,lombok/lombok.jar}` 与 `.artifacts/jre/bin/java`；`.artifacts/jre/bin/java -version` 打印 `21.x`；`pnpm tauri build -- --config src-tauri/tauri.jdtls.conf.json` 产物为 `Prism Code.app/Contents/Resources/{jdtls,jre}`。开发期用 `PRISMCODE_JAVA_ROOT="$PWD/.artifacts" pnpm tauri:dev` 走同一套定位逻辑。

---

## 阶段 F：前端 LSP 客户端与 Java 会话

### F1. `src/features/editor/lsp/convert.ts`（新增，共享转换层）

把 `htmlCssProvider.ts:78-160` 的私有转换函数**搬进**此文件并扩充，`htmlCssProvider.ts` 改为从这里 import（同一实现不留两份）：

```ts
export function uriToPath(uri: string): string;          // file:// → 绝对路径（处理 %20 与非 ASCII）
export function pathToUri(path: string): string;
export function toLspPosition(p: monaco.Position): { line: number; character: number };
export function toMonacoRange(r: LspRange): monaco.IRange;
export function toMonacoSelection(r: LspRange): monaco.Selection;
export function toMarkdownString(v: MarkupContent | MarkedString): IMarkdownString;
export function toMonacoDocumentation(v: string | MarkupContent | undefined): string | IMarkdownString | undefined;
export function editRange(e: TextEdit | InsertReplaceEdit): LspRange;
export function toMonacoCompletion(item: LspCompletionItem, fallback: monaco.IRange): monaco.languages.CompletionItem;
export function toMonacoHover(hover: LspHover | null): monaco.languages.Hover | null;
export function toMonacoMarker(d: LspDiagnostic): monaco.editor.IMarkerData;   // source 固定 "Java"
export function toMonacoTextEdits(edits: readonly LspTextEdit[]): monaco.languages.TextEdit[];
export function toMonacoWorkspaceEdit(edit: LspWorkspaceEdit, root: string): monaco.languages.WorkspaceEdit;
export function completionKindToMonaco(kind: number | undefined): monaco.languages.CompletionItemKind;
export function symbolKindToMonaco(kind: number): monaco.languages.SymbolKind;
```

约束：本文件只允许 `import type`（不得把 Monaco 内核拖进 node 直测）；严重级别用本地等值常量
`export const MARKER_SEVERITY = { error: 8, warning: 4, info: 2, hint: 1 } as const;`（取值等于 Monaco `MarkerSeverity`，注释标注来源），所有取值在 `scripts/java-selfcheck.ts` 里断言。

### F2. `src/features/editor/lsp/client.ts` + `transport.ts`（新增）

```ts
export interface LspTransport { send(message: string): Promise<void>; close(): Promise<void>; }
export interface LspClientOptions {
  transport: LspTransport;
  requestTimeoutMs?: number;                      // 默认 30_000
  onNotification(method: string, params: unknown): void;
  onServerRequest(method: string, params: unknown): Promise<unknown>;
  onExit?(code: number | null): void;
  onStderr?(line: string): void;
}
export class LspClient {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  handleMessage(raw: string): void;               // 响应/服务端请求/通知三态分派
  dispose(): void;                                // 拒绝所有 pending
}
export class LspRequestError extends Error { code: number; method: string; }
```

- 超时：`request` 到期先发 `$/cancelRequest` 再以 `LspRequestError(-32800, method)` 拒绝。
- 服务端请求：`onServerRequest` 抛错 → 回 `{ code: -32601, message: "Method not found" }`。
- `transport.ts`：`createTauriLspTransport(sessionId, handlers)` 用 `invoke("lsp_send", { sessionId, message })` 发送，`listen("lsp://message/" + sessionId)` 接收，`lsp://stderr/*` → `onStderr`，`lsp://exit/*` → `onExit`；`close()` 只解绑监听（进程由 `lsp_stop` 负责）。

自测（`scripts/java-selfcheck.ts`）：id 关联与乱序响应、超时取消报文、未知 id 忽略、服务端请求得答复、`dispose()` 后所有 pending 拒绝、UTF-8 中文正文往返。

### F3. `src/features/java/jdtls.ts` + `javaSession.ts`（新增）

`jdtls.ts`（纯逻辑为主，node 直测）：

```ts
export const JAVA_LANGUAGE_ID = "java";
export const SERVICE_READY_IDLE_TIMEOUT_MS = 45_000;
export const SERVICE_READY_ABSOLUTE_TIMEOUT_MS = 600_000;
export const INITIALIZE_TIMEOUT_MS = 20_000;
export const SHUTDOWN_TIMEOUT_MS = 2_000;
export function clientCapabilities(): unknown;
export function initializationOptions(): unknown;
export function javaSettings(): unknown;
export function javaConfigurationForSection(section: string | null): unknown;
export function isServiceReady(params: unknown): boolean;
export function progressFromStatus(params: unknown): { message?: string; percentage?: number } | null;
export function virtualSourceCommand(uri: string): { command: "java.decompile"; arguments: [string] };
export function isJavaWatchedPath(relPath: string): boolean;
```

- 能力声明：`workspace.{configuration, workspaceFolders, applyEdit, workspaceEdit.documentChanges}`、`textDocument.{synchronization(incremental), publishDiagnostics(versionSupport/relatedInformation/tagSupport), completion(snippetSupport/resolveSupport/documentationFormat), hover(markdown), signatureHelp, definition, typeDefinition, implementation, references, rename, formatting, codeAction(codeActionLiteralSupport/resolveSupport), documentSymbol(hierarchicalDocumentSymbolSupport), foldingRange}`；**不声明** `semanticTokens`、`inlayHint`、`codeLens`（避免为未实现的 UI 付请求与内存成本）。
- `initializationOptions`：`{ extendedClientCapabilities: { classFileContentsSupport: true } }`。
- `javaSettings()` / `javaConfigurationForSection()`：以 Lithe `jdt.rs:648-721` 为模板，但关闭 code lens 与 inlay hint：
```json
{"java":{"eclipse":{"downloadSources":false},"maven":{"downloadSources":false},
 "configuration":{"updateBuildConfiguration":"automatic"},
 "inlayHints":{"parameterNames":{"enabled":"none"}},
 "implementationsCodeLens":{"enabled":false},"referencesCodeLens":{"enabled":false},
 "autobuild":{"enabled":true},"format":{"enabled":true}}}
```
  未知 section 返回 `null`（JDTLS 逐级回退默认值）。
- 就绪判定：只认 `language/status` 的 `{ type: "ServiceReady" }`；idle 超时 45s / 绝对上限 10 分钟（`$/progress` 的有效进展续期 idle）；超时置 `error` 且不自动重启。

`javaSession.ts`（会话生命周期，唯一写这些状态的地方）：

- 单例：`let session: JavaSession | null`；`ensureJavaSession(reason: "file-open" | "manual")` 幂等，正在启动时复用同一个 Promise。
- 启动序列：`java_probe_runtime`（失败 → `showNotice(t("java.notice.runtimeMissing", { detail }))` + 状态 `error`）→ `java_launch_plan` → `lsp_start({ sessionId, program, args, cwd, env })`，其中 `const sessionId = "java-" + plan.workspace_key.slice(0, 16);`（Tauri 事件名只接受字母/数字/`-`/`/`/`:`/`_`，不能直接拼工作区绝对路径） → `initialize`（`rootUri`、`workspaceFolders: [{ uri, name }]`、`initializationOptions`、`capabilities`、`processId: null`）→ `initialized` → `workspace/didChangeConfiguration { settings: javaSettings() }` → 状态 `initializing` → 等就绪 → ready 后排空积压的 `didOpen`。
- 文档同步：`monaco.editor.onDidCreateModel`（`getLanguageId() === "java"` → `didOpen`）、`model.onDidChangeContent`（`e.changes` 直接映射 `TextDocumentContentChangeEvent`：`range`+`text`；未 ready 时按 URI/版本排队）、`onWillDisposeModel`（`didClose` 并清该 model 的 `java` markers）；写盘后由编辑器 store 调 `notifyJavaDidSave(path)`；workspace watcher 变化调 `notifyJavaWatchedFiles(paths)`（350ms 合并，仅 `.java`/`pom.xml`/`build.gradle(.kts)`/`settings.gradle(.kts)`/`gradle.properties`/`mvnw*`，用 `isJavaWatchedPath` 过滤）。
- 诊断：`publishDiagnostics` → 对应 model 打开时 `setModelMarkers(model, "java", ...)`（`source: "Java"`）；Problems 面板无需改动（它直接读 Monaco markers）。
- 服务端请求：`workspace/configuration` → `javaConfigurationForSection`；`client/registerCapability`/`unregisterCapability` → 记录后回 `null`；`window/workDoneProgress/create` → `null`；`workspace/applyEdit` → `applyWorkspaceEdit` 后回 `{ applied: true }` 或 `{ applied: false, failureReason }`；`window/showMessageRequest` → `null`；`window/showMessage` → `showNotice(message, 4000)`。
- `applyWorkspaceEdit(edit)`：`changes`/`documentChanges` 两种形态；`file:` 且 model 已打开 → `pushEditOperations`（保留 undo）；未打开 → 读盘、应用后写盘（与 `renameSymbol` 现有做法一致）；资源操作（create/rename/delete）与 `jdt://` 目标返回未应用（避免误删与幽灵写盘）。
- 停止：`stopJavaSession()` 供「空闲停止」「设置里停用」「立即停止」「切换工作区」「重建索引」复用；`shutdown`（2s）→ `exit` → `invoke("lsp_stop")` → 清状态、清所有 `java` markers。空闲停止：`settings.java.idleStopMinutes`（0 = 不停），条件为「无打开的 Java model + 窗口隐藏或失焦」持续到点；聚焦且有 Java model 时重置。
- 状态：`export const javaStatus = ref<{ state: "stopped"|"starting"|"initializing"|"ready"|"error"; message?: string; percentage?: number; detail?: string }>(...)`；`language/status` 的 `message` 与 `$/progress` 的 `begin/report`（token 由 `window/workDoneProgress/create` 建立）都写入状态栏文案的 `message`/`percentage`；**不移植** Lithe `jdt_progress` 那套导入统计与超时分类（结构化进度只服务状态栏一行文案，不做日志节流体系）。
- 明确不接入 JDTLS 的测试/运行协议（`java/test`、`java/run`、调试适配器）：运行/测试完全走 F6 的终端命令注入，测试结果不做结构化解析（终端即结果视图）。

单测（node 直测，`scripts/java-selfcheck.ts`）：`didChange` 增量报文形态（含 CRLF 与中文）、`isJavaWatchedPath` 白/黑名单、`isServiceReady` 与 `progressFromStatus`、`virtualSourceCommand`、`applyWorkspaceEdit` 的资源操作拒绝分支、排队顺序（未 ready 时的 `didOpen` 在 ready 后按原顺序发出）。

### F4. `src/features/editor/monaco/javaProviders.ts`（新增）与编辑器侧接入

新增 `javaProviders.ts`（模块级 `registered` 幂等守卫 + `disposables[]`，形制照抄 `htmlCssProvider.ts:161-289`；服务端未就绪时返回 `null` 而不是报错）：

```ts
export function installJavaProviders(deps: {
  ensureSession(): Promise<boolean>;   // 未就绪/已停用 → false
  client(): LspClient | null;          // 来自 @/features/java/javaSession 的 currentJavaClient()
}): void;
```

注册清单（全部以 `await deps.ensureSession()` 开头，`client` 为 null 直接返回 `null`）：

| Monaco provider | LSP 方法 | 备注 |
|---|---|---|
| `registerCompletionItemProvider` | `textDocument/completion` + `completionItem/resolve` | `triggerCharacters: [".", "@", "("]` |
| `registerHoverProvider` | `textDocument/hover` | |
| `registerSignatureHelpProvider` | `textDocument/signatureHelp` | `triggerCharacters: ["(", ","]`、`retriggerCharacters: [","]` |
| `registerDefinitionProvider` | `textDocument/definition` | `jdt://` 结果交给 F5 的 opener |
| `registerTypeDefinitionProvider` | `textDocument/typeDefinition` | 同上 |
| `registerImplementationProvider` | `textDocument/implementation` | 同上 |
| `registerReferenceProvider` | `textDocument/references` | `includeDeclaration: true` |
| `registerRenameProvider` | `textDocument/rename` | 经 `toMonacoWorkspaceEdit` 转 Monaco 编辑 |
| `registerCodeActionProvider` | `textDocument/codeAction` + `codeAction/resolve` | 传 `context.only`/`context.diagnostics` |
| `registerDocumentSymbolProvider` | `textDocument/documentSymbol` | 喂面包屑/大纲 |
| `registerFoldingRangeProvider` | `textDocument/foldingRange` | |
| `registerDocumentFormattingEditProvider` + `registerDocumentRangeFormattingEditProvider` | `textDocument/formatting`、`rangeFormatting` | |

**不注册** `semanticTokens`、`inlayHints`、`codeLens`（与 F3 的能力声明一致，避免只为占位付请求成本）。provider 返回的位置/编辑一律走 F1 的转换函数；请求超时与取消由 `LspClient` 负责（provider 内不再自造 AbortController）。

编辑器侧接入：

1. `src/features/editor/MonacoEditor.vue`：`onMounted` 在 `registerHtmlCssProviders()` 之后调用
   `installJavaProviders({ ensureSession: ensureJavaSession, client: currentJavaClient })`；`switchDocument()` 内当 `model.getLanguageId() === "java"` 且 `settings.java.enabled` 为真时 `void ensureJavaSession("file-open")`（首次打开 Java 文件即懒启动 JDTLS）；`onBeforeUnmount` 不解绑 provider（全局幂等注册，与现有 HTML/CSS provider 同策略）。
2. `src/features/editor/monaco/setup.ts`：在 `languages/definitions/xml/register` 之后加 `import "monaco-editor/languages/definitions/java/register";`（0.57 已内置 `languages/definitions/java/java.js`，5.1KB Monarch 词法 + 语言配置，无需自研）。
3. 缩进：`langSetup.ts` 新增
```ts
export function indentOptionsFor(languageId: string, prefs: EditorPreferences): { tabSize: number; insertSpaces: boolean };
```
   `java` → `{ tabSize: 4, insertSpaces: true }`，其余语言用 `prefs.tabSize`；`MonacoEditor.vue:applyIndentOptions()` 改用它。
4. `src/stores/editor.ts`：`saveActive` 与 `saveAll` 在 `writeTextFile` 成功后追加
   `void import("@/features/java/javaSession").then((m) => m.notifyJavaDidSave(tabPath));`（与现有 `void git.scheduleRefresh()` 同位置、同风格）。
5. `src/stores/workspace.ts`：`flushWatchChanges()` 处理完一批路径后追加
   `void import("@/features/java/javaSession").then((m) => m.notifyJavaWatchedFiles(changedPaths));`（无 Java 会话时内部直接返回，不做任何 IPC）。

### F5. 跨文件跳转与虚拟文档（`jdt://` 反编译类）

1. 模块级安装一次 `monaco.editor.registerEditorOpener`：
   - `resource.scheme === "file"` → `editorStore.openFileAt(uriToPath(resource.toString()), line, column)` 并 `return true`；
   - `resource.scheme === "jdt"` → `void openJavaVirtualClass(resource.toString())` 并 `return true`；
   - 其他 → `return false`。
2. `src/stores/editor.ts`：`EditorTab` 增加 `virtual?: { uri: string; language: string }`；新增 `async function openVirtualTab(uri: string, content: string, displayName: string)`（`id = path = uri`，不读盘/不写盘/不参与 `scopeFor`，`dirty: false`）；`saveActive`、`saveAll`、`syncExternalChanges`、`reloadAfterDiscard` 在 `tab.virtual` 为真时直接返回（显式保存时给一次 `showNotice(t("editor.virtualReadOnly"))`）。
3. `src/shared/editorSession.ts`：序列化与解析阶段过滤 `virtual` 标签（不落快照）。
4. `MonacoEditor.vue` props 增加可选 `uri?: string`、`languageHint?: string`：`ensureModel` 用 `props.uri ? monaco.Uri.parse(props.uri) : monaco.Uri.file(path)`，语言用 `props.languageHint ?? languageForContent(path, content)`；`EditorArea.vue` 的 `<MonacoEditor>` 传 `:uri="activeTab.virtual?.uri"` 与 `:language-hint="activeTab.virtual?.language"`。
5. `src/features/java/javaVirtualDocs.ts`：`openJavaVirtualClass(uri)`：已打开则激活；否则 `request("workspace/executeCommand", virtualSourceCommand(uri))` → `openVirtualTab(uri, content, displayNameFromJdtUri(uri))`；失败 `showNotice(t("java.notice.decompileFailed"))`。

### F6. 运行 / 测试（终端驱动）

1. `src/shared/javaRun.ts`（纯函数 + node 直测）：
```ts
export type JavaBuildTool = "maven-wrapper" | "maven" | "gradle-wrapper" | "gradle" | "none";
export function detectJavaBuildTool(exists: (relPath: string) => boolean): JavaBuildTool;
// 判定顺序：mvnw|mvnw.cmd → maven-wrapper；pom.xml → maven；gradlew|gradlew.bat → gradle-wrapper；build.gradle|build.gradle.kts → gradle；否则 none
export function javaRunCommands(tool: JavaBuildTool, opts: {
  className: string | null; filePath: string | null; javaBin: string | null; sep: "/" | "\\";
}): Array<{ id: "test"|"build"|"clean"|"runFile"; labelKey: string; command: string }>;
```
   - `maven*` → `test: "./mvnw -q test[ -Dtest=<className>]"`、`build: "./mvnw -q -DskipTests package"`、`clean: "./mvnw -q clean"`（无 wrapper 时用 `mvn`）；
   - `gradle*` → `test: "./gradlew test[ --tests <className>]"`、`build: "./gradlew build"`、`clean: "./gradlew clean"`（无 wrapper 时用 `gradle`）；
   - `none` 且 `javaBin`/`filePath` 都有 → `runFile: "<javaBin> <filePath>"`（JRE 21 单文件源码启动）；
   - 路径含空格时用双引号包裹（Windows 用 `\` 分隔符）。
2. `src/stores/java.ts`（Pinia）：`runtime`、`buildTool`、`status`（引用 `javaStatus`）、`detect()`（`invoke("java_probe_runtime")` + 用 `path_exists` 探测五个构建文件）、`run(id)`（`useSessionsStore().runInLocalTerminal(command, workspace.rootPath)`，忙/闲由既有终端空闲检测决定是否新开终端）、`start()`/`stop()`/`rebuildIndex()`/`viewLogs()`（`lsp_logs` 取最近 30 行 `showNotice`）。
3. 入口：
   - `src/app/EditorArea.vue` 编辑器右键菜单（`:1152-1180` 的 `editorCtx` 区块）：`activeTab?.language === "java"` 时插入 `<hr />` + Java 分组（运行当前文件 / 运行测试 / 构建 / 清理 / 重启语言服务），动作失败给 `showNotice`；
   - `src/app/StatusBar.vue` 右侧新增 Java 药丸（当前文件为 Java 或语言服务非 `stopped` 时渲染，`title` 显示 `status.message`），点击打开 `javaMenuOpen` 浮层（复用 `themeMenuOpen` 的浮层与关闭手势逻辑），条目：启动/停止语言服务、重新构建索引、查看日志、打开 Java 设置。

### F7. 设置、i18n、状态栏文案

1. `src/shared/types.ts`：
```ts
export interface JavaPreferences {
  enabled: boolean;        // 启用 Java 语言服务
  serverMemoryMb: number;  // 语言服务 JVM 堆上限，clamp 512..4096
  idleStopMinutes: number; // 无 Java 文件且窗口不活跃时自动停止的分钟数，0 = 不停
  jrePath: string;         // 覆盖内置运行时，留空用内置
  jdtlsPath: string;       // 覆盖内置 JDTLS，留空用内置
}
```
   `AppSettings` 增加 `java: JavaPreferences`；`DEFAULT_SETTINGS.java = { enabled: true, serverMemoryMb: 1024, idleStopMinutes: 10, jrePath: "", jdtlsPath: "" }`；`loadSettings()`（`settings.ts:46-167`）按 `editorOverrides` 同款方式合并，并对 `serverMemoryMb`/`idleStopMinutes` 做数字与范围校验（非法回落默认）。
2. `src/stores/settings.ts`：新增 `patchJava(patch: Partial<JavaPreferences>)`；`watch` 里 `settings.java.enabled === false` 时 `void import("@/features/java/javaSession").then((m) => m.stopJavaSession())`。
3. `src/features/settings/SettingsModal.vue`：`navItems`（`:54-57`）新增 `{ id: "java", label: t("settings.navJava") }`（editor 与 shortcuts 之间），内容区新增 `ui-card section`：启用开关、JVM 堆上限（512–4096）、空闲停止分钟（0–60）、JRE 路径、JDTLS 路径、「检测运行时」（展示 `java_probe_runtime` 结果）、「重新构建索引」「查看日志」「立即停止」。
4. `src/i18n/locales/zh-CN.ts` / `en-US.ts`：新增顶层 `java:` 命名空间（`java.status.*`、`java.action.*`、`java.notice.*`、`java.settings.*`），`settings.*` 增加 `navJava`，`gitLog.*` 增加 `limitReached`，`editor.*` 增加 `virtualReadOnly`。键必须落在顶层命名空间（历史上 `problems.*` 曾被塞进 `settings` 之下导致界面显示原始 key）。
5. `src/shared/fs.ts:languageFromPath()` 增加 `.java → "Java"`（现在落到 `Plain Text`，状态栏语言名会错）。

### F8. 自测脚本

`scripts/java-selfcheck.ts`（`node --experimental-strip-types`，无浏览器）：F1/F2/F3/F6 的全部纯函数断言；`package.json` 增加 `"test:java": "node --experimental-strip-types scripts/java-selfcheck.ts"`。需要 Monaco/DOM 的部分（provider 注册、marker 落地）放进既有 puppeteer 自测（`scripts/problems-panel-selfcheck.ts` 增补 Java marker 断言）。

测试夹具 `examples/java-fixture/`（新增，供端到端验证；无构建文件，因此不触发 Maven/Gradle 联网解析，JDTLS 走 standalone 源文件模式）：

- `src/Hello.java`：含一个静态方法 `greet(String)` 与一个字段，供补全/跳转/引用/重命名用。
- `src/Broken.java`：一行确定的类型错误（`int value = "x";`），用于断言诊断落地。
- `src/Caller.java`：`Hello.greet("x")` 调用方，用于跨文件跳转与引用。
- `src/ImportDemo.java`：使用两个 JDK 类（如 `java.util.List`/`java.util.ArrayList`），用于验证反编译 `jdt://` 只读标签与 `Organize Imports`。

---

## 关键文件与锚点

| 文件 | 符号 / 区域 | 作用 |
|---|---|---|
| `src-tauri/src/commands/lsp.rs`（新） | `frame_message`、`FrameParser`、`lsp_start`/`lsp_send`/`lsp_stop`/`lsp_logs`、`stop_window_sessions` | 通用 LSP 宿主：帧编解码、子进程与生命周期 |
| `src-tauri/src/commands/java.rs`（新） | `build_jdtls_args`、`workspace_key`、`java_launch_plan`、`java_probe_runtime`、`java_rebuild_index` | JDTLS/JRE 定位与启动计划、缓存目录与清理 |
| `src/features/java/javaSession.ts`（新） | `ensureJavaSession`、`stopJavaSession`、`javaStatus`、`applyWorkspaceEdit` | 会话生命周期、文档同步、诊断、服务端请求、空闲停止 |
| `src/features/editor/monaco/setup.ts` | `:60-90`（语言定义 import 与 `MonacoEnvironment`） | Monaco 装配唯一入口；Java 语言定义在此注册 |
| `src/features/editor/MonacoEditor.vue` | `:203-298`（model 生命周期）、`:437-465`（provider 安装）、`:613-619`（workspace watch） | 文档同步与 provider 接入点 |

---

## 验证

### 每阶段命令

```bash
# 通用
cd /Users/yanqi/Desktop/WorkSpace/PrismCode
pnpm exec vue-tsc --noEmit                      # 类型检查（build 里也跑）
node --experimental-strip-types scripts/java-selfcheck.ts
node --experimental-strip-types scripts/language-budget-selfcheck.ts
node --experimental-strip-types scripts/editor-monaco-selfcheck.ts
node --experimental-strip-types scripts/problems-panel-selfcheck.ts
node --experimental-strip-types scripts/workspace-open-performance-selfcheck.ts
pnpm test:monaco-language                       # puppeteer：HTML/CSS provider 抽取后回归
cd src-tauri && cargo test && cargo check
```

- B1：`cargo test --manifest-path src-tauri/Cargo.toml search`；在含 `node_modules` 的大仓库连续搜索 5 次，`pnpm measure:memory` 中主进程 RSS 不上行（对比改动前）。
- B2：`cargo test ... git`；对 >8MiB 的单个文件点「打开对比」应弹出「文件过大，无法在编辑器中打开对比」提示而非卡死。
- C1：打开 7 个 diff 标签 → 保留 6 个；切走再切回内容一致。
- C2：连续两次「查找引用」结果一致；`pnpm measure:memory` 中 Prism 自身合计在查询结束后回落（对比改动前同场景）。
- C4：窗口隐藏 5 分钟，IPC/watcher 事件不再持续刷新（DevTools 观察 `invoke` 频率）；恢复后资源树与 Git 状态一次刷新追平。
- D1/D2：`cargo test`；关闭窗口后 `pgrep -fl org.eclipse.equinox.launcher` 无输出。
- E2：见阶段 E 验收（prepare 脚本产物 + 打包产物资源目录 + `.artifacts/jre/bin/java -version`）。

### Java 端到端（`pnpm tauri:dev`，结合内置运行时）

前置：`node scripts/prepare-jdtls.mjs && node scripts/prepare-jre.mjs`，然后
`PRISMCODE_JAVA_ROOT="$PWD/.artifacts" pnpm tauri:dev`。

1. 打开 `examples/java-fixture/`（本计划新增：无构建文件的 `src/Hello.java` 正确文件 + `src/Broken.java` 故意类型错误 + 一个调用方文件 `src/Caller.java`）：
   - 打开 `Broken.java` 约 20s 内出现红色波浪线与 Problems 面板条目，`source` 为 `Java`；
   - 在 `Caller.java` 里对 `Hello.` 触发补全，候选来自 JDTLS（含方法签名）；
   - F12 跳转到 `Hello` 的声明，`⌘[` 返回；Shift+F12 列出引用；F2 重命名后两个文件同步改（`applyWorkspaceEdit` 生效）；
   - `⌥⇧F` 格式化；代码操作里执行 `Organize Imports` 生效；
   - 对 JDK 内建类型（如 `String`）F12 → 打开 `jdt://` 只读反编译标签，关闭标签不影响磁盘。
2. 运行/测试：右键菜单「运行当前文件」→ 底部终端注入 `"<内置 java>" .../Hello.java` 并打印结果；把 fixture 临时初始化为 Maven/Gradle 工程（需联网解析插件）后「运行测试/构建」注入 `./mvnw -q test` 等命令；忙碌终端会自动新开终端。
3. 进程与内存：`pgrep -fl org.eclipse.equinox.launcher` 显示命令行含 `-Xmx1024m`、`-XX:MaxMetaspaceSize=512m`、`-configuration ~/.prismcode/java/config/<hash>`、`-data ~/.prismcode/java/data/<hash>`；`pnpm measure:memory` 里「Java 语言服务」一行约 0.6–1.2GB；把窗口切到后台并关闭所有 Java 标签，10 分钟后该进程消失（`idleStopMinutes` 生效），重新打开 Java 文件后约 5–20s 回到 ready（`-data` 命中缓存，导入显著快于首次）。
4. 错误路径：删除 `.artifacts/jdtls` 后打开 Java 文件 → 提示 `java.notice.runtimeMissing` 且不遗留进程；把 `java.serverMemoryMb` 设为 8192 → 进程命令行显示 `-Xmx4096m`（clamp 生效）。

### 内存基线协议（PR 里附前后对比）

1. 用安装版或 `pnpm tauri:dev` 打开两个真实项目窗口，各跑一个 dev server。
2. 每个状态跑 `pnpm measure:memory` 并归档：`空闲（无窗口）`、`一个项目 + dev server`、`两个项目 + 两个 dev server`、`两个项目 + Java 项目 ready`。
3. 目标（以「Prism 自身合计」计，不含终端子进程）：单项目窗口 ≤ 320MB（当前实测 idle 单窗口 ≈ 205MB、聚焦并加载 TS worker 时 ≈ 350–440MB）；两窗口 ≤ 700MB；Java 项目额外 ≤ 1.2GB 且空闲 10 分钟后回落为 0。

---

## 假设与回退

1. **JDTLS 1.61.0 需要 Java 21**（官方 README：「requires a runtime environment of Java 21 (at a minimum)」）。内置 jlink 运行时即满足；若实测该版本要求更高（如 25），只改 `third_party/jre/manifest.json` 的版本与 URL（`build_jdtls_args` 不含版本常量，无需改代码）。
2. **jlink 裁剪运行时的模块集合可能不足**（Maven/Gradle 导入或 `java Hello.java` 出现 `NoClassDefFoundError`/模块缺失）：`scripts/prepare-jre.mjs` 增加缺失模块重跑；仍失败则跳过 jlink，直接把解压出的 Temurin JDK 21 目录当作 `.artifacts/jre`（安装包体积上升，代码路径不变）。
3. **`-XX:MaxMetaspaceSize=512m` 在大工程触发 OOM**：把它提为设置项（`java.metaspaceMb`，默认 512）或直接在 `build_jdtls_args` 改为 768m（单点改动 + 单测同步）。
4. **逐帧 emit 在高频场景（大项目导入、批量诊断）造成 UI 卡顿**：在 Rust 读线程合批（≤64KB 或 ≤8ms）后再 emit，`lsp://message/{id}` 的 payload 由 `String` 改成 `Vec<String>`，客户端循环处理（改动限制在 D1 + F2 的两处）。
5. **若实测发现窗口内存瓶颈主要在 Monaco 内核与图标解码**（而非本计划列出的项）：唯一需要改架构的备选是把 `setup.ts` 拆成「注册期 / 实例期」两段，Monaco 改为首次打开文件时动态加载；届时先补阶段 A 的度量数据再评估。
6. **JDTLS 对 Maven 工程的首次导入需要联网**解析插件（公司私服/离线环境可能失败）：属 JDTLS 侧行为，UI 只透出 `language/status` 的 Error 文本与「查看日志」，不代管依赖下载。
