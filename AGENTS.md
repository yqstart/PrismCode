# Prism Code 工程导航

Prism Code（棱镜编辑器）：基于 Tauri + Vue3 的轻量化桌面代码编辑器。

## 产品阶段与方向

- **定位**：轻量级、快速、顺滑的跨平台桌面代码编辑器
- **当前阶段**：功能**定版**（2026-08-10）——核心功能集（资源树 / 编辑 / 搜索 / Git / 终端·SSH / 主题 / 本地语言智能）全部收敛，进入**优化迭代期**
- **后续方向**：围绕性能、流畅度、交互体验持续打磨，不再扩展大功能模块
- **已落地**：离线代码补全、JS/TS 类型服务、Vue SFC script/template 辅助、会话恢复
- **明确不做**：任何 AI/模型联网补全、AI 对话面板、AI Agent、MCP / Skills 生态、插件市场

## 文档索引

| 文档 | 路径 |
|---|---|
| **使用说明（功能与快捷键全览）** | `docs/使用说明.md` |
| 技术架构 | `docs/Prism Code技术架构文档.md` |
| 视觉主题 | `docs/Prism Code视觉与主题规范.md` |
| 官方定名 | `docs/Prism Code（棱镜编辑器）官方定名文档.md` |
| 多平台发布 | `docs/多平台发布.md` |
| 开源准备清单 | `docs/开源准备清单.md` |
| 开源许可 | `LICENSE`（MIT） |
| 第三方声明 | `THIRD-PARTY-NOTICES.md` |
| 贡献指南 | `CONTRIBUTING.md` |
| 安全政策 | `SECURITY.md` |
| 行为准则 | `CODE_OF_CONDUCT.md` |
| 更新日志 | `CHANGELOG.md` |

## 技术基线（摘要）

- 桌面壳：Tauri 2
- 前端：Vue 3 + TypeScript + Vite + Pinia
- 编辑器内核：**Monaco Editor**（VSCode 同源；高亮/折叠/诊断/补全/跳转/查找/差异对比均为内置能力，按需注册 feature 与语言定义，装配入口 `src/features/editor/monaco/setup.ts`）。JS/TS 走 Monaco 的 TypeScript worker（编译器与标准库内嵌、Worker 线程、不联网，跨文件跳转/重命名/引用/诊断由 worker 承担）；HTML/CSS/SCSS/Less 走 `vscode-html/css-languageservice`（VSCode 同源）；Vue 为自研三态 Monarch 高亮 + 等长虚拟 TS 文件承接 script 段语义 + `vueBindings.ts` 注入 template 绑定；键位支持 **WebStorm / VS Code 双预设**。语言服务内存预算集中在 `monaco/languageBudget.ts`：每个窗口同时最多一个 TS/JS worker（失焦 3 秒释放，聚焦按需重建）、最多 2 个常驻 model、额外注入 ≤32 个文件且单个 ≤256KB；worker 生命周期由 `monaco/tsWorkerManager.ts` 顶替 Monaco 默认实现（vite 插件在解析时替换）
- 搜索：Rust walk + 模糊/内容检索/替换（async + LRU 缓存）
- Git：Rust `git2` + 系统 Git（状态/提交/冲突走 `git2`；push/rebase/delete-remote 等远端/兼容性敏感操作按需走系统 Git）
- 主题：`prism-dark` / `dawn` / `midnight` / `cyberpunk`
- 文件图标：Material Icon Theme（资源树 / Commit / 快速打开等）

## 源码结构（当前）

```
src/
  app/                 # AppShell、TitleBar、ActivityBar、SideBar、EditorArea、StatusBar
  features/            # explorer / git / search / editor / settings / sessions / ssh
  stores/              # settings / workspace / ui / editor / git / search / sessions / ssh
  styles/              # tokens、themes、global
  shared/
src-tauri/             # Tauri 后端、Git/搜索命令、PTY 插件、窗口与文件能力
.github/               # CI、Issue / PR 模板
```

Git（`features/git`）对标 **VS Code Source Control + Git Graph**：左侧 Commit（暂存的更改 / 更改分组 + 行内暂存·回滚 + 点选打开编辑区 Diff + Rebase Continue/Abort）；编辑区标签 **Git Log**（真实多车道 SVG 提交拓扑，覆盖全部 refs；分支/标签/贮藏筛选；搜索、自动加载更多、HEAD/贮藏快捷定位、可见列设置；提交正文 / 父提交 / 变更状态详情；Cmd/Ctrl 点击两提交比较、文件 Diff / 当前版本 / 路径复制 / 代码评审勾选；提交右键 Checkout / New Branch / Tag / Copy / Diff / HEAD 对比 / Cherry-pick / Revert / Interactive Rebase / Reset；ref 右键 Checkout / Merge / Rebase / Compare / Rename / Delete / Push Tag）；Branches 弹层（Compare/Upstream/删远程）；冲突分栏（Base/导航）；⌘K 打开 Commit；活动栏 Project / Commit / History，底区 Package / 终端 / 设置。

格式化（`features/editor/formatting`）**开箱即用**：内置 Prettier standalone 引擎（前端动态 import 按需分包，零配置/零依赖/离线，覆盖 JS/TS/JSON/CSS/SCSS/Less/HTML/Vue/Markdown/YAML/GraphQL），三级策略：项目本地 prettier（后端 `format_with_prettier`，`npx --no-install`）优先 → 内置引擎兜底（`prettierRuntime.ts` 扩展名→parser 映射 + `prettierConfig.ts` 读取项目 JSON 形式 .prettierrc）→ 均失败抛中文错误（`UnsupportedLanguageError`「暂不支持格式化该语言」）。入口：⌥⇧F 快捷键 / 编辑区右键 / 文件树右键；「保存时格式化」设置（默认关，`saveActive`/`saveAll` 保存前静默格式化，失败不阻塞保存）；`prettierEnabled` 默认开（原依赖项目安装，现内置引擎兜底后默认开启）。

下拉补全由 Monaco provider 提供候选、编辑器负责触发/过滤/排序：JS/TS 走 TypeScript worker（内置补全、自动导入、签名帮助、hover、诊断、定义/引用/重命名）；HTML/CSS 走 VS Code 同源语言服务（`monaco/htmlCssProvider.ts`）；Vue script 走等长虚拟 TS 文件（`monaco/vueScriptService.ts`，诊断经 marker 映射回 SFC），template 由 HTML 服务 + `vueBindings.ts` 的 `<script setup>` 绑定注入；Emmet 与用户片段另有独立 provider（`monaco/emmetProvider.ts`、`monaco/snippetsProvider.ts`）。会话恢复保存在 `prismcode.editor-session.v2:*`，恢复标签、活动文件、光标、固定状态和受限未保存快照。自测：`pnpm test:editor-monaco`、`pnpm test:monaco-language`、`pnpm test:editor-actions`、`pnpm test:editor-options`。

会话视图：本地终端（`features/sessions`，**底部面板**，入口：状态栏左下角终端按钮 / 活动栏 Package 与设置之间的终端图标 / ⌘J）与 SSH 远程（`features/sessions/SshView.vue` + `stores/ssh.ts`，独立编辑区标签）**已拆分解耦**。
- 本地终端（`TerminalPanel.vue` 底部面板 + `SessionsView.vue`）：面板在 AppShell 中位于 `.center`（EditorArea 下方），**仅占编辑区列**，资源管理器（ActivityBar+SideBar）保持整列全高；随工作区切换重建（cwd = 项目根）；面板高度可拖拽并持久化（`settings.layout.terminalPanelHeight`）；面板收起（⌘J / 顶栏 ▼）时会话与 PTY 保活（v-show 隐藏），仅关闭全部终端 subtab 或切换工作区时销毁；打开面板不打断画布（SSH/GitLog/Compare）聚焦；新建终端挂载即聚焦（无需手动点击）；`tauri-plugin-pty` 0.3.1 使用本地补丁，PTY 阻塞 IO 统一走 `spawn_blocking`，避免常驻终端占满 Tauri 异步运行时
- package.json scripts：活动栏 Package 入口（点击后在本地终端注入 `pnpm/npm/yarn/bun run …`）；Scripts 弹层可逐条**勾选**，勾选的脚本以芯片形式常驻终端顶栏右侧（`shared/pinnedScripts.ts` 按项目持久化勾选集合，`PackageScriptsMenu` compact 变体渲染 `pinnedScripts` 子集）；点击芯片时若活动终端正在运行任务（shell 未停在提示符）则自动**新开终端**执行——忙/闲由 `features/sessions/terminalIdle.ts` 解析 PTY 输出流判定（行尾提示符特征 + 稳定窗口），状态存 `stores/sessions.ts` 的 `localIdle`
- SSH 远程：独立编辑区标签，含主机列表 / 远程终端；关闭 SSH 标签不影响本地终端，反之亦然
- SSH 主机配置：应用级全局（`~/.prismcode/ssh-profiles.json`），与项目/窗口无关；可选「记住密码」写入 `~/.prismcode/ssh-credentials.json`（0600）
- SSH 主机密钥：校验 `~/.ssh/known_hosts` + `~/.prismcode/known_hosts`；未知密钥需用户确认（TOFU）
- SSH 活跃连接：切换项目时强制关闭本窗口全部远程 Shell

## 命名规范

- 对外全称：Prism Code
- 仓库/包名：PrismCode
- 标识符、文件名：英文；界面文案走 `src/i18n`（`zh-CN` / `en-US`）；注释、文档、提交说明：中文
- 品牌说明：与 Miro.com（看板产品）无关联

## 变更约定

架构级变更（目录结构调整、核心技术选型变更）须同步更新本文档与 `docs/Prism Code技术架构文档.md`。

**发版**：每次升版本号发 Release 前，必须同步更新 `CHANGELOG.md`（将 `[Unreleased]` 条目归入新版本节并写明日期）；步骤见 `docs/多平台发布.md`。
