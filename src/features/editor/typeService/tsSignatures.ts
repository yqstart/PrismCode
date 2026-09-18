// ==================== 签名帮助（VS Code ⌃⇧Space / 输入括号即时显示） ====================
// CM6 无原生签名帮助：ViewPlugin 监听输入，轻量预判「行内 ( 未闭合」后查询类型服务，
// showTooltip 渲染参数列表（当前签名/当前参数高亮）。Esc 关闭。
// 类型服务未就绪时静默不显示（不阻塞输入）。

import {
  ViewPlugin,
  keymap,
  showTooltip,
  type EditorView,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import {
  Prec,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import { ensureTypeScriptProgram, tsService } from "@/features/editor/typeService";
import { createVueScriptContext, isInVueScript } from "@/features/editor/vueScript";
import { fileScopeRoot } from "@/shared/fileScope";
import {
  lineHasOpenParen,
  type TsSignatureHelp,
} from "@/features/editor/typeService/tsService";

// ==================== 状态 ====================

interface SignatureState {
  help: TsSignatureHelp;
  pos: number;
  docVersion: number;
}

const setSignatureEffect = StateEffect.define<SignatureState | null>();

const signatureField = StateField.define<SignatureState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSignatureEffect)) return e.value;
    }
    return value;
  },
});

// ==================== 渲染 ====================

/** 渲染签名帮助 tooltip（当前签名高亮，当前参数加粗） */
function renderSignature(help: TsSignatureHelp): HTMLDivElement {
  const dom = document.createElement("div");
  dom.className = "prism-signature-help";
  const activeSig = Math.min(
    Math.max(0, 0),
    help.signatures.length - 1,
  ); // v1 单选签名（重载场景显示全部，默认第一个）
  for (let s = 0; s < help.signatures.length; s += 1) {
    const sig = help.signatures[s];
    const line = document.createElement("div");
    line.className = "prism-signature-line";
    if (s === activeSig) line.classList.add("active");
    const label = document.createElement("span");
    label.className = "prism-signature-label";
    // 参数高亮：用激活参数索引切分 label（v1：整体显示，参数粗体单独行）
    label.textContent = sig.label;
    line.append(label);
    if (s === activeSig && sig.parameters.length > 0) {
      const param = sig.parameters[Math.max(0, help.activeParameter)];
      if (param) {
        const p = document.createElement("div");
        p.className = "prism-signature-param";
        p.textContent = `↳ ${param.label}`;
        line.append(p);
      }
      if (sig.documentation) {
        const d = document.createElement("div");
        d.className = "prism-signature-doc";
        d.textContent = sig.documentation;
        line.append(d);
      }
    }
    dom.append(line);
  }
  return dom;
}

// ==================== 查询插件 ====================

function createSignaturePlugin(filePath: string): Extension {
  class SignaturePlugin {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private disposed = false;

    update(u: ViewUpdate): void {
      if (!u.docChanged && !u.selectionSet) return;
      // 用户输入「(」/「,」/参数文本或移动光标时重新查询
      const head = u.state.selection.main.head;
      const line = u.state.doc.lineAt(head);
      const beforeLine = line.text.slice(0, head - line.from);
      if (!lineHasOpenParen(beforeLine)) {
        // 行内无未闭合 ( → 关闭
        if (u.state.field(signatureField, false)) {
          u.view.dispatch({ effects: setSignatureEffect.of(null) });
        }
        return;
      }
      // 防抖查询（输入参数文本时避免每键查询）
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.query(u), 120);
    }

    private async query(u: ViewUpdate): Promise<void> {
      this.timer = null;
      if (this.disposed) return;
      const view = u.view;
      const state = view.state;
      const head = state.selection.main.head;
      // 已显示且光标仍在原位置：不重复查询（参数文本变化时 docChanged 会重新进入）
      const existing = state.field(signatureField, false);
      if (existing && existing.pos === head) return;

      try {
        const source = state.doc.toString();
        const isVue = /\.vue$/i.test(filePath);
        if (isVue && !isInVueScript(source, head)) return;
        const virtual = isVue ? createVueScriptContext(filePath, source) : null;
        const serviceFile = virtual?.fileName ?? filePath;
        const serviceText = virtual?.text ?? source;
        const { useWorkspaceStore } = await import("@/stores/workspace");
        const scope = fileScopeRoot(useWorkspaceStore().rootPath, serviceFile);
        if (!scope || !(await ensureTypeScriptProgram(scope, serviceFile, serviceText))) return;
        const help = tsService.signatureHelpAt(serviceFile, head);
        if (help) {
          view.dispatch({
            effects: setSignatureEffect.of({
              help,
              pos: head,
              docVersion: state.doc.length,
            }),
          });
        } else if (existing) {
          view.dispatch({ effects: setSignatureEffect.of(null) });
        }
      } catch {
        // 查询异常：保持现状
      }
    }

    destroy(): void {
      this.disposed = true;
      if (this.timer) clearTimeout(this.timer);
    }
  }
  return ViewPlugin.fromClass(SignaturePlugin);
}

// ==================== tooltip 展示 ====================

const signatureTooltip = showTooltip.compute(
  [signatureField],
  (state): Tooltip | null => {
    const sig = state.field(signatureField);
    if (!sig) return null;
    return {
      pos: sig.pos,
      above: false,
      create: () => {
        const dom = renderSignature(sig.help);
        return { dom };
      },
    };
  },
);

/** 关闭签名帮助（Esc；与 ghost Esc 同 Prec.highest，注册顺序在前优先） */
function dismissSignature(view: EditorView): boolean {
  if (!view.state.field(signatureField, false)) return false;
  view.dispatch({ effects: setSignatureEffect.of(null) });
  return true;
}

/**
 * 创建签名帮助扩展（JS/TS/Vue script 使用；类型服务未就绪静默）
 */
export function createSignatureExtension(filePath: string): Extension {
  return [
    signatureField,
    createSignaturePlugin(filePath),
    signatureTooltip,
    Prec.highest(
      keymap.of([
        {
          key: "Escape",
          run: dismissSignature,
        },
      ]),
    ),
  ];
}
