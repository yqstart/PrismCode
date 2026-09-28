import { ref } from "vue";
import { basename } from "@/shared/fs";
// 通用图标保持同步导入（各几 KB）：清单尚未就绪时也有兜底图形，
// 其余上千个图标走懒加载的 URL 表。
import fallbackFileIcon from "../../node_modules/material-icon-theme/icons/file.svg?url";
import fallbackFolderIcon from "../../node_modules/material-icon-theme/icons/folder.svg?url";

type IconManifest = {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileNames?: Record<string, string>;
  fileExtensions?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
};

/**
 * 清单与图标 URL 表都改为懒加载：material-icons.json 约 440KB，
 * 同步 import 会把它塞进首屏 chunk，并拖慢每次冷启动的解析。
 * 加载完成后 version 自增，图标组件据此重算。
 */
export const iconAssetsVersion = ref(0);

let manifest: IconManifest | null = null;
const iconUrlById = new Map<string, string>();
let loading: Promise<void> | null = null;

/** Vite 把各 SVG 打成独立资源；非 eager glob → URL 表单独成 chunk */
const iconModules = import.meta.glob(
  "../../node_modules/material-icon-theme/icons/*.svg",
  { query: "?url", import: "default" },
) as Record<string, () => Promise<string>>;

let iconUrlLoading: Promise<void> | null = null;

function ensureIconUrls(): Promise<void> {
  iconUrlLoading ??= (async () => {
    const entries = await Promise.all(
      Object.entries(iconModules).map(async ([modPath, load]) => {
        const id = modPath.match(/\/([^/]+)\.svg$/)?.[1];
        if (!id) return null;
        try {
          return [id, await load()] as const;
        } catch {
          return null;
        }
      }),
    );
    for (const entry of entries) {
      if (entry) iconUrlById.set(entry[0], entry[1]);
    }
  })().catch(() => undefined);
  return iconUrlLoading;
}

/** 启动时预热图标资源（失败静默：图标缺失不影响功能） */
export function ensureIconAssets(): Promise<void> {
  loading ??= (async () => {
    const [manifestMod] = await Promise.all([
      import("material-icon-theme/dist/material-icons.json"),
      ensureIconUrls(),
    ]);
    manifest = manifestMod.default as IconManifest;
    iconAssetsVersion.value += 1;
  })().catch(() => undefined);
  return loading;
}

const SYNC_FALLBACKS: Record<string, string> = {
  file: fallbackFileIcon,
  folder: fallbackFolderIcon,
};

function urlFor(iconId: string | undefined, fallback: string): string {
  if (iconId && iconUrlById.has(iconId)) return iconUrlById.get(iconId)!;
  return iconUrlById.get(fallback) ?? SYNC_FALLBACKS[fallback] ?? "";
}

/** 按 Material Icon Theme 规则解析文件 / 文件夹图标 URL */
export function resolveMaterialIconUrl(
  path: string,
  options: { isDir?: boolean; expanded?: boolean } = {},
): string {
  const name = basename(path);
  const lower = name.toLowerCase();
  if (!manifest) {
    // 资源尚未就绪：先给通用图标（同步可得），加载完成后 version 变化会重算
    return options.isDir ? fallbackFolderIcon : fallbackFileIcon;
  }

  if (options.isDir) {
    if (options.expanded) {
      const id =
        manifest.folderNamesExpanded?.[lower] ??
        manifest.folderExpanded ??
        "folder-open";
      return urlFor(id, "folder-open");
    }
    const id = manifest.folderNames?.[lower] ?? manifest.folder ?? "folder";
    return urlFor(id, "folder");
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

  return urlFor(iconId ?? manifest.file, "file");
}
