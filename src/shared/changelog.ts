import changelogRaw from "../../CHANGELOG.md?raw";

const GITHUB_REPO = "yqstart/PrismCode";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 从 CHANGELOG 文本中提取指定版本节（含 `## [x.y.z]` 标题） */
export function extractChangelogSection(
  markdown: string,
  version: string,
): string | null {
  const v = version.replace(/^v/i, "").trim();
  if (!v) return null;
  // 注意：勿用 /m 下的 `$` 作节尾锚点，会在标题行末就截断
  const startRe = new RegExp(`^## \\[${escapeRegExp(v)}\\][^\\n]*`, "m");
  const startMatch = markdown.match(startRe);
  if (!startMatch || startMatch.index === undefined) return null;
  const start = startMatch.index;
  const afterHeader = markdown.slice(start + startMatch[0].length);
  const nextIdx = afterHeader.search(/\n## \[/);
  const section =
    nextIdx === -1
      ? markdown.slice(start)
      : markdown.slice(start, start + startMatch[0].length + nextIdx);
  return section.trim();
}

/** 去掉版本标题与安装说明页脚，只保留「新增 / 修复」等变更项 */
export function formatNotesForDisplay(markdown: string): string {
  let text = markdown.trim();
  if (!text) return "";

  // 去掉 Keep a Changelog 版本标题
  text = text.replace(/^## \[[^\]]+\][^\n]*\n*/, "");

  // 去掉 Release 安装说明页脚（应用内不必重复）
  const footerAt = text.search(/\n---\n[\s\S]*多平台安装包由 GitHub Actions/);
  if (footerAt >= 0) {
    text = text.slice(0, footerAt);
  } else {
    const alt = text.search(/\n###\s*安装包\b/);
    if (alt >= 0) text = text.slice(0, alt);
  }

  return text.trim();
}

/** 读取应用内置 CHANGELOG 中对应版本的更新说明 */
export function getBundledChangelog(version: string): string | null {
  const section = extractChangelogSection(changelogRaw, version);
  return section ? formatNotesForDisplay(section) : null;
}

/** 是否为「仅安装说明、无变更项」的占位 Release body */
export function isGenericReleaseBody(body: string): boolean {
  const text = body.trim();
  if (!text) return true;
  const withoutInstall = text
    .replace(/\n---\n[\s\S]*$/m, "")
    .replace(/\n###\s*安装包[\s\S]*$/m, "")
    .replace(/^## \[[^\]]+\][^\n]*\n*/, "")
    .trim();
  if (
    withoutInstall &&
    (/^###\s+(新增|修复|变更|Added|Fixed|Changed)\b/m.test(withoutInstall) ||
      /^[-*]\s+/m.test(withoutInstall))
  ) {
    return false;
  }
  return (
    text.includes("多平台安装包由 GitHub Actions 自动构建") ||
    text.includes("Built by GitHub Actions")
  );
}

/** 尝试从 GitHub 拉取指定 tag 的 CHANGELOG（旧版本客户端查看新 Release 时用） */
async function fetchRemoteChangelogSection(
  version: string,
): Promise<string | null> {
  const v = version.replace(/^v/i, "").trim();
  if (!v) return null;
  const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/v${v}/CHANGELOG.md`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const text = await res.text();
    const section = extractChangelogSection(text, v);
    return section ? formatNotesForDisplay(section) : null;
  } catch {
    return null;
  }
}

/**
 * 解析新版本更新说明：Release body → 远端 CHANGELOG → 内置 CHANGELOG。
 * 优先使用 GitHub Release（与发布页同步），旧客户端也能看到新版本变更。
 */
export async function resolveUpdateNotes(
  version: string,
  releaseBody?: string,
): Promise<string> {
  const body = (releaseBody ?? "").trim();
  if (body && !isGenericReleaseBody(body)) {
    return formatNotesForDisplay(body);
  }

  const remote = await fetchRemoteChangelogSection(version);
  if (remote) return remote;

  const bundled = getBundledChangelog(version);
  if (bundled) return bundled;

  return "";
}
