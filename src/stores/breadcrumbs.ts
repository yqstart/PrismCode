import { ref } from "vue";
import { defineStore } from "pinia";
import type { SymbolCrumb } from "@/features/editor/monaco/breadcrumbs";

/** 面包屑路径段：展示名 + 可定位路径 */
export interface PathCrumb {
 name: string;
 path: string;
}

/**
 * 导航栏（面包屑）共享状态（IDEA New UI 把 navigation bar 放在状态栏左下）。
 * 数据由活动编辑器计算并同步；点击动作需要编辑器实例能力（定位 / 跳转），
 * 因此由 MonacoEditor 注册处理器，状态栏只触发。
 */
export const useBreadcrumbsStore = defineStore("breadcrumbs", () => {
 const pathCrumbs = ref<PathCrumb[]>([]);
 const symbolCrumbs = ref<SymbolCrumb[]>([]);
 /** 是否展示（只读虚拟文档等场景隐藏） */
 const visible = ref(false);

 let revealHandler: ((path: string) => void) | null = null;
 let jumpHandler: ((crumb: SymbolCrumb) => void) | null = null;

 function setCrumbs(
  path: PathCrumb[],
  symbols: SymbolCrumb[],
  isVisible: boolean,
 ) {
  pathCrumbs.value = path;
  symbolCrumbs.value = symbols;
  visible.value = isVisible;
 }

 function registerHandlers(handlers: {
  reveal: (path: string) => void;
  jump: (crumb: SymbolCrumb) => void;
 }) {
  revealHandler = handlers.reveal;
  jumpHandler = handlers.jump;
 }

 function clearHandlers() {
  revealHandler = null;
  jumpHandler = null;
 }

 function reveal(path: string) {
  revealHandler?.(path);
 }

 function jump(crumb: SymbolCrumb) {
  jumpHandler?.(crumb);
 }

 return {
  pathCrumbs,
  symbolCrumbs,
  visible,
  setCrumbs,
  registerHandlers,
  clearHandlers,
  reveal,
  jump,
 };
});
