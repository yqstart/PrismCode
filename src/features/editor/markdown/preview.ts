// ==================== MD 预览 · marked 封装 ====================
// 集中管理 marked 配置：
// - GFM（表格 / 任务列表 / 删除线 / 自动链接）
// - breaks：把单个 \n 渲染为 <br>（与 GFM 兼容，方便 README 排版）
// - 自定义 code 渲染器：调用自研 highlight 上色
// 单例 renderer，避免每次 parse 都重建。

import { marked } from "marked";
import { highlight } from "./highlight.ts";

// ==================== marked 配置 ====================
marked.use({
  gfm: true,
  breaks: true,
  pedantic: false,
  renderer: {
    // 覆盖默认 code 块：调用自研高亮
    code({ text, lang }) {
      const normLang = (lang ?? "").trim();
      const body = highlight(text, normLang);
      // 复制原始 fence info（class）让用户复制时仍能拿到语言提示
      const langClass = normLang ? ` class="language-${escapeAttr(normLang)}"` : "";
      return `<pre><code${langClass}>${body}</code></pre>`;
    },
    // 行内 code：保持纯文本，不做高亮（高亮是块级的事）
    codespan({ text }) {
      return `<code>${escapeHtml(text)}</code>`;
    },
    // 安全防线 ①：raw HTML 一律转义为纯文本。
    // marked 默认把 <img onerror=...> 等原样透传进 v-html，恶意 .md 可在
    // WebView 上下文执行脚本（含 Tauri IPC 能力）。GitHub 同为转义策略。
    html({ text }) {
      return escapeHtml(text);
    },
    // 安全防线 ②：过滤 javascript:/data: 等危险协议链接，防点击执行脚本
    link({ href, title, tokens }) {
      // 直接渲染已切分的子 token，不回炉重走 inline 词法器。
      // 旧实现用 marked.parseInline(text) 解析「链接文本原文」，未闭合输入
      // （如 `[a](http://x` / 裸 URL / autolink / email）会触发
      // tokenizer ↔ link-renderer 互递归，导致 Maximum call stack 溢出，
      // 预览 computed 抛错整区白屏（或残留上次文件的旧 DOM）。
      // 子 token 中的 raw HTML 仍走上面的 html renderer 被转义，
      // 粗体/斜体/行内 code 正常渲染，安全防线不变。
      const content = this.parser.parseInline(tokens ?? []);
      if (isUnsafeProtocol(href)) {
        return `<span title="${escapeAttr(title ?? "")}">${content}</span>`;
      }
      const hrefAttr = escapeAttr(href ?? "");
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
      return `<a href="${hrefAttr}"${titleAttr} target="_blank" rel="noopener noreferrer">${content}</a>`;
    },
  },
});

// ==================== 工具 ====================
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\-.:/?#@!$&'()*+,;=%]/g, "");
}

/** 危险协议检测：javascript: / vbscript: / data:（data:image 除外）等执行类 URL。
 *  判定前先做 HTML 实体 + percent 解码：浏览器解析 href 属性时会解码
 *  `&#x73;`/`&#115;`/`&colon;` 等字符引用，`java&#x73;cript:` 点击后即 javascript:，
 *  必须在解码后的形态上拦截。 */
function isUnsafeProtocol(href: string | undefined | null): boolean {
  if (!href) return false;
  const decoded = decodeHrefObfuscation(href);
  const trimmed = decoded.trim().toLowerCase();
  if (/^(javascript|vbscript)\s*:/.test(trimmed)) return true;
  if (trimmed.startsWith("data:") && !trimmed.startsWith("data:image/")) return true;
  return false;
}

/** 解码 href 中的常见混淆：数字/十六进制字符引用（含无分号变体）、
 *  `&colon;`/`&Tab;`/`&NewLine;` 等命名实体、以及 `%xx` percent 编码。
 *  另按 WHATWG URL 标准剥离 tab/LF/CR（浏览器解析前会移除，
 *  `java&#x09;script:` 点击即 javascript:）。decodeURIComponent 对
 *  非法序列抛错时保留原文（安全方向：不过度解码）。 */
function decodeHrefObfuscation(href: string): string {
  let out = href
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);?/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&colon;/gi, ":")
    .replace(/&newline;/gi, "\n")
    .replace(/&tab;/gi, "\t")
    .replace(/[\u0000-\u001f\u007f]/g, "");
  try {
    out = decodeURIComponent(out);
  } catch {
    // 非法 percent 序列：保持已解码形态
  }
  return out;
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

// ==================== 对外 API ====================
/**
 * 同步解析 markdown 文本为 HTML 字符串。
 * 与 marked.parse({ async: false }) 等价，封装后调用方不直接 import marked。
 * marked 对畸形输入可能抛错（如历史版本的栈溢出）；调用方 previewHtml
 * computed 内兜底，抛错时展示源码编辑态而非白屏/旧内容。
 */
export function renderMarkdown(source: string): string {
  return marked.parse(source, { async: false }) as string;
}
