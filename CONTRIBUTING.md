# 贡献指南

感谢关注 Prism Code。欢迎 Issue、讨论与 Pull Request。

## 开发环境

| 工具 | 建议版本 |
|---|---|
| Node.js | 20 LTS 及以上 |
| pnpm | 9 及以上 |
| Rust | stable（推荐 1.80+） |
| 系统 | macOS / Windows / Linux（桌面开发） |

额外依赖见 [Tauri 前置条件](https://v2.tauri.app/start/prerequisites/)。

## 本地运行

```bash
git clone https://github.com/yqstart/PrismCode.git
cd PrismCode
pnpm install
pnpm tauri:dev
```

验收样例：启动后打开 `examples/playground`。

仅检查前端类型与打包（无需完整桌面壳）：

```bash
pnpm build
```

仅检查 Rust 侧编译：

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

## 贡献方向

Prism Code 核心功能集已收敛，当前进入**优化迭代期**，主打轻量级、快速、顺滑。

- **欢迎**：Bug 修复、性能与流畅度优化、交互体验打磨、视觉细节完善
- **慎入**：大功能模块新增（请先开 Issue 讨论）
- **不做**：AI 对话面板 / Agent / MCP / 插件市场

优化类 PR 请说明可感知的效果或可量化指标（启动耗时 / 帧率 / 内存 / 操作延迟），「修一个验一个」。

## 分支与提交

1. 从默认分支拉出功能分支（如 `feat/xxx`、`fix/xxx`）
2. 做**最小必要**改动，避免无关重构
3. 提交说明用中文，说明「为什么」而非堆砌文件名
4. 确保 `pnpm build` 通过；涉及 Rust 时再跑 `cargo check`

## Pull Request

- 描述问题与方案；关联相关 Issue
- UI 变更尽量附截图或简短录屏
- 架构级变更（目录结构调整、核心选型）请同步更新 `AGENTS.md` 与 `docs/Prism Code技术架构文档.md`
- 标识符/文件名保持英文；注释与文档用中文

## Issue

- **Bug**：复现步骤、期望行为、实际行为、系统与版本
- **功能建议**：场景、动机、可选方案
- 安全漏洞请勿公开开 Issue，见 [SECURITY.md](SECURITY.md)

## 行为准则

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 多平台发版

维护者发布安装包请看 [docs/多平台发布.md](docs/多平台发布.md)（GitHub Actions，不依赖本机 Windows/Linux）。

## 许可证

贡献代码默认按仓库 [MIT](LICENSE) 许可授权。
