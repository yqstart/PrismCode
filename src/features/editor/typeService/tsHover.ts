import { hoverTooltip, type Tooltip } from "@codemirror/view";
import { ensureTypeScriptProgram, tsService } from "@/features/editor/typeService";
import { createVueScriptContext, isInVueScript } from "@/features/editor/vueScript";
import { fileScopeRoot } from "@/shared/fileScope";

function renderQuickInfo(display: string, documentation: string): HTMLDivElement {
  const dom = document.createElement("div");
  dom.className = "prism-hover-info";
  if (display) {
    const signature = document.createElement("div");
    signature.className = "prism-hover-signature";
    signature.textContent = display;
    dom.append(signature);
  }
  if (documentation) {
    const docs = document.createElement("div");
    docs.className = "prism-hover-doc";
    docs.textContent = documentation;
    dom.append(docs);
  }
  return dom;
}

/** JS/TS/Vue script 共享 TS quick info；模板区域保留 Vue 自有轻量导航。 */
export function createTypeScriptHoverExtension(filePath: string) {
  if (!/\.(?:[cm]?ts|tsx|jsx|js|vue)$/i.test(filePath)) return [];
  return hoverTooltip(async (view, pos) => {
    const source = view.state.doc.toString();
    const isVue = /\.vue$/i.test(filePath);
    if (isVue && !isInVueScript(source, pos)) return null;
    const virtual = isVue ? createVueScriptContext(filePath, source) : null;
    const serviceFile = virtual?.fileName ?? filePath;
    const serviceText = virtual?.text ?? source;
    try {
      const { useWorkspaceStore } = await import("@/stores/workspace");
      const scope = fileScopeRoot(useWorkspaceStore().rootPath, serviceFile);
      if (!scope || !(await ensureTypeScriptProgram(scope, serviceFile, serviceText))) return null;
      const info = tsService.quickInfoAt(serviceFile, pos);
      if (!info) return null;
      const tooltip: Tooltip = {
        pos: info.textSpan.start,
        end: info.textSpan.start + Math.max(1, info.textSpan.length),
        above: true,
        create: () => ({ dom: renderQuickInfo(info.displayString, info.documentation) }),
      };
      return tooltip;
    } catch {
      return null;
    }
  });
}
