# Prism Code

基于 Tauri + Vue 3 的轻量化跨平台桌面代码编辑器。

**许可证：[MIT](LICENSE)** · 纯开源免费

> **Prism（棱镜）**寓意将代码光谱折射为清晰可读的编辑体验；与 Miro.com（看板产品）无关联。

## 产品定位

主打**轻量级、快速、顺滑**。核心功能集已**定版**，不再扩展大功能模块；后续迭代围绕性能、流畅度、交互体验持续打磨。

**明确不做**：AI 对话面板、AI Agent、MCP / Skills 生态、插件市场。

## 功能概览

- 工作区资源树（**Material Icon Theme** 文件图标）/ 文件右键操作 / 外部变更监听
- CodeMirror 6 多标签编辑：高亮 / 折叠 / 查找替换 / 格式化 / 诊断 / 补全 / 跳转
- 离线代码补全与本地语言智能：JavaScript / TypeScript 类型服务、Vue 单文件组件辅助、HTML / CSS 语言服务
- ⌘P 文件查找、⌘⇧F 全局搜索与替换
- Git 全功能：左侧 Commit、编辑区 Git Log、Branches、交互式 Rebase、冲突分栏解决、HTTPS 登录
- 本地终端（⌘J）与 SSH 远程（状态栏入口，远程终端）
- 四套主题：`prism-dark`（默认）/ `dawn` / `midnight` / `cyberpunk`
- 中 / 英界面语言切换（无需重启）
- 应用内检查更新（GitHub Release）

## 环境要求

| 工具 | 建议版本 |
|---|---|
| Node.js | 20+ |
| pnpm | 9+ |
| Rust | stable |
| 系统 | macOS / Windows / Linux |

系统依赖请按 [Tauri 前置条件](https://v2.tauri.app/start/prerequisites/) 安装。

## 快速开始

```bash
pnpm install
pnpm tauri:dev
```

验收样例工作区：启动后打开 `examples/playground`。

仅前端类型检查与静态构建：

```bash
pnpm build
```

仅 Rust 编译检查：

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

本机发布构建（仅当前系统）：

```bash
pnpm release
```

多平台安装包（无需 Windows/Linux 机器）：打 `v*` 标签或 Actions 手动触发，见 [多平台发布](docs/多平台发布.md)。

### macOS 安装提示「已损坏」

从 Release 安装后若系统提示「Prism Code 已损坏，无法打开」，在终端执行：

```bash
xattr -cr "/Applications/Prism Code.app"
```

然后双击或右键 → **打开** 即可。原因与后续发版说明见 [多平台发布 · macOS 故障排除](docs/多平台发布.md#macos安装后提示已损坏无法打开)。

### Windows 安装提示「已保护你的电脑」

从 Release 下载后若 SmartScreen 拦截，在安装界面点 **更多信息** → **仍要运行** 即可；或在 PowerShell 中解除下载标记：

```powershell
Unblock-File -LiteralPath "$env:USERPROFILE\Downloads\Prism Code_*.msi"
```

说明见 [多平台发布 · Windows SmartScreen](docs/多平台发布.md#windowssmartscreen-提示已保护你的电脑)。要彻底消除提示需配置 Windows 代码签名证书（见同文档维护者侧说明）。

## 文档

| 文档 | 说明 |
|---|---|
| [使用说明](docs/使用说明.md) | 功能与快捷键全览 |
| [技术架构](docs/Prism%20Code技术架构文档.md) | 选型、分层、模块设计 |
| [视觉主题](docs/Prism%20Code视觉与主题规范.md) | 四套主题与语义 token |
| [多平台发布](docs/多平台发布.md) | GitHub Actions 打 macOS / Win / Linux 包 |
| [开源准备清单](docs/开源准备清单.md) | 公开发布勾选表 |
| [官方定名](docs/Prism%20Code（棱镜编辑器）官方定名文档.md) | 品牌与命名 |
| [贡献指南](CONTRIBUTING.md) | 开发环境与 PR 约定 |
| [安全政策](SECURITY.md) | 漏洞报告方式 |
| [更新日志](CHANGELOG.md) | 版本变更 |
| [开源许可](LICENSE) | MIT |
| [第三方声明](THIRD-PARTY-NOTICES.md) | 依赖许可证聚合 |

## 参与贡献

欢迎 Issue 与 PR，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。参与即同意 [行为准则](CODE_OF_CONDUCT.md)。

## 许可证

[MIT](LICENSE) © PrismCode
