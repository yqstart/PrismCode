import { ref } from "vue";
import { basename } from "@/shared/fs";

type IconManifest = {
 file?: string;
 folder?: string;
 folderExpanded?: string;
 fileNames?: Record<string, string>;
 fileExtensions?: Record<string, string>;
 folderNames?: Record<string, string>;
 folderNamesExpanded?: Record<string, string>;
};

/** 图标资源目录：由 scripts/sync-icon-assets.mjs 在 dev/build 前同步到 public/ */
const ICON_BASE = "/icon-theme";

/**
 * 清单与图标都刻意不进模块图：
 * - material-icons.json 约 440KB，同步 import 会塞进首屏 chunk
 * - 1250 个 SVG 若作为 glob 模块，Vite 构建内存会飙到数 GB（CI 的 macOS runner 直接堆溢出）
 * 清单懒加载，图标按 id 拼静态路径；加载完成后 version 自增触发图标组件重算。
 */
export const iconAssetsVersion = ref(0);

let manifest: IconManifest | null = null;
let loading: Promise<void> | null = null;

/** 启动时预热图标清单（失败静默：图标缺失不影响功能） */
export function ensureIconAssets(): Promise<void> {
 loading ??= (async () => {
  const module = await import("material-icon-theme/dist/material-icons.json");
  manifest = module.default as IconManifest;
  iconAssetsVersion.value += 1;
 })().catch(() => undefined);
 return loading;
}

/** 按 Material Icon Theme 规则解析文件 / 文件夹图标 URL */
export function resolveMaterialIconUrl(
 path: string,
 options: { isDir?: boolean; expanded?: boolean } = {},
): string {
 const name = basename(path);
 const lower = name.toLowerCase();
 if (!manifest) {
  // 清单未就绪：先给通用图标，加载完成后 version 变化会重算
  return `${ICON_BASE}/${options.isDir ? "folder" : "file"}.svg`;
 }

 if (options.isDir) {
  if (options.expanded) {
   const id =
    manifest.folderNamesExpanded?.[lower] ??
    manifest.folderExpanded ??
    "folder-open";
   return `${ICON_BASE}/${id}.svg`;
  }
  const id = manifest.folderNames?.[lower] ?? manifest.folder ?? "folder";
  return `${ICON_BASE}/${id}.svg`;
 }

 // ==================== 文件：文件名 → 复合扩展名 → 扩展名 → 默认 ====================
 let iconId = manifest.fileNames?.[lower];

 if (!iconId && lower.includes(".")) {
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i++) {
   const ext = parts.slice(i).join(".");
   iconId = manifest.fileExtensions?.[ext];
   if (iconId) break;
  }
 }

 return `${ICON_BASE}/${iconId ?? manifest.file ?? "file"}.svg`;
}
