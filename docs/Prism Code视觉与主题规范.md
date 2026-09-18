# Prism Code 视觉与主题规范

> 本文档描述**已定版**的四套主题、语义 token 与视觉规范，色值与 `src/styles/themes.css`、`src/features/editor/theme.ts` 一一对应。
>
> 2026-08-11 重做：设计语言基线改为 **Mac 原生风**（Arc / Linear / macOS Sonoma+ Big Sur 后 modernUI 路线）：
> - 圆角上调：8/10/12/16 → **10/12/14/18**
> - 背景层级明度差拉到 +12/+13 阶
> - 边线改极淡半透明（深色 5% / 浅色 8%）+ 0.5px ring 表达
> - 阴影 3 级 + ring，柔和浮起
> - 输入/开关控件用 box-shadow ring 表达边线（聚焦不跳）

---

## 1. 设计关键词

| 关键词 | 落地 |
|---|---|
| 极简扁平 | 少阴影层级、无厚重拟物 |
| 低饱和底 + 清晰强调色 | 背景偏灰黑 / 雾白，强调色只用于选中与主操作 |
| 克制圆角 | 设置弹层 14px；卡片 10px；控件 6px |
| 通透分区 | 侧栏 / 内容卡 / 编辑区层级分明，留白充足 |
| 轻反馈 | hover / active 用透明度或浅底色，动画 ≤ 200ms |

---

## 2. 主题清单（四套全部可用）

| Theme ID | 显示名 | 角色 | 强调色 |
|---|---|---|---|
| `prism-dark` | Prism Dark | 中性石墨深色 | 紫 `#a78bfa` |
| `dawn` | Prism Light | **浅色** | 蓝 `#4f6fe8` |
| `midnight` | Prism Midnight | 海军蓝深色 | 矢车菊蓝 `#5ea1ff` |
| `cyberpunk` | Prism Cyberpunk | 紫黑底霓虹深色（应用默认） | 霓虹青 `#5eead4` |

切换方式：设置 → 编辑器 → 外观主题（四宫格卡片）；状态栏主题名弹出菜单；状态栏主题名**右键**循环切换。UI 与编辑器高亮同源切换。

---

## 3. 语义色 Token（定版值）

组件与样式**只使用语义变量**（`styles/tokens.css` 声明，`themes.css` 按主题覆盖），禁止散落魔法色值。

### 3.1 Prism Dark（`prism-dark`，默认）

| Token | 值 | 用途 |
|---|---|---|
| `--bg-app` | `#141519` | 应用底（最深） |
| `--bg-header` | `#1b1d22` | 标题栏 / 活动栏 |
| `--bg-panel` | `#1f2026` | 侧栏 / 面板 |
| `--bg-elevated` | `#26272e` | 卡片 / 浮起容器 |
| `--bg-editor` | `#141519` | CodeMirror 区 |
| `--bg-terminal` | `#0e0f13` | xterm 区 |
| `--bg-inset` | `#101116` | 输入 / 内嵌控件底 |
| `--bg-hover` / `--bg-active` | `rgba(255,255,255,.06)` / `rgba(167,139,250,.14)` | 悬停 / 激活底 |
| `--bg-overlay` | `rgba(7,8,12,.72)` | 弹层遮罩 |
| `--border-subtle` | `rgba(255,255,255,.08)` | 细半透明白边 |
| `--text-primary` | `#f4f4f5` | 主文案 |
| `--text-secondary` | `#c3c7d1` | 次文案 |
| `--text-muted` | `#a2a7b4` | 辅助文案（面板底对比度 ≥ 4.5） |
| `--accent` | `#a78bfa` | 主强调（紫） |
| `--accent-soft` | `rgba(167,139,250,.15)` | 选中行 / 轻提示底 |
| `--accent-fg` | `#17131f` | 强调色上的字 |
| `--success` / `--warning` / `--danger` | `#4ade80` / `#f6c453` / `#f87171` | 状态色 |
| `--focus-ring` | `rgba(167,139,250,.55)` | 焦点 |
| `--shadow-card` | `0 1px 2px rgba(0,0,0,.24), 0 0 0 1px rgba(255,255,255,.025)` | 轻浮起 |
| `--shadow-popover` | `0 16px 36px rgba(0,0,0,.42), 0 3px 10px rgba(0,0,0,.24)` | 弹层 / 右键菜单 |
| `--shadow-modal` | `0 28px 72px rgba(0,0,0,.58), 0 8px 24px rgba(0,0,0,.28)` | 弹层更强 |

### 3.2 Prism Light（`dawn`，浅色 / 雾白）

| Token | 值 | 用途 |
|---|---|---|
| `--bg-app` | `#eef0f4` | 应用底（雾白） |
| `--bg-header` | `#e2e6ec` | 标题栏 / 活动栏 |
| `--bg-panel` | `#f7f8fa` | 侧栏 / 面板 |
| `--bg-elevated` | `#ffffff` | 卡片 |
| `--bg-editor` | `#ffffff` | 编辑区 |
| `--bg-terminal` | `#e9edf2` | 终端底 |
| `--bg-inset` | `#f1f3f6` | 输入 / 内嵌控件底 |
| `--bg-hover` / `--bg-active` | `rgba(15,23,42,.05)` / `rgba(79,111,232,.12)` | 悬停 / 激活底 |
| `--bg-overlay` | `rgba(15,23,42,.42)` | 遮罩 |
| `--border-subtle` | `rgba(15,23,42,.1)` | 细半透明黑边 |
| `--text-primary` | `#1c2029` | 主文案 |
| `--text-secondary` | `#475062` | 次文案 |
| `--text-muted` | `#5b6472` | 辅助文案（白底对比度 ≥ 4.5） |
| `--accent` | `#4f6fe8` | 主强调（蓝） |
| `--accent-soft` | `rgba(79,111,232,.12)` | 选中底 |
| `--accent-fg` | `#ffffff` | 强调色上的字 |
| `--success` | `#047857` | 成功（白底可读加深） |
| `--warning` | `#b45309` | 警告（白底可读加深） |
| `--danger` | `#dc2626` | 错误 |
| `--focus-ring` | `rgba(79,111,232,.42)` | 焦点 |
| `--shadow-card` | `0 1px 2px rgba(15,23,42,.04), 0 0 0 1px rgba(15,23,42,.035)` | 浅色卡片浮起 |
| `--shadow-popover` | `0 14px 32px rgba(15,23,42,.14), 0 3px 8px rgba(15,23,42,.06)` | 弹层 |
| `--shadow-modal` | `0 26px 64px rgba(15,23,42,.2), 0 8px 20px rgba(15,23,42,.08)` | 弹层更强 |

### 3.3 Prism Midnight（`midnight`，深蓝深色）

| Token | 值 | 用途 |
|---|---|---|
| `--bg-app` | `#0b1322` | 应用底 |
| `--bg-header` | `#111b30` | 标题栏 / 活动栏 |
| `--bg-panel` | `#182a44` | 侧栏 / 面板 |
| `--bg-elevated` | `#24344f` | 卡片 |
| `--bg-editor` | `#0b1322` | 编辑区 |
| `--bg-terminal` | `#080e1b` | 终端底 |
| `--bg-inset` | `#0a1120` | 输入 / 内嵌控件底 |
| `--bg-hover` / `--bg-active` | `rgba(255,255,255,.06)` / `rgba(94,161,255,.14)` | 悬停 / 激活底 |
| `--bg-overlay` | `rgba(5,10,20,.74)` | 遮罩 |
| `--border-subtle` | `rgba(148,184,255,.12)` | 淡蓝半透明边（区分 cyberpunk 紫边） |
| `--text-primary` | `#eef4fc` | 主文案 |
| `--text-secondary` | `#bccadf` | 次文案 |
| `--text-muted` | `#96a3ba` | 辅助文案（面板底对比度 ≥ 4.5） |
| `--accent` | `#5ea1ff` | 主强调（矢车菊蓝） |
| `--accent-soft` | `rgba(94,161,255,.16)` | 选中底 |
| `--accent-fg` | `#0a1424` | 强调色上的字 |
| `--success` / `--warning` / `--danger` | `#34d399` / `#fbbf24` / `#f87171` | 状态色 |
| `--focus-ring` | `rgba(94,161,255,.5)` | 焦点 |
| `--shadow-card` | `0 1px 2px rgba(0,0,0,.3), 0 0 0 1px rgba(255,255,255,.025)` | 轻浮起 |
| `--shadow-popover` | `0 16px 36px rgba(0,0,0,.48), 0 3px 10px rgba(0,0,0,.28)` | 弹层 |
| `--shadow-modal` | `0 28px 72px rgba(0,0,0,.62), 0 8px 24px rgba(0,0,0,.34)` | 弹层更强 |

### 3.4 Prism Cyberpunk（`cyberpunk`，高对比霓虹）

| Token | 值 | 用途 |
|---|---|---|
| `--bg-app` | `#0e0c16` | 应用底 |
| `--bg-header` | `#171425` | 标题栏 / 活动栏 |
| `--bg-panel` | `#221d33` | 侧栏 / 面板 |
| `--bg-elevated` | `#2c2640` | 卡片 |
| `--bg-editor` | `#0e0c16` | 编辑区 |
| `--bg-terminal` | `#090811` | 终端底 |
| `--bg-inset` | `#100e1a` | 输入 / 内嵌控件底 |
| `--bg-hover` / `--bg-active` | `rgba(255,255,255,.065)` / `rgba(94,234,212,.13)` | 悬停 / 激活底 |
| `--bg-overlay` | `rgba(7,8,14,.76)` | 遮罩 |
| `--border-subtle` | `rgba(196,181,253,.13)` | 淡紫半透明边（区分 midnight 蓝边） |
| `--text-primary` | `#f6f3fc` | 主文案 |
| `--text-secondary` | `#c6c0d8` | 次文案 |
| `--text-muted` | `#a09cb4` | 辅助文案（面板底对比度 ≥ 4.5） |
| `--accent` | `#5eead4` | 主强调（霓虹青） |
| `--accent-soft` | `rgba(94,234,212,.15)` | 选中底 |
| `--accent-fg` | `#06231e` | 强调色上的字 |
| `--success` / `--warning` / `--danger` | `#34d399` / `#fbbf24` / `#fb7185` | 状态色 |
| `--focus-ring` | `rgba(94,234,212,.52)` | 焦点 |
| `--shadow-card` | `0 1px 2px rgba(0,0,0,.34), 0 0 0 1px rgba(255,255,255,.028)` | 轻浮起 |
| `--shadow-popover` | `0 16px 36px rgba(0,0,0,.54), 0 3px 10px rgba(0,0,0,.3)` | 弹层 |
| `--shadow-modal` | `0 28px 72px rgba(0,0,0,.68), 0 8px 24px rgba(0,0,0,.38)` | 弹层更强 |

> 色值如有微调，需同步更新 `themes.css` 与本文档。

---

## 4. 编辑器主题（`features/editor/theme.ts`）

每套主题含独立 `HighlightStyle` 与 `EditorView.theme`，切换 UI 主题时编辑区同步重建，**禁止 UI 已 Dawn 而代码区仍 Dark**。

### 4.1 编辑器 Palette 要点

| 主题 | 背景 | 前景 | 选区 | 选区匹配 | 光标 |
|---|---|---|---|---|---|
| prism-dark | `#141519` | `#f4f4f5` | `rgba(167,139,250,.55)` | `rgba(167,139,250,.18)` | `#a78bfa` |
| dawn | `#ffffff` | `#1c2029` | `rgba(79,111,232,.28)` | `rgba(79,111,232,.11)` | `#4f6fe8` |
| midnight | `#0b1322` | `#eef4fc` | `rgba(94,161,255,.38)` | `rgba(94,161,255,.14)` | `#5ea1ff` |
| cyberpunk | `#0e0c16` | `#f6f3fc` | `rgba(94,234,212,.38)` | `rgba(94,234,212,.14)` | `#5eead4` |

> 选区（selection）对比度**必须**高于选区匹配（selectionMatch）与搜索结果，避免「选中反而更暗」（雷区）。

### 4.2 语法高亮角色色（Prism Dark 为基准，同源扩展）

| 语法角色 | 深色（prism-dark） | 浅色（dawn） |
|---|---|---|
| keyword | 淡紫 `#c792ea` | 深蓝 `#1d4ed8` |
| string | 暖绿 `#c3e88d` | 深绿 `#047857` |
| comment | 灰 `#8b93a1`（斜体） | 灰 `#5b6472`（斜体） |
| function | 蓝 `#a5b4fc` | 靛紫 `#6d28d9` |
| number / bool | 琥珀 `#f78c6c` | 深琥珀 `#c2410c` |
| property / tag | 黄 `#ffcb6b` / 红 `#f07178` | 青 `#0e7490` / 蓝 `#1d4ed8` |
| variableName | 近白 `#ffffff` | 深灰 `#1c2029` |
| punctuation / operator | 青 `#89ddff` | 灰 `#6b7280` / `#374151` |
| invalid | 红 `#ff5370` | 红 `#dc2626` |

Midnight / Cyberpunk 各自维护完整 `HighlightStyle`（矢车菊蓝 / 霓虹青系），见 `theme.ts`。

---

## 5. 字体与字号

基础字体栈（`tokens.css` `--font-ui / --font-mono`）；编辑器代码区另有可持久化的字体预设：

| 用途 | 建议 |
|---|---|
| UI 字体 | `ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Segoe UI", sans-serif` |
| 代码字体 | `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "PingFang SC", monospace` |
| 编辑器字体预设 | 系统等宽 / JetBrains Mono / 更纱等宽黑体 SC / Cascadia Code；未安装时自动回退 |

字号 / 行高 token（`tokens.css`）—— 替代散落硬编码，组件内可逐步替换：

| Token | 值 | 用途 |
|---|---|---|
| `--font-size-xs` | `11px` | 状态栏 / 极次要 |
| `--font-size-sm` | `12px` | 辅助说明 / tab / statusBar |
| `--font-size-md` | `13px` | body / 控件正文（默认） |
| `--font-size-lg` | `15px` | 分区标题 / dialog 副标题 |
| `--font-size-xl` | `20px` | 设置页 h1 / 大型 dialog 标题 |
| `--line-height-tight` | `1.4` | 紧凑：按钮 / tab |
| `--line-height-normal` | `1.55` | UI 正文（默认） |
| `--line-height-relaxed` | `1.7` | 段落 / Markdown 预览 |

| 场景 | 推荐字号 | 来源 |
|---|---|---|
| 设置页标题 | 20–22 / Semibold | `--font-size-xl` |
| 分区标题 | 14–15 / Medium | `--font-size-lg` |
| 正文 / 控件 | 13 | `--font-size-md` |
| 辅助说明 | 12 / secondary | `--font-size-sm` |
| 编辑器默认字体 | 系统等宽（可配置，`fontFamily`） | 由用户设置 |
| 编辑器默认字号 | 13（可配置，`fontSize`） | 由用户设置 |

---

## 6. 圆角、间距、阴影

### 6.1 圆角 token（`tokens.css`，跨主题不变）

| Token | 值 | 用途 |
|---|---|---|
| `--radius-sm` | `6px` | 控件 / 小按钮 / 输入框 |
| `--radius-md` | `8px` | 行内标签 / 小卡片 |
| `--radius-lg` | `10px` | 卡片 / 弹层 |
| `--radius-xl` | `14px` | 设置弹层 / 大型 dialog |

### 6.2 阴影 token（4 级 + 主题覆盖）

| Token | 默认值 | 用途 |
|---|---|---|
| `--shadow-card` | `0 1px 2px rgba(0,0,0,.04), 0 1px 3px rgba(0,0,0,.06)` | 卡片浮起（浅色默认） |
| `--shadow-popover` | `0 4px 16px rgba(0,0,0,.12), 0 1px 2px rgba(0,0,0,.04)` | 弹层 / 右键菜单 |
| `--shadow-modal` | `0 24px 64px rgba(0,0,0,.32), 0 4px 12px rgba(0,0,0,.12)` | 弹层更强 |

> 深色 3 套主题（`prism-dark / midnight / cyberpunk`）的对应阴影值在 `themes.css` 内**单独覆盖**为更深 / 更不透明度更高的版本；浅色 `dawn` 用 tokens.css 默认值。

### 6.3 元素规范

| 元素 | 规范 |
|---|---|
| 设置弹层 | radius `16px` (`--radius-xl`)；`--shadow-modal` |
| 内容卡片 | radius `12px` (`--radius-lg`)；1px `--border-subtle`（半透明）；`--shadow-card` |
| 输入 / 下拉 | radius `6px` (`--radius-sm`)；高度 32px |
| 侧栏菜单项 | radius `6px` (`--radius-sm`)；激活用 `--bg-active` |
| 主题缩略图 | radius `8px` (`--radius-md`)；选中 `--accent` 描边 + 角标勾选 |
| 间距节奏 | 4 / 8 / 12 / 16 / 20 / 24（`--space-1..6`）；卡片内边距 16–20 |
| 边线 | 1px `var(--border-subtle)`（半透明，深色 8% 白 / 浅色 10% 黑） |

**设计原则**（2026-08-20 重制）：
- 深色主题通过「中性底色 + 拉开层级明度差 + 半透明边色」表达分区，几乎不依赖投影
- 浅色主题（dawn）靠柔和阴影 + 半透明黑边共同表达浮起
- 强调色（accent）只用于选中与主操作，避免与状态色 / 焦点环竞争视觉

---

## 7. 关键组件样式

### 7.1 设置弹层信息架构（左导航 4 区）

- **编辑器**：外观主题（四宫格）/ 布局（字体、字号、Tab 2/4、自动换行、行号）/ 文件保存（自动保存开关 + 延迟）/ Tooling（Prettier、移动文件时更新 import）/ 语言（中文 / English）/ 补全提示
- **快捷键**：快捷键对照表
- **系统**：关于 / 启动时自动检查更新 / 检查更新 / License

### 7.2 控件

| 控件 | 规范 |
|---|---|
| Toggle | 开启填充 `--accent` |
| 数字输入 | 右对齐或居中数字，窄宽度 |
| 下拉 | 右 chevron，菜单同圆角体系 |
| 主题卡 | 迷你代码窗缩略 + 名称；选中描边 + ✓ |
| 状态栏状态 | Git 同步 / 冲突 / 未保存使用简短文案与语义色，不显示模型或联网状态 |

### 7.3 主界面（编辑壳）

- Activity Bar 窄条图标，激活态用 accent 色标或浅底
- 资源树：修改 / Git 状态用点缀色，不抢代码区
- 标签页：当前页背景或底部轻微强调；终端 / SSH / GitLog / Compare 等非文件标签固定钉在右侧
- 状态栏：矮、信息密度中等，不使用刺眼色块

---

## 8. 动效与可访问性

### 8.1 全局动效 token

| Token | 值 | 用途 |
|---|---|---|
| `--transition-fast` | `140ms` | hover / 轻反馈（按钮、tab、文字色） |
| `--transition-medium` | `200ms` | 弹层 / popover / tooltip |
| `--transition-slow` | `280ms` | 缓速档：大区块过渡（画布主区已改为整块替换，当前无使用点） |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | 全局缓动 |

### 8.2 全局关键帧

| 关键帧 | 用途 | 形态 |
|---|---|---|
| `prism-overlay-in` | 遮罩淡入 | `opacity 0 → 1` |
| `prism-dialog-in` | dialog 弹入 | `translateY(6px) scale(0.98) → 1` |
| `prism-tab-in` | tab 入场 | `translateY(2px) + opacity` |
| `prism-toast-in` | toast 入场 | `translateY(8px) scale(0.98) → 1` |
| `prism-tooltip-in` | CM6 tooltip / completion / signature enter | `translateY(3px) scale(0.98) → 1` |
| `prism-popover-in` | context menu / dropdown / project menu | `scale(0.96) + opacity → 1` |
| `prism-status-pulse` | 状态点脉动 | `opacity 1 ↔ 0.55` |
| `prism-dot-pop` | dirty / git dot 一次性弹入 | `scale 0.4 → 1.25 → 1` |
| `prism-blink` | bracket match / accept hint | 一次性高亮 fade |

### 8.3 动效密度（当前实现）

| 区域 | 动效策略 |
|---|---|
| 文件 tab | TransitionGroup + `prism-tab-in` + active `::after` 缩放 |
| 画布主区（CM/ImagePreview/md-preview/welcome） | 整块直接替换，不做过渡（交叉淡化会让离场视图透过入场视图显形） |
| CodeMirror 弹层 | enter-only（CM6 原生无 leave 钩子） |
| find panel / ctx menu / dropdown | `prism-popover-in` + leave 淡出 |
| ActivityBar / StatusBar 状态点 | `prism-status-pulse` |
| 资源树 / Commit 行 hover | `background/color/box-shadow` transition |
| UpdateBadge / TitleBar icon | 简短 crossfade / badge enter |

### 8.4 Reduced motion

- 必须尊重系统「减少动态效果」偏好：

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

### 8.5 原则

- 面板展开 / 折叠、弹层过渡、标签动画、树 Chevron 旋转、Toast：**140–280ms**，纯 CSS
- 主题切换允许短暂交叉淡入，避免整页闪白
- 对比度：正文与背景满足可读；错误色不仅依赖颜色，需配合图标 / 下划线
- CodeMirror 交互反馈（tooltip/completion/bracket match）要**克制**：辅助感，不要干扰编码

---

## 9. 验收对照

1. 四套主题均可真实切换，UI 与编辑器高亮同步
2. 深色强调色为紫系，浅色为蓝系；Midnight 矢车菊蓝系、Cyberpunk 霓虹青系；三深色底（中性灰 / 海军蓝 / 紫黑）一眼可辨
3. 卡片圆角与留白符合规范，不出现尖锐直角密集表单
4. 选区对比度高于选区匹配 / 搜索结果
5. 正文 / 次文本 / 注释对比度达标（muted 在面板底 ≥ 4.5）；Git 徽标与拓扑节点走语义变量，浅色下可读
6. 无紫色浅色主题、无奶油风衬线海报风等偏离基准的风格漂移
