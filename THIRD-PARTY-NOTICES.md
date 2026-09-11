# 第三方开源软件声明

本产品（Prism Code）以 MIT 许可证开源，并包含来自以下开源社区的代码与资源。
完整版权与许可证文本以各上游项目仓库为准。

---

## 前端依赖

### CodeMirror 6（@codemirror/*、codemirror、@lezer/highlight）
- 仓库：https://github.com/codemirror/dev
- 许可证：MIT
- 版权：Marijn Haverbeke 及贡献者

### @codemirror/merge（冲突分栏 MergeView）
- 仓库：https://github.com/codemirror/merge
- 许可证：MIT
- 用途：Git 冲突对比分栏（CompareView）

### Vue
- 仓库：https://github.com/vuejs/core
- 许可证：MIT
- 版权：Evan You 及贡献者

### Pinia
- 仓库：https://github.com/vuejs/pinia
- 许可证：MIT

### Lucide（lucide-vue-next）
- 仓库：https://github.com/lucide-icons/lucide
- 许可证：ISC

### Material Icon Theme（material-icon-theme）
- 仓库：https://github.com/material-extensions/vscode-material-icon-theme
- 用途：资源管理器 / 变更列表等文件与文件夹类型图标
- 许可证：MIT
- 版权：Material Extensions / Philipp Kief 及贡献者

### Marked
- 仓库：https://github.com/markedjs/marked
- 许可证：MIT
- 用途：Markdown 预览

### xterm.js（@xterm/xterm、@xterm/addon-fit）
- 仓库：https://github.com/xtermjs/xterm.js
- 许可证：MIT
- 用途：终端渲染

### Tauri 前端 API / 插件（@tauri-apps/api、plugin-dialog、plugin-fs、plugin-opener、plugin-process、plugin-updater）
- 仓库：https://github.com/tauri-apps/tauri 、https://github.com/tauri-apps/plugins-workspace
- 许可证：MIT OR Apache-2.0

### tauri-pty
- 仓库：https://github.com/Tnze/tauri-plugin-pty
- 许可证：MIT
- 用途：本地终端 PTY 桥

---

## 构建期前端工具（不随运行时分发，仍致谢）

### Vite / @vitejs/plugin-vue
- 许可证：MIT

### TypeScript / vue-tsc
- 许可证：Apache-2.0（TypeScript）/ MIT（vue-tsc）

### @tauri-apps/cli
- 许可证：Apache-2.0 OR MIT

### Puppeteer（E2E 自检脚本）
- 仓库：https://github.com/puppeteer/puppeteer
- 许可证：Apache-2.0
- 用途：`pnpm e2e:ipc` 前端 IPC 并发自检

---

## 后端 / 原生依赖

### Tauri / tauri-build / tauri-plugin-*
- 仓库：https://github.com/tauri-apps/tauri
- 许可证：MIT OR Apache-2.0
- 包含：tauri-plugin-opener / dialog / fs / process / updater / pty

### git2（git2-rs）
- 仓库：https://github.com/rust-lang/git2-rs
- 许可证：MIT OR Apache-2.0

### libgit2（经 libgit2-sys vendored）
- 仓库：https://github.com/libgit2/libgit2
- 许可证：GPL-2.0 **with linking exception**
- 说明：linking exception 允许将编译后的 libgit2 链接进其他程序并分发该组合，
  不强制宿主程序采用 GPL。本产品保留其版权与许可证声明。

### ssh2 / libssh2-sys
- 仓库：https://github.com/alexcrichton/ssh2-rs
- 许可证：MIT OR Apache-2.0
- 用途：SSH 远程终端（vendored OpenSSL）

### reqwest / tokio / futures-util
- 仓库：https://github.com/seanmonstar/reqwest 、https://github.com/tokio-rs/tokio
- 许可证：MIT OR Apache-2.0
- 用途：AI 流式补全请求（SSE）与异步运行时

### objc2 / objc2-app-kit / objc2-foundation（仅 macOS）
- 仓库：https://github.com/madsmtm/objc2
- 许可证：MIT OR Apache-2.0
- 用途：macOS 标题栏红绿灯窗口控制

### walkdir / ignore / regex / chrono / serde / serde_json / base64
- 许可证：MIT 和/或 Apache-2.0 / Unlicense（以各 crate 为准）

### 传递依赖中的 MPL-2.0 组件（如 cssparser、selectors 等）
- 许可证：MPL-2.0（弱 copyleft）
- 说明：本产品未修改其源文件；若未来修改，须按 MPL-2.0 公开对应文件改动。

---

发版前可用以下命令刷新依赖清单：

```bash
pnpm dlx license-checker --production --csv
cd src-tauri && cargo metadata --format-version 1
```
