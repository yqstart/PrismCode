# 更新日志

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，版本号遵循语义化版本。

## [Unreleased]

## [3.1.0] - 2026-09-14

### 新增

- 资源树复制 / 剪切 / 粘贴支持 `⌘/Ctrl+C/X/V` 快捷键；从 Finder / 文件资源管理器复制的文件可在树中直接粘贴（重名自动 `-copyN` 避让），落点跟随当前选中（目录进其内部，文件进其父目录）。

### 改进

- 资源树文件拖拽支持边缘自动滚动（指针贴近顶部 / 底部时滚动树）与悬停折叠目录自动展开，视口外的目录可直接拖放到达。
- 四套主题重调：次 / 辅助文案对比度加深，三深色按底色相区分（dark 中性灰、midnight 海军蓝、cyberpunk 紫黑）；终端配色与编辑器高亮同步，Git Log 拓扑与徽标改走主题变量。
- 编辑器 Git 改动与诊断 gutter 按需收起：无内容时整列 0 宽，有标记时展开，窄窗口不再留空白。

## [3.0.0] - 2026-09-11

### 变更

- **品牌更名**：Miro Code（米罗编辑器）→ **Prism Code（棱镜编辑器）**；包名、Bundle ID、CLI（`prismcode`）、用户目录（`~/.prismcode`）、主题 ID（`prism-dark`）、GitHub 仓库（`yqstart/PrismCode`）等全域同步；旧 localStorage / `~/.mirocode` 数据自动迁移。

## [2.2.1] - 2026-09-04

### 改进

- 声明导航提示仅用于提示可导航目标，普通鼠标点击只移动光标；统一使用 `⌘B / ⌘Enter / F12` 触发跳转，避免误触发。
- Git blame 信息卡片改为点击行号或 blame gutter 显示，支持 `Esc` 关闭，不再在代码区悬停时自动弹出，减少编辑遮挡。
- 全局搜索使用键盘切换结果时，自动将当前结果滚动到可视区域。

## [2.2.0] - 2026-09-02

### 新增

- 资源树支持多选：`⌘/Ctrl` 点选增删、`Shift` 点选连续范围、右键保留多选集合，可批量删除（`Delete`/`⌫` 快捷键，目录与其子项同时选中时只删除最上层）；剪切粘贴与拖拽统一走移动后处理并按设置更新相对 import。
- Git blame 悬浮卡片重绘：提交人首字母头像、作者/提交号/时间分隔展示与主题化样式，与行内 gutter 状态分离。

### 改进

- 主编辑器 gutter 按内容收缩，行号与折叠区在窄窗口下不再留大块空白。

### 修复

- 修复执行文件内查找 / 全局搜索后，单击编辑区移动光标会莫名选中一段代码的问题：WebKit 26（macOS 26 WKWebView）在编辑器失焦后单击聚焦时会在点击点与旧光标之间自动生成原生选区，且 CodeMirror 针对该缺陷的内建修复仅对 UA 含 `Version/26` 的 Safari 生效；现于失焦单击聚焦场景追加应用侧兜底，点击结束后仍残留的单一选区折叠到点击落点（双击选词、拖选与组合键单击不受影响）。

## [2.1.0] - 2026-09-01

### 新增

- 编辑器支持对本地 import、函数 / class / 变量、Vue 模板组件和 HTML/Vue class 引用提供可点击导航；可用 `⌘/Ctrl+单击`，并保留 `⌘B / F12` 入口。
- Vue 模板组件导航支持 PascalCase、kebab-case 和 `defineAsyncComponent`；CSS class 可跳转到同文件或外部 CSS / SCSS / Sass / Less 选择器。
- 跳转后短暂突出目标文本、目标行和行号，便于确认异步导航落点。
- 设置中增加系统等宽、JetBrains Mono、更纱等宽黑体 SC、Cascadia Code 字体预设，未安装时自动回退。

### 改进

- 优化 import / 路径解析与符号索引，支持多选择器 class 定位和匿名 `default` 导出跳转。
- 增强编辑器焦点行与光标反馈，Git 比较编辑区同步使用可配置的编辑器字体。

### 修复

- 修复 CSS 选择器列表只索引第一个 class、动态 class 无法导航以及外部样式文件无法解析的问题。

## [2.0.0] - 2026-08-31

### 新增

- 增加 `prismcode` CLI，支持文件/目录打开、`path:line:column` 定位、`--goto`、版本和帮助查询；重复调用通过单实例桥接转发到已运行窗口。
- 增加 macOS Launch Services 文件打开事件处理、冷启动请求队列和代码文件关联，外部工具或 Finder 传入的路径可直接进入 Prism Code。

### 改进

- 文件导航对齐 WebStorm：增加 `⌘/Ctrl+E` 最近文件、平台原生 Go to File 键位、CamelHump / 路径模糊搜索、`:行:列` 定位，以及可持续后退 / 前进的双向跳转历史。
- 声明跳转支持 TypeScript 语义和 `@/*` 路径别名；本地命名 import 使用轻量直达路径即时落到真实导出声明，路径字符串仍可打开模块文件。
- `⌘⌥L / Ctrl+Alt+L` 按选区状态执行重排代码；内置 Prettier 兜底会从当前文件向项目根查找最近配置。
- Git Log 与本地更改职责拆分：默认选中 HEAD / 最新提交，固定展示提交详情，支持父 / 子提交键盘导航；未提交更改统一进入 Commit 面板。

### 修复

- 修复跳转后退会把当前项重新压栈、只能在两个位置间反复切换的问题，并防止新跳转沿用已失效的前进分支。
- 修复命名 import 被误判为路径、TypeScript 展开 / 属性访问被误索引成 CSS class，以及 Git Log 在终端或输入框聚焦时劫持方向键的问题。
- 修复编辑器聚焦时 `⌘/Ctrl+W`、标签切换和资源树刷新被输入控件保护逻辑一并拦截的问题。
- 修复最近文件仍显示已删除路径，以及 Git Log 过滤后高亮落到不可见提交的问题。
- 修复点击终端快捷脚本时新建终端过早注入命令，导致命令重复回显的问题。

## [1.0.2] - 2026-08-27

### 修复

- 修复工作区快速切换、切回原项目以及多窗口并行操作时，旧项目的 Git、搜索、编辑器、资源树、比较视图和文件定位结果回写当前项目的问题。
- 修复 Git 状态缓存未及时失效、未推送提交缓存数量不匹配，以及 Git 写操作后界面短暂显示旧状态的问题。
- 修复全部暂存、逐文件暂存和删除文件暂存的竞态，统一串行处理暂存请求，避免文件遗漏在“更改”分组中。
- 修复已暂存空文件在 Diff 中被误判为不存在、工作区外路径可参与 Git 操作，以及 Git 参数可能被当作命令选项解析的问题。
- 修复交互式 Rebase 的 Continue、Skip、Abort 错误处理；正确保留 pick、reword、fix、squash 语义及提交拓扑，避免失败后错误推进或丢失恢复状态。
- 修复文件系统命令使用相对路径时误读写应用当前目录的问题，并阻止重命名/删除工作区根目录。
- 修复目录复制到自身、子目录或符号链接别名目录时可能递归复制的问题。
- 修复跨文件符号重命名在用户编辑、外部修改、打开标签或切换工作区期间覆盖新内容的问题，并准确统计实际完成的替换数量。
- 修复符号索引在文件失效后仍写回旧解析结果的问题。
- 修复 Quick Open、文件搜索和内容替换在快速输入、清空或连续请求时显示过期结果的问题。
- 修复终端进程退出回调和连续执行固定脚本时的异步竞态，避免组件销毁后更新状态或写入旧命令。
- 修复补全文档渲染绕过 Markdown 安全过滤的问题。

### 稳定性与安全

- 为文件读写、复制、重命名、删除、Git Diff、Blame、冲突比较和批量替换统一增加工作区边界校验及符号链接检查。
- 为 Git 远端、分支、标签、提交和 Rebase 参数增加非法字符与选项注入防护。
- 增加文件系统路径、Git 状态缓存、搜索取消、目录复制、空索引 Blob 及交互式 Rebase 的回归测试。
- 优化异步请求的代际隔离和失败提示，减少长时间操作期间的 UI 卡顿与错误提示串线。

## [1.0.1] - 2026-08-26

### 修复

- 修复 macOS 红绿灯首次点击红色关闭按钮时只清理终端或文件、窗口无法关闭或需要二次点击的问题。
- 关闭窗口时先执行 `closeSessions` 并保存状态，再由 AppKit 主线程关闭当前窗口；关闭过程中的重复点击不会重复触发清理。

## [1.0.0] - 2026-08-26

### 首个可用大版本

Prism Code 1.0.0 是当前代码基线的首个可用大版本，定位为轻量、快速、顺滑、跨平台、离线优先的桌面代码编辑器。核心工作流已经定版，后续迭代将围绕性能、流畅度和交互体验持续优化。

### 工作区与项目管理

- 工作区资源树支持文件夹打开、目录展开/折叠、刷新、过滤、快速定位当前文件、外部变更监听和 Git 状态标记。
- 支持新建文件/文件夹、重命名、删除、复制、剪切、粘贴、复制绝对/相对路径、格式化文档，以及拖拽移动文件。
- 使用 Material Icon Theme 文件图标，按文件名、扩展名和常见目录名显示对应图标。
- 支持项目最近记录；从项目菜单或 macOS Dock 最近项目打开时可创建独立窗口，不覆盖当前工作区。
- 多窗口工作区、编辑器标签、终端标签、活动文件、光标、固定标签和符合条件的未保存快照按窗口/工作区隔离并恢复。

### 编辑器

- 基于 CodeMirror 6 提供多标签代码编辑、高亮、折叠、查找替换、多光标、行操作、注释、诊断和历史撤销。
- 覆盖 JavaScript、TypeScript、JSX、TSX、Vue、HTML、CSS、SCSS、Sass、Less、JSON、Markdown、YAML、XML、SVG 和 Env 等常用文件类型。
- JavaScript / TypeScript 使用浏览器内嵌 TypeScript LanguageService，支持类型成员补全、自动导入、签名帮助、Hover、诊断、定义、引用和符号重命名。
- Vue 单文件组件使用等长虚拟 TypeScript 文件辅助 `script`，为模板注入 `<script setup>` 顶层绑定；HTML / CSS 使用同源语言服务。
- 语言服务不可用时自动降级到关键词、代码片段、文档词和符号索引，保持基础编辑能力可用。
- 支持全文格式化与单一连续选区格式化；内置 Prettier 离线引擎，项目已安装 Prettier 时优先使用项目版本和配置。
- 支持 Markdown 预览/源码切换和图片/SVG 预览；Markdown、Git Log 描述和详情文本可选中复制。
- 支持自动保存、保存时格式化开关、外部修改冲突提示，以及按工作区恢复打开文件、活动标签、光标和受限未保存内容。

### 搜索与导航

- `⌘/Ctrl+P` Quick Open 支持按文件名模糊查找、打开和最近搜索历史。
- `⌘/Ctrl+Shift+F` 在文件中查找，支持大小写、正则、文件掩码、结果定位、替换预览和确认后全部替换。
- 支持相对路径和 `@/` 别名跳转、定义、Hover、引用面板、跨文件重命名、诊断导航和返回上一跳转位置。

### Git

- Commit 面板提供“暂存的更改/更改”分组，支持全部暂存、单文件暂存、取消暂存、回滚和提交。
- 暂存链路覆盖修改、新增、删除和部分暂存文件；暂存操作通过前端队列和后端 Git 索引锁串行化，避免快速点击、多窗口或状态刷新竞态造成遗漏。
- 支持行内暂存、取消暂存和回滚，文件 Diff、当前版本打开、路径复制、代码评审勾选，以及 Commit / Commit and Push / Amend。
- Git Log 使用真实多车道 SVG 拓扑展示本地分支、远程分支、标签和贮藏，支持筛选、搜索、分页加载、列设置、HEAD/贮藏定位和两提交比较。
- 提交、分支和标签上下文菜单支持 Checkout、New Branch、Create Tag、Diff、Compare、Cherry-pick、Revert、Reset、Merge、Rebase、Rename、Delete 和 Push Tag。
- 支持 Branches 管理、Upstream 设置、Fetch、Pull、Push、Update Project、Stash Apply/Pop/Drop，以及交互式 Rebase 的 pick、reword、squash、fix、drop 和冲突 Continue/Skip/Abort。
- 支持冲突文件列表、Base/本地/远程分栏比较、冲突导航、批量接受一侧、手动编辑保存和状态栏冲突定位。
- HTTPS 认证提供账号密码对话框和可选凭据保存；远程操作支持必要的确认和错误提示。

### 终端与 SSH

- 本地终端以编辑区底部面板运行，支持多终端标签、自动聚焦、可拖拽高度、收起保活和 PTY 生命周期清理。
- 终端标签按 shell 命名（zsh、bash、PowerShell），同一 shell 自动编号；终端输出有界缓冲，避免高频输出阻塞界面。
- Package 入口读取 `package.json` scripts，支持勾选固定脚本、按项目记忆、自动选择 pnpm/npm/yarn/bun；当前终端忙碌时自动新开终端执行。
- 支持 SSH 主机列表、远程终端、主机密钥 TOFU 确认、`known_hosts` 校验、可选密码保存和远程 Shell 关闭；切换工作区时强制清理远程连接。

### 主题、语言与窗口体验

- 提供 `prism-dark`、`dawn`、`midnight`、`cyberpunk` 四套主题，编辑区语法高亮与界面语义色同步切换。
- 支持中文/English 界面即时切换，活动栏、资源树、Git、搜索、终端、对话框和 macOS 原生菜单同步更新，无需重启。
- macOS Overlay 标题栏支持原生红绿灯、首次点击响应、主题底色同步、窗口缩放/全屏布局同步和项目路径复制。
- 修复窗口失焦、长时间空闲和 WebView 动画事件丢失导致的侧栏消失、编辑区黑屏、标签切换异常等问题；关闭窗口时先清理终端，再自动完成窗口关闭，不需要二次点击。
- 设置支持自动保存、保存时格式化、ESLint、Prettier、移动文件时更新 import、字号、主题、语言和布局选项。

### 更新、安全与发布

- 基于 Tauri 2 + Vue 3 + TypeScript + Vite + Pinia，支持 macOS、Windows 和 Linux。
- 应用内通过 GitHub Release 检查更新、校验 updater 签名、下载并重启安装；GitHub Actions 自动构建 macOS Apple Silicon/Intel、Windows x64 和 Linux x64 安装包。
- macOS 使用 ad-hoc 签名，Windows 提供可选 Authenticode 签名配置；安装限制和故障排除见多平台发布文档。
- 文件访问、Git、搜索、SSH 和更新说明渲染均加入路径校验、错误处理、超时清理、敏感信息隔离和 Markdown 链接过滤。
- 采用 MIT 许可证，纯开源免费；本版本坚持离线优先，不包含联网 AI 补全、AI 对话面板、AI Agent、MCP/Skills 生态或插件市场。

[3.1.0]: https://github.com/yqstart/PrismCode/releases/tag/v3.1.0
[3.0.0]: https://github.com/yqstart/PrismCode/releases/tag/v3.0.0
[2.2.1]: https://github.com/yqstart/PrismCode/releases/tag/v2.2.1
[2.2.0]: https://github.com/yqstart/PrismCode/releases/tag/v2.2.0
[2.1.0]: https://github.com/yqstart/PrismCode/releases/tag/v2.1.0
[2.0.0]: https://github.com/yqstart/PrismCode/releases/tag/v2.0.0
[1.0.2]: https://github.com/yqstart/PrismCode/releases/tag/v1.0.2
[1.0.1]: https://github.com/yqstart/PrismCode/releases/tag/v1.0.1
[1.0.0]: https://github.com/yqstart/PrismCode/releases/tag/v1.0.0
