<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Columns2, Eye, FileCode, GitCommitHorizontal, PenLine, Pin, Server, X } from "lucide-vue-next";
import { storeToRefs } from "pinia";
import CodeMirrorEditor from "@/features/editor/CodeMirrorEditor.vue";
import ImagePreview from "@/features/editor/ImagePreview.vue";
import { renderMarkdown } from "@/features/editor/markdown/preview";
import { buildPreviewFindRegExp } from "@/features/editor/markdown/previewFind";
import FileTypeIcon from "@/shared/FileTypeIcon.vue";
import { basename, relativeToRoot } from "@/shared/fs";
import { isRasterImagePath, isSvgPath } from "@/shared/media";
import { formatShortcut } from "@/shared/platform";
import { revealInOsExplorer } from "@/shared/revealInOs";
import { disambiguateTabLabels, tabTooltip } from "@/shared/tabLabel";
import { useCompareStore } from "@/stores/compare";
import { useEditorStore } from "@/stores/editor";
import { useGitLogStore } from "@/stores/gitLog";
import { useGitStore } from "@/stores/git";
import { useSettingsStore } from "@/stores/settings";
import { useSessionsStore } from "@/stores/sessions";
import { useSshStore } from "@/stores/ssh";
import { useWorkspaceStore } from "@/stores/workspace";
import { useI18n } from "@/i18n";

// 非首屏标签视图异步加载（各自携带 merge/xterm 等重依赖，打开对应标签时才取 chunk）
const CompareView = defineAsyncComponent(() => import("@/features/git/CompareView.vue"));
const GitLogPanel = defineAsyncComponent(() => import("@/features/git/GitLogPanel.vue"));
const SshView = defineAsyncComponent(() => import("@/features/sessions/SshView.vue"));

const { t } = useI18n();

const welcomeShortcutHint = computed(() =>
  t("editor.welcomeHint", {
    open: formatShortcut("mod", "O"),
    quick: formatShortcut("mod", "P"),
    term: formatShortcut("mod", "J"),
  }),
);

const editor = useEditorStore();
const sessions = useSessionsStore();
const ssh = useSshStore();
const compare = useCompareStore();
const gitLog = useGitLogStore();
const workspace = useWorkspaceStore();
const git = useGitStore();
const settings = useSettingsStore();
const { tabs, activePath, activeTab, blameVisible, findRequest } = storeToRefs(editor);
const { rootPath } = storeToRefs(workspace);
const { snapshot: gitSnapshot } = storeToRefs(git);
const {
  open: sshOpen,
  mounted: sshMounted,
  isFocused: sshFocused,
  tabId: sshTabId,
} = storeToRefs(ssh);
const {
  tabs: compareTabs,
  activeId: compareActiveId,
  isFocused: compareFocused,
} = storeToRefs(compare);
const {
  open: gitLogOpen,
  isFocused: gitLogFocused,
  tabId: gitLogTabId,
} = storeToRefs(gitLog);

/** Markdown 模式：按文件路径从 store 读取上次选择，store 内部走 localStorage 持久化。
 *  首次打开（无记录）默认 'preview'，与改造前一致。SVG 保留旧的本地 ref 行为（无持久化）。 */
type MdMode = "preview" | "edit";
const markdownPreviewMode = ref<MdMode>(editor.getMdMode(activePath.value ?? ""));
/** 兼容旧布尔读取位（true = 当前是预览态） */
const markdownPreview = computed(() => markdownPreviewMode.value === "preview");
const svgPreview = ref(true);

const isMarkdown = computed(() => {
  const name = activeTab.value?.name.toLowerCase() ?? "";
  return name.endsWith(".md") || name.endsWith(".markdown");
});

const isSvg = computed(() =>
  activeTab.value ? isSvgPath(activeTab.value.path) : false,
);

const isRaster = computed(() =>
  activeTab.value ? isRasterImagePath(activeTab.value.path) : false,
);

const showFileEditor = computed(
  () =>
    !sshFocused.value &&
    !compareFocused.value &&
    !gitLogFocused.value &&
    Boolean(activeTab.value),
);

const showImagePreview = computed(
  () =>
    showFileEditor.value &&
    Boolean(activeTab.value) &&
    (isRaster.value || (isSvg.value && svgPreview.value)),
);

/** 当前活动 md 是否因渲染失败而强制回退到编辑态 */
const mdRenderFailed = computed(
  () =>
    isMarkdown.value &&
    Boolean(activeTab.value) &&
    mdRenderFailedPath.value === activeTab.value?.path,
);

const showTextEditor = computed(
  () =>
    showFileEditor.value &&
    Boolean(activeTab.value) &&
    !isRaster.value &&
    !(isMarkdown.value && markdownPreview.value && !mdRenderFailed.value) &&
    !(isSvg.value && svgPreview.value),
);

const canTogglePreview = computed(
  () =>
    showFileEditor.value &&
    Boolean(activeTab.value) &&
    (isMarkdown.value || isSvg.value),
);

const previewShowing = computed(() =>
  isMarkdown.value ? markdownPreview.value : isSvg.value ? svgPreview.value : false,
);

const previewToggleLabel = computed(() => {
  if (isMarkdown.value) return markdownPreview.value ? t("editor.edit") : t("editor.preview");
  if (isSvg.value) return svgPreview.value ? t("editor.source") : t("editor.preview");
  return t("editor.preview");
});

const previewToggleTitle = computed(() => {
  if (isMarkdown.value)
    return markdownPreview.value ? t("editor.editMode") : t("editor.previewMode");
  if (isSvg.value)
    return svgPreview.value ? t("editor.editSvg") : t("editor.previewSvg");
  return "";
});

const previewHtml = computed(() => {
  if (
    !activeTab.value ||
    !markdownPreview.value ||
    !isMarkdown.value ||
    sshFocused.value ||
    compareFocused.value ||
    gitLogFocused.value
  ) {
    return "";
  }
  try {
    return renderMarkdown(activeTab.value.content);
  } catch (error) {
    // 渲染失败（畸形 md 触发解析器异常）：记失败路径，mdRenderFailed 分支
    // 会把该文件展示为编辑态而非空白/旧内容。try/catch 放在 computed 内：
    // computed 抛错会连带污染依赖它的 previewHtml watcher，错误必须在此消化。
    mdRenderFailedPath.value = activeTab.value.path;
    console.warn("[md-preview] 渲染失败，已回退到编辑态", error);
    return "";
  }
});
/** 最近一次渲染失败的文件路径：命中时该 md 强制走编辑态（而非空白/旧内容） */
const mdRenderFailedPath = ref<string | null>(null);
/** MD 预览容器（滚动）与渲染根：容器复用去 key，切文件只换 v-html（无闪屏） */
const mdPreviewRef = ref<HTMLElement | null>(null);
const mdContentRef = ref<HTMLElement | null>(null);

/** MD 预览内查找（只读浮层，无替换行；⌘F 经 findRequest 信号路由到此） */
const mdFindOpen = ref(false);
const mdFindQuery = ref("");
const mdFindCase = ref(false);
const mdFindRegex = ref(false);
const mdFindWord = ref(false);
const mdFindIndex = ref(0);
const mdFindTotal = ref(0);
const mdFindInputRef = ref<HTMLInputElement | null>(null);
let mdFindMarks: HTMLElement[] = [];
let mdFindTimer: ReturnType<typeof setTimeout> | null = null;

const mdFindVisible = computed(
  () =>
    mdFindOpen.value &&
    showFileEditor.value &&
    isMarkdown.value &&
    markdownPreview.value &&
    !mdRenderFailed.value,
);

const mdFindCountText = computed(() => {
  if (!mdFindQuery.value.trim()) return "—";
  if (!mdFindTotal.value) return t("editorFind.noResults");
  return t("editorFind.matchCount", {
    current: mdFindIndex.value + 1,
    total: mdFindTotal.value,
  });
});

function clearMdFindMarks(): void {
  const root = mdContentRef.value;
  mdFindMarks = [];
  if (!root) return;
  // v-html 重渲染会整块替换 innerHTML，旧 mark 随之消失；这里只处理存量
  const marks = root.querySelectorAll("mark.md-find-match");
  marks.forEach((m) => {
    const parent = m.parentNode;
    if (parent) parent.replaceChild(document.createTextNode(m.textContent ?? ""), m);
  });
  root.normalize();
}

function setMdFindCurrent(index: number, scroll: boolean): void {
  mdFindIndex.value = index;
  mdFindMarks.forEach((m, i) => m.classList.toggle("is-current", i === index));
  if (scroll) mdFindMarks[index]?.scrollIntoView({ block: "center" });
}

function applyMdFind(reveal: boolean): void {
  clearMdFindMarks();
  mdFindTotal.value = 0;
  mdFindIndex.value = 0;
  const root = mdContentRef.value;
  const query = mdFindQuery.value;
  if (!mdFindOpen.value || !root || !query.trim()) return;
  const re = buildPreviewFindRegExp(query, {
    caseSensitive: mdFindCase.value,
    regexp: mdFindRegex.value,
    wholeWord: mdFindWord.value,
  });
  if (!re) return;
  // 先收齐文本节点再包 mark：边走边改 DOM 会使 TreeWalker 漏节点
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) nodes.push(node as Text);
  const marks: HTMLElement[] = [];
  for (const textNode of nodes) {
    const text = textNode.data;
    re.lastIndex = 0;
    let frag: DocumentFragment | null = null;
    let last = 0;
    for (;;) {
      const m = re.exec(text);
      if (!m) break;
      if (m[0].length === 0) {
        // 零宽匹配不收录，手动推进（与 previewFind 纯函数一致）
        re.lastIndex += 1;
        if (re.lastIndex > text.length) break;
        continue;
      }
      if (!frag) frag = document.createDocumentFragment();
      if (m.index > last)
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement("mark");
      mark.className = "md-find-match";
      mark.textContent = m[0];
      frag.appendChild(mark);
      marks.push(mark);
      last = m.index + m[0].length;
    }
    if (frag) {
      if (last < text.length)
        frag.appendChild(document.createTextNode(text.slice(last)));
      textNode.parentNode?.replaceChild(frag, textNode);
    }
    if (marks.length >= 10000) break;
  }
  mdFindMarks = marks;
  mdFindTotal.value = marks.length;
  if (marks.length) setMdFindCurrent(0, reveal);
}

function stepMdFind(delta: 1 | -1): void {
  if (!mdFindMarks.length) return;
  const next =
    (mdFindIndex.value + delta + mdFindMarks.length) % mdFindMarks.length;
  setMdFindCurrent(next, true);
}

function openMdFind(): void {
  if (!isMarkdown.value || !markdownPreview.value || mdRenderFailed.value) return;
  mdFindOpen.value = true;
  nextTick(() => {
    // 有旧查询直接沿用并定位首处（对齐 CM 面板 mount 行为），无查询只聚焦
    applyMdFind(true);
    mdFindInputRef.value?.focus();
    mdFindInputRef.value?.select();
  });
}

function closeMdFind(): void {
  mdFindOpen.value = false;
  if (mdFindTimer !== null) {
    clearTimeout(mdFindTimer);
    mdFindTimer = null;
  }
  clearMdFindMarks();
}

function onMdFindInput(): void {
  if (mdFindTimer !== null) clearTimeout(mdFindTimer);
  // 输入防抖 120ms（对齐 CM 查找面板 scheduleCommit），避免大文档每键全量走 DOM
  mdFindTimer = setTimeout(() => {
    mdFindTimer = null;
    applyMdFind(true);
  }, 120);
}

function toggleMdFindOpt(which: "case" | "regex" | "word"): void {
  if (which === "case") mdFindCase.value = !mdFindCase.value;
  else if (which === "regex") mdFindRegex.value = !mdFindRegex.value;
  else mdFindWord.value = !mdFindWord.value;
  applyMdFind(true);
}
function onMdFindKeydown(event: KeyboardEvent): void {
  const mod = event.metaKey || event.ctrlKey;
  // 焦点在浮层输入框时 AppShell 的 ⌘F 兜底因 editable 守卫直接返回，
  // 这里自己接住：重新聚焦并全选（对齐 CM 查找面板重复 ⌘F 行为）
  if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    mdFindInputRef.value?.focus();
    mdFindInputRef.value?.select();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeMdFind();
    return;
  }
  // 焦点常驻输入框，Enter / F3 / ⌘G 直接导航，无需窗口级监听
  if (event.key === "Enter" || event.key === "F3") {
    event.preventDefault();
    stepMdFind(event.shiftKey ? -1 : 1);
    return;
  }
  if (mod && !event.altKey && (event.key === "g" || event.key === "G")) {
    event.preventDefault();
    stepMdFind(event.shiftKey ? -1 : 1);
  }
}

// ⌘F 信号路由：MD 预览态由本浮层消费，其余态放行给 CodeMirror 查找面板
watch(findRequest, (req) => {
  if (!req || req.path !== activePath.value) return;
  if (
    !isMarkdown.value ||
    !markdownPreview.value ||
    mdRenderFailed.value ||
    !showFileEditor.value ||
    sshFocused.value ||
    compareFocused.value ||
    gitLogFocused.value
  )
    return;
  openMdFind();
});

// 预览内容变化（切文件/外部修改）后重打高亮；不滚动（切文件由 path watcher 回顶）
watch(previewHtml, () => {
  if (!mdFindOpen.value) return;
  nextTick(() => applyMdFind(false));
});

// 浮层从隐藏恢复（SSH/GitLog 切回）时 DOM 已重建，重打高亮
watch(mdFindVisible, (visible) => {
  if (!visible) return;
  nextTick(() => applyMdFind(false));
});

// 编辑→预览切回时重打高亮；离开预览态无需清 mark（DOM 随分支卸载）
watch(markdownPreview, (on) => {
  if (!mdFindOpen.value || !on) return;
  nextTick(() => applyMdFind(false));
});

const hasAnyTab = computed(
  () =>
    tabs.value.length > 0 ||
    sshOpen.value ||
    compareTabs.value.length > 0 ||
    gitLogOpen.value,
);

const tabLabels = computed(() =>
  disambiguateTabLabels(
    tabs.value.map((tab) => tab.path),
    rootPath.value,
  ),
);

function fileTabLabel(path: string, name: string): string {
  return tabLabels.value.get(path) ?? name;
}

function fileTabTitle(path: string): string {
  return tabTooltip(path, rootPath.value);
}

watch(
  () => activeTab.value?.path,
  (next) => {
    // 渲染失败标记只对当时失败的路径有效：切走即清，避免污染其它文件；
    // 切回同一失败文件时 previewHtml 会重算，仍失败则重新标记。
    if (mdRenderFailedPath.value !== next) mdRenderFailedPath.value = null;
    // Markdown：从 store 读上次选择（按路径持久化），无记录默认 preview
    markdownPreviewMode.value = editor.getMdMode(next ?? "");
    // SVG：保持旧行为（每次切文件重置为预览）
    svgPreview.value = true;
    // 预览容器复用（去 key 防闪屏）：同一元素切文件后回到顶部
    if (mdPreviewRef.value) mdPreviewRef.value.scrollTop = 0;
  },
);

function togglePreview() {
  if (!canTogglePreview.value) return;
  if (isMarkdown.value && activeTab.value) {
    const next: MdMode =
      markdownPreviewMode.value === "preview" ? "edit" : "preview";
    setMdModeUi(next);
    return;
  }
  if (isSvg.value) {
    svgPreview.value = !svgPreview.value;
  }
}

/** Segmented Control 点击：直接切到指定 mode 并持久化（无当前 tab 时静默） */
function setMdModeUi(mode: MdMode) {
  if (!isMarkdown.value || !activeTab.value) return;
  markdownPreviewMode.value = mode;
  editor.setMdMode(activeTab.value.path, mode);
}

function activateFile(path: string) {
  sessions.blurSessions();
  ssh.blurSsh();
  compare.blurCompare();
  gitLog.blurLog();
  editor.activate(path);
}

function activateSsh() {
  sessions.blurSessions();
  compare.blurCompare();
  gitLog.blurLog();
  ssh.focusSsh();
}

function activateCompare(id: string) {
  sessions.blurSessions();
  ssh.blurSsh();
  gitLog.blurLog();
  compare.activate(id);
}

function activateGitLog() {
  sessions.blurSessions();
  ssh.blurSsh();
  compare.blurCompare();
  gitLog.focusLog();
}

async function closeSshTab() {
  const ok = await ssh.closeSsh();
  if (!ok) return;
  if (gitLogOpen.value && !editor.activePath && !compareTabs.value.length) {
    gitLog.focusLog();
    return;
  }
  if (compareTabs.value.length && !editor.activePath) {
    compare.focusCompare();
    return;
  }
  if (!editor.activePath && editor.tabs.length) {
    editor.activate(editor.tabs[0].path);
  }
}

function closeGitLogTab() {
  gitLog.closeLog();
  if (compareTabs.value.length && !editor.activePath) {
    compare.focusCompare();
    return;
  }
  if (!editor.activePath && editor.tabs.length) {
    editor.activate(editor.tabs[0].path);
  }
}

function closeCompareTab(id: string) {
  compare.closeTab(id);
  if (
    !compare.tabs.length &&
    !sshFocused.value &&
    !gitLogFocused.value &&
    editor.activePath
  ) {
    compare.blurCompare();
  }
}

/** 标签栏：滚轮纵向 → 横向滚动，不显示滚动条 */
function onTabsWheel(event: WheelEvent) {
  const el = event.currentTarget as HTMLElement;
  if (el.scrollWidth <= el.clientWidth) return;
  const delta =
    Math.abs(event.deltaY) >= Math.abs(event.deltaX)
      ? event.deltaY
      : event.deltaX;
  if (!delta) return;
  el.scrollLeft += delta;
}

/**
 * 标签离场定位：`.tab-leave-active` 需要 `position: absolute` 才能让相邻标签
 * 立即补位（配合 `.tab-move` 补间）。但绝对定位元素在 flex 容器里没有 inset
 * 时，静止位置按容器起点算——被关闭的标签会飞到标签条最左端、盖在第一个标签
 * 上淡出。所以离场前记下原位，离场时写回。
 *
 * 跳动根因（macOS overlay scrollbars）：横向滚动条是覆盖层、不占布局高度，
 * `.tabs-scroll` 的 overflow-y: hidden + scrollbar-width: none 会让容器
 * scrollWidth/scrollLeft 出现亚像素取整抖动。用 offsetLeft 快照再回填
 * style.left 时，小宽度标签（图标+短文件名）会取到取整前的值，回填后产生
 * 1px 级整体偏移，视觉上就是关闭时标签条「跳动一下」。改用
 * getBoundingClientRect 快照（与 FLIP 补间同一坐标系）+ 离场期间锁定元素
 * 自身宽度 + 离场取消时清掉 FLIP 残留的 transform，关闭即稳。
 */
const leavingTabGeom = new WeakMap<HTMLElement, { left: number; top: number; width: number }>();

function onTabBeforeLeave(el: Element) {
  const node = el as HTMLElement;
  // 此刻元素仍在文档流中，rect 就是它在视口坐标系下的真实位置；
  // 转成相对 offsetParent（.tabs-scroll，position: relative）的坐标，
  // 与 FLIP 补间的 getPosition 快照同源，避免 offsetLeft 取整抖动。
  const parent = node.offsetParent as HTMLElement | null;
  const rect = node.getBoundingClientRect();
  const parentRect = parent?.getBoundingClientRect();
  leavingTabGeom.set(node, {
    left: parentRect ? rect.left - parentRect.left : node.offsetLeft,
    top: parentRect ? rect.top - parentRect.top : node.offsetTop,
    width: rect.width,
  });
}

function onTabLeave(el: Element) {
  const node = el as HTMLElement;
  const origin = leavingTabGeom.get(node);
  leavingTabGeom.delete(node);
  if (!origin) return;
  node.style.left = `${origin.left}px`;
  node.style.top = `${origin.top}px`;
  // 锁定自身宽度：flex 容器里绝对定位元素的宽度按内容重算（图标/关闭按钮
  // 的显隐会让它变窄），宽窄变化会带动相邻标签的 FLIP 目标抖动。
  node.style.width = `${origin.width}px`;
}

/** 离场被打断（同一路径在动画结束前被重新打开）时元素会被复用，
 *  `.tab` 自身是 relative，残留的 left/top/width 会把标签挤偏，必须清掉；
 *  同时清掉 FLIP 补间可能残留的行内 transform，否则复用的标签会偏位。 */
function onTabLeaveCancelled(el: Element) {
  const node = el as HTMLElement;
  leavingTabGeom.delete(node);
  node.style.left = "";
  node.style.top = "";
  node.style.width = "";
  node.style.transform = "";
}

const editorCtx = ref<{ x: number; y: number; absPath: string } | null>(null);
const tabCtx = ref<{ x: number; y: number; path: string } | null>(null);

/** contextmenu 触发时间戳：用于避免同帧后续 mousedown 立刻把刚开的菜单关掉 */
let ctxMenuOpenedAt = 0;

const tabCtxIndex = computed(() => {
  if (!tabCtx.value) return -1;
  return tabs.value.findIndex((t) => t.path === tabCtx.value!.path);
});

const tabCtxPinned = computed(() => {
  if (!tabCtx.value) return false;
  return Boolean(tabs.value.find((t) => t.path === tabCtx.value!.path)?.pinned);
});

const tabCtxCanCloseLeft = computed(() => {
  const idx = tabCtxIndex.value;
  if (idx <= 0) return false;
  return tabs.value.slice(0, idx).some((t) => !t.pinned);
});

const tabCtxCanCloseRight = computed(() => {
  const idx = tabCtxIndex.value;
  if (idx < 0 || idx >= tabs.value.length - 1) return false;
  return tabs.value.slice(idx + 1).some((t) => !t.pinned);
});

const tabCtxCanCloseOthers = computed(() => {
  if (!tabCtx.value) return false;
  return tabs.value.some(
    (t) => t.path !== tabCtx.value!.path && !t.pinned,
  );
});

const tabCtxCanCloseAll = computed(() =>
  tabs.value.some((t) => !t.pinned),
);

function clampMenuPos(x: number, y: number, width = 180, height = 220) {
  const pad = 8;
  const maxX = Math.max(pad, window.innerWidth - width - pad);
  const maxY = Math.max(pad, window.innerHeight - height - pad);
  return {
    x: Math.min(Math.max(pad, x), maxX),
    y: Math.min(Math.max(pad, y), maxY),
  };
}

function onTabContextMenu(event: MouseEvent, path: string) {
  event.preventDefault();
  event.stopPropagation();
  editorCtx.value = null;
  const pos = clampMenuPos(event.clientX, event.clientY);
  tabCtx.value = { x: pos.x, y: pos.y, path };
  ctxMenuOpenedAt = Date.now();
  activateFile(path);
}

async function runTabMenu(
  action:
    | "pin"
    | "close"
    | "closeOthers"
    | "closeLeft"
    | "closeRight"
    | "closeAll"
    | "revealInOs",
) {
  const path = tabCtx.value?.path;
  tabCtx.value = null;
  if (!path) return;
  if (action === "pin") {
    editor.togglePin(path);
    return;
  }
  if (action === "revealInOs") {
    await revealInOsExplorer(path, (message, ms) =>
      workspace.showNotice(message, ms),
    );
    return;
  }
  if (action === "close") {
    await editor.closeTab(path);
    return;
  }
  if (action === "closeOthers") {
    await editor.closeOtherTabs(path);
    return;
  }
  if (action === "closeLeft") {
    await editor.closeTabsToTheLeft(path);
    return;
  }
  if (action === "closeRight") {
    await editor.closeTabsToTheRight(path);
    return;
  }
  if (action === "closeAll") {
    await editor.closeAllTabs();
  }
}

const editorCtxRelPath = computed(() => {
  if (!editorCtx.value || !rootPath.value) return null;
  return relativeToRoot(rootPath.value, editorCtx.value.absPath);
});

const editorCtxGitEntry = computed(() => {
  const rel = editorCtxRelPath.value;
  if (!rel || rel === ".") return null;
  const norm = rel.replace(/\\/g, "/");
  return git.statusMap.get(rel) ?? git.statusMap.get(norm) ?? null;
});

const canDiscardActive = computed(
  () => Boolean(editorCtxGitEntry.value) && !editorCtxGitEntry.value?.conflicted,
);

// Git 段（Diff / Blame 列开关）只要处于已初始化的 git 仓库即可见；
// 「丢弃更改」仅在当前文件有可丢弃改动时显示（canDiscardActive）。
const hasGitMenu = computed(() => gitSnapshot.value.initialized);

const formatDocumentDisabled = computed(
  () => !settings.editor.prettierEnabled,
);

function onEditorContextMenu(event: MouseEvent) {
  if (!activeTab.value || !showFileEditor.value) return;
  if (compareFocused.value || gitLogFocused.value) return;
  if (isRasterImagePath(activeTab.value.path)) return;
  event.preventDefault();
  event.stopPropagation();
  tabCtx.value = null;
  // 右键时主动触发一次 git 刷新，避免 statusMap 暂空导致 git 菜单看不到
  // （refresh 是异步的，菜单立即就显示，状态随后自然补上）
  void git.scheduleRefresh();
  const pos = clampMenuPos(event.clientX, event.clientY);
  editorCtx.value = {
    x: pos.x,
    y: pos.y,
    absPath: activeTab.value.path,
  };
  // 标记 contextmenu 触发时刻；50ms 内的 mousedown 视为同一手势，不关菜单
  ctxMenuOpenedAt = Date.now();
}

/**
 * 关闭逻辑说明：
 * 1. 监听 `mousedown` 而非 `pointerdown`：`mousedown.button` 字段在所有浏览器/WKWebView 都可靠。
 * 2. 时间守卫：contextmenu 触发后 80ms 内的 mousedown 视为同一手势的尾巴（如 macOS right-click
 *    触发的后续 click），不关菜单。
 * 3. 位置判定：点击坐标在菜单 bounding box 内部时**不**关（让菜单内 button 自己的 click
 *    handler 负责关闭——它们会先把 editorCtx/tabCtx 置 null，再走业务逻辑）。
 * 4. 右键 (button === 2) 仍跳过：避免新一轮 contextmenu 立刻关掉旧菜单。
 */
function onDocMouseDown(event: MouseEvent) {
  if (event.button === 2) return;
  if (editorCtx.value && pointInMenu(event.clientX, event.clientY, editorCtx.value)) return;
  if (tabCtx.value && pointInMenu(event.clientX, event.clientY, tabCtx.value)) return;
  if (Date.now() - ctxMenuOpenedAt < 80) return;
  editorCtx.value = null;
  tabCtx.value = null;
}

function pointInMenu(
  x: number,
  y: number,
  menu: { x: number; y: number },
): boolean {
  // 菜单宽高通过 CSS 估算（与模板内 min-width 160/168px + 字号行高匹配）
  const width = 200;
  const height = 280;
  return (
    x >= menu.x &&
    x <= menu.x + width &&
    y >= menu.y &&
    y <= menu.y + height
  );
}

async function formatFromEditor() {
  editorCtx.value = null;
  await editor.formatDocument();
}

async function discardFromEditor() {
  const rel = editorCtxRelPath.value;
  const entry = editorCtxGitEntry.value;
  editorCtx.value = null;
  if (!rel || !entry || entry.conflicted) return;
  const isUntracked = entry.status === "untracked";
  const msg = isUntracked
    ? t("editor.discardUntrackedConfirm", { name: basename(rel) })
    : t("editor.discardConfirm", { name: basename(rel) });
  if (!confirm(msg)) return;
  await git.discard([rel]);
}

async function showDiffFromEditor() {
  const rel = editorCtxRelPath.value;
  editorCtx.value = null;
  if (!rel) return;
  await git.showDiff(rel, false);
}

function toggleBlameFromEditor() {
  editorCtx.value = null;
  editor.toggleBlame();
}

onMounted(() => window.addEventListener("mousedown", onDocMouseDown, true));
onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onDocMouseDown, true);
  if (mdFindTimer !== null) {
    clearTimeout(mdFindTimer);
    mdFindTimer = null;
  }
});
</script>

<template>
  <section class="editor-area">
    <div v-if="hasAnyTab" class="tabs">
      <TransitionGroup
        name="tab"
        tag="div"
        class="tabs-scroll"
        @wheel.prevent="onTabsWheel"
        @before-leave="onTabBeforeLeave"
        @leave="onTabLeave"
        @leave-cancelled="onTabLeaveCancelled"
      >
        <button
          v-for="tab in tabs"
          :key="tab.path"
          type="button"
          class="tab"
          :class="{
            active: showFileEditor && tab.path === activePath,
            pinned: tab.pinned,
            dirty: editor.isDirty(tab.path),
          }"
          @click="activateFile(tab.path)"
          @auxclick.middle.prevent="editor.closeTab(tab.path)"
          @contextmenu="onTabContextMenu($event, tab.path)"
        >
          <FileTypeIcon :path="tab.path" :size="14" class="tab-file-icon" />
          <span class="name" :class="{ disambiguated: fileTabLabel(tab.path, tab.name) !== tab.name }" :title="fileTabTitle(tab.path)">
            {{ fileTabLabel(tab.path, tab.name) }}
          </span>
          <span class="tab-trailing">
            <Pin v-if="tab.pinned" :size="11" class="pin-icon" />
            <span
              class="close"
              :title="t('editor.close')"
              @click.stop="editor.closeTab(tab.path)"
            >
              <X :size="12" />
            </span>
          </span>
        </button>
        <!-- GitLog 与普通文件标签一致：排在文件标签之后，参与滚动与排序，不固定右侧 -->
        <button
          v-if="gitLogOpen"
          :key="`gitlog-${gitLogTabId}`"
          type="button"
          class="tab gitlog-tab"
          :class="{ active: gitLogFocused }"
          @click="activateGitLog"
          @auxclick.middle.prevent="closeGitLogTab"
        >
          <GitCommitHorizontal :size="12" class="gitlog-icon" />
          <span class="name">{{ t("editor.gitLogTab") }}</span>
          <span
            class="close"
            :title="t('editor.closeGitLog')"
            @click.stop="closeGitLogTab"
          >
            <X :size="12" />
          </span>
        </button>

        <!-- Diff/Compare 与普通文件标签一致：参与滚动，不固定在最右侧 -->
        <button
          v-for="tab in compareTabs"
          :key="tab.id"
          type="button"
          class="tab compare-tab"
          :class="{ active: compareFocused && tab.id === compareActiveId }"
          @click="activateCompare(tab.id)"
          @auxclick.middle.prevent="closeCompareTab(tab.id)"
        >
          <Columns2 :size="12" class="cmp-icon" />
          <span class="name">{{ tab.title }}</span>
          <span
            class="close"
            :title="t('editor.close')"
            @click.stop="closeCompareTab(tab.id)"
          >
            <X :size="12" />
          </span>
        </button>
      </TransitionGroup>

      <!-- 固定标签区：仅保留 SSH 和 SVG 预览切换等需要常驻右侧的控件 -->
      <div class="tabs-fixed">
        <button
          v-if="sshOpen"
          type="button"
          class="tab ssh-tab"
          :class="{ active: sshFocused }"
          :data-id="sshTabId"
          @click="activateSsh"
          @auxclick.middle.prevent="closeSshTab"
        >
          <Server :size="12" class="ssh-icon" />
          <span class="name">{{ t("editor.sshTab") }}</span>
          <span
            class="close"
            :title="t('editor.closeSsh')"
            @click.stop="closeSshTab"
          >
            <X :size="12" />
          </span>
        </button>

        <!-- SVG 预览切换仍走标签栏：MD 切到预览区右上角浮动控件（Cursor 风格） -->
        <button
          v-if="canTogglePreview && isSvg"
          type="button"
          class="preview-toggle"
          :title="previewToggleTitle"
          @click="togglePreview"
        >
          <Eye v-if="!previewShowing" :size="14" />
          <FileCode v-else :size="14" />
          {{ previewToggleLabel }}
        </button>
      </div>
    </div>

    <div class="canvas">
      <Transition name="canvas-fade">
        <SshView v-if="sshMounted" v-show="sshFocused" />
      </Transition>

      <Transition name="canvas-fade">
        <GitLogPanel v-if="gitLogOpen" v-show="gitLogFocused" />
      </Transition>

      <TransitionGroup name="canvas-fade" tag="div" class="canvas-stack">
        <CompareView
          v-for="tab in compareTabs"
          v-show="compareFocused && tab.id === compareActiveId"
          :key="tab.id"
          :tab-id="tab.id"
          :active="compareFocused && tab.id === compareActiveId"
        />
      </TransitionGroup>

      <!--
        画布切换：默认同时过渡 + 绝对定位叠放（enter 在上层、leave 在下层）。
        不用 out-in：其 afterLeave 依赖 nextFrame（双 rAF）内注册的动画结束
        监听，WKWebView 长时间空闲/被遮挡后 rAF 可能被丢弃，旧视图会永久
        卡在 leave、新分支永不挂载（表现为编辑区黑屏/空白，必须重启）。
        同时模式下即使动画完全未播放，新内容也已挂载且位于上层可见。
        :duration 兜底「动画事件丢失」场景（清理残留过渡类）。
      -->
      <Transition name="canvas" :duration="{ enter: 320, leave: 220 }">
        <template v-if="showFileEditor && activeTab">
          <ImagePreview
            v-if="showImagePreview"
            :key="`image-${activeTab.path}`"
            :path="activeTab.path"
            :content="isSvg ? activeTab.content : undefined"
            :cache-key="activeTab.previewNonce"
          />
          <CodeMirrorEditor
            v-else-if="showTextEditor"
            :path="activeTab.path"
            :content="activeTab.content"
            @contextmenu="onEditorContextMenu"
          />
          <!-- 预览分支必须与 showTextEditor 的 md 条件互补：渲染失败回退编辑态
               时 showTextEditor 为 true 走上面分支；此处只在「预览成功」时挂载，
               否则失败文件会同时命中两分支、旧预览 DOM 残留（上次文件的内容）。 -->
          <div
            v-else-if="markdownPreview && isMarkdown && !mdRenderFailed"
            ref="mdPreviewRef"
            class="md-preview"
            @contextmenu="onEditorContextMenu"
          >
            <div ref="mdContentRef" class="md-preview-content" v-html="previewHtml" />
          </div>
        </template>
        <div
          v-else-if="!sshFocused && !compareFocused && !gitLogFocused && !activeTab"
          key="welcome"
          class="welcome"
        >
          <h1>{{ t("app.name") }}</h1>
          <p>{{ t("app.tagline") }}</p>
          <div class="actions">
            <button type="button" class="cta" @click="workspace.openFolder()">
              {{ t("editor.openFolder") }}
            </button>
            <button type="button" class="ghost" @click="sessions.openSessions(workspace.rootPath)">
              {{ t("editor.openTerminal") }}
            </button>
            <p class="hint">{{ welcomeShortcutHint }}</p>
          </div>
        </div>
      </Transition>
      <!-- MD 预览内查找：只读浮层（无替换行），⌘F 经 findRequest 路由打开 -->
      <div
        v-if="mdFindVisible"
        class="md-find-panel"
        role="search"
        @keydown="onMdFindKeydown"
      >
        <div class="md-find-row">
          <input
            ref="mdFindInputRef"
            v-model="mdFindQuery"
            type="text"
            class="md-find-input"
            :placeholder="t('editorFind.findPlaceholder')"
            :aria-label="t('editorFind.findPlaceholder')"
            @input="onMdFindInput"
          />
          <span class="md-find-count">{{ mdFindCountText }}</span>
          <button
            type="button"
            class="md-find-btn"
            :title="t('editorFind.previous')"
            :aria-label="t('editorFind.previous')"
            @click="stepMdFind(-1)"
          >
            ↑
          </button>
          <button
            type="button"
            class="md-find-btn"
            :title="t('editorFind.next')"
            :aria-label="t('editorFind.next')"
            @click="stepMdFind(1)"
          >
            ↓
          </button>
          <button
            type="button"
            class="md-find-btn md-find-toggle"
            :class="{ active: mdFindCase }"
            :title="t('search.caseSensitive')"
            :aria-label="t('search.caseSensitive')"
            :aria-pressed="mdFindCase ? 'true' : 'false'"
            @click="toggleMdFindOpt('case')"
          >
            Aa
          </button>
          <button
            type="button"
            class="md-find-btn md-find-toggle"
            :class="{ active: mdFindRegex }"
            :title="t('search.regex')"
            :aria-label="t('search.regex')"
            :aria-pressed="mdFindRegex ? 'true' : 'false'"
            @click="toggleMdFindOpt('regex')"
          >
            .*
          </button>
          <button
            type="button"
            class="md-find-btn md-find-toggle"
            :class="{ active: mdFindWord }"
            :title="t('editorFind.wholeWord')"
            :aria-label="t('editorFind.wholeWord')"
            :aria-pressed="mdFindWord ? 'true' : 'false'"
            @click="toggleMdFindOpt('word')"
          >
            Ab
          </button>
          <button
            type="button"
            class="md-find-btn"
            :title="t('common.close')"
            :aria-label="t('common.close')"
            @click="closeMdFind"
          >
            ×
          </button>
        </div>
      </div>

      <!-- MD 预览/编辑右上角 Segmented Control：定位在 tab 下方的实际编辑内容区内 -->
      <div
        v-if="isMarkdown && showFileEditor"
        class="md-mode-toggle"
        :title="t('editor.mdSwitchHint')"
        role="tablist"
      >
        <button
          type="button"
          class="md-mode-btn"
          :class="{ active: markdownPreviewMode === 'preview' }"
          :title="t('editor.preview')"
          role="tab"
          :aria-selected="markdownPreviewMode === 'preview'"
          @click="setMdModeUi('preview')"
        >
          <Eye :size="13" />
        </button>
        <button
          type="button"
          class="md-mode-btn"
          :class="{ active: markdownPreviewMode === 'edit' }"
          :title="t('editor.edit')"
          role="tab"
          :aria-selected="markdownPreviewMode === 'edit'"
          @click="setMdModeUi('edit')"
        >
          <PenLine :size="13" />
        </button>
      </div>
    </div>

    <Teleport to="body">
      <Transition name="ctx">
        <div
          v-if="tabCtx"
          class="tab-ctx"
          :style="{ left: `${tabCtx.x}px`, top: `${tabCtx.y}px` }"
          @click.stop
          @contextmenu.prevent
        >
          <button type="button" @click="runTabMenu('pin')">
            {{ tabCtxPinned ? t("editor.unpin") : t("editor.pin") }}
          </button>
          <button type="button" @click="runTabMenu('revealInOs')">
            {{ t("explorer.revealInOs") }}
          </button>
          <hr />
          <button type="button" @click="runTabMenu('close')">
            {{ t("editor.close") }}
          </button>
          <button
            type="button"
            :disabled="!tabCtxCanCloseOthers"
            @click="runTabMenu('closeOthers')"
          >
            {{ t("editor.closeOthers") }}
          </button>
          <button
            type="button"
            :disabled="!tabCtxCanCloseLeft"
            @click="runTabMenu('closeLeft')"
          >
            {{ t("editor.closeToTheLeft") }}
          </button>
          <button
            type="button"
            :disabled="!tabCtxCanCloseRight"
            @click="runTabMenu('closeRight')"
          >
            {{ t("editor.closeToTheRight") }}
          </button>
          <button
            type="button"
            :disabled="!tabCtxCanCloseAll"
            @click="runTabMenu('closeAll')"
          >
            {{ t("editor.closeAll") }}
          </button>
        </div>
      </Transition>
    </Teleport>

    <Teleport to="body">
      <Transition name="ctx">
        <div
          v-if="editorCtx"
          class="editor-ctx"
          :style="{ left: `${editorCtx.x}px`, top: `${editorCtx.y}px` }"
          @click.stop
          @contextmenu.prevent
        >
        <button
          type="button"
          :disabled="formatDocumentDisabled"
          @click="formatFromEditor"
        >
          {{ t("editor.formatDocument") }}
        </button>
        <template v-if="hasGitMenu">
          <hr />
          <button type="button" @click="showDiffFromEditor">{{ t("editor.showDiff") }}</button>
          <button type="button" @click="toggleBlameFromEditor">
            {{ blameVisible ? t("editor.blameHide") : t("editor.blameShow") }}
          </button>
          <button
            v-if="canDiscardActive"
            type="button"
            class="danger"
            @click="discardFromEditor"
          >
            {{ t("editor.discardChanges") }}
          </button>
        </template>
        </div>
      </Transition>
    </Teleport>

  </section>
</template>

<style scoped>
.editor-area {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-editor);
}

.tabs {
  height: 34px;
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  gap: 0;
  padding: 0 6px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-header);
  overflow: hidden;
}

.tabs-scroll {
  /* 兼作离场标签（.tab-leave-active 绝对定位）的包含块与 offsetParent：
     保证 onTabBeforeLeave 记录的 offsetLeft/offsetTop 就是 left/top 的坐标系原值 */
  position: relative;
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  align-items: flex-end;
  gap: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none; /* Firefox */
  -ms-overflow-style: none; /* IE/旧 Edge */
}

.tabs-scroll::-webkit-scrollbar {
  display: none; /* Chromium / WebKit */
  width: 0;
  height: 0;
}

/* 右侧固定标签区：推到最右、不被文件标签挤压 */
.tabs-fixed {
  margin-left: auto;
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  gap: 0;
  max-width: 45%;
  min-width: 0;
  overflow: hidden;
}

.tabs-fixed .tab,
.tabs-fixed .preview-toggle {
  flex-shrink: 0;
}

.tab {
  position: relative;
  height: 30px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 7px 0 8px;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  color: var(--text-muted);
  font-size: 12px;
  max-width: 240px;
  transition: color var(--transition-fast), background var(--transition-fast);
}

/* 底部 active 指示条：单时间轴（统一 --transition-medium） */
.tab::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--accent);
  opacity: 0;
  transform: scaleX(0.4);
  transform-origin: center;
  transition: opacity var(--transition-medium) var(--ease-out),
    transform var(--transition-medium) var(--ease-out);
}

.tab:has(.name.disambiguated) {
  max-width: 300px;
}

.tab:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.tab.active {
  color: var(--text-primary);
  background: var(--bg-editor);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--accent) 35%, transparent);
}

/* 未保存状态用左侧短标记表达，避免在文件名之前放空心圆点 */
.tab.dirty {
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 72%, transparent);
}

.tab.active.dirty {
  box-shadow:
    inset 2px 0 0 var(--accent),
    inset 0 1px 0 color-mix(in srgb, var(--accent) 35%, transparent);
}

.tab.active::after {
  opacity: 1;
  transform: scaleX(1);
}

/* TransitionGroup：标签进出场过渡。
   进出场用 animation（动画事件丢失时元素保持可见，不会出现标签隐形）；
   move 必须保留 transition（位置补间需要持续过渡，且不涉及可见性）。 */
.tab-enter-active {
  animation: prism-tab-in 160ms var(--ease-out);
}
.tab-leave-active {
  animation: prism-tab-out 160ms var(--ease-out);
  /* 脱流以便相邻标签立即补位；left/top/width 由 onTabLeave 写回原位（见脚本注释） */
  position: absolute;
  /* 定宽 + 隐藏溢出：防止脱流后按内容重算宽度、挤动相邻标签的 FLIP 目标 */
  overflow: hidden;
  pointer-events: none;
}
@keyframes prism-tab-in {
  from {
    opacity: 0;
    transform: translateY(2px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes prism-tab-out {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
    transform: translateY(2px);
  }
}

.tab-move {
  transition: transform 180ms var(--ease-out);
}

.ssh-tab .ssh-icon,
.compare-tab .cmp-icon,
.gitlog-tab .gitlog-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.preview-toggle {
  flex-shrink: 0;
  margin-bottom: 4px;
  height: 26px;
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
}

.preview-toggle:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.tab-file-icon {
  flex-shrink: 0;
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.close {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  display: grid;
  place-items: center;
  opacity: 0;
  transition: opacity var(--transition-fast) var(--ease-out),
    background var(--transition-fast) var(--ease-out),
    color var(--transition-fast) var(--ease-out);
}

.tab:hover .close,
.tab.active .close {
  opacity: 1;
}

.close:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

/* 固定槽位：钉与关闭重叠，悬停只切换透明度，避免跳动 */
.tab-trailing {
  position: relative;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.tab-trailing .pin-icon,
.tab-trailing .close {
  position: absolute;
  inset: 0;
  margin: auto;
}

.pin-icon {
  color: var(--accent);
  opacity: 0.9;
  pointer-events: none;
}

.tab.pinned .close {
  opacity: 0;
  pointer-events: none;
}

.tab.pinned:hover .close,
.tab.pinned.active:hover .close {
  opacity: 1;
  pointer-events: auto;
}

.tab.pinned:hover .pin-icon,
.tab.pinned.active:hover .pin-icon {
  opacity: 0;
}

.canvas {
  flex: 1;
  min-height: 0;
  position: relative;
  height: 100%;
  overflow: hidden;
}

/* 画布全部直接子视图（SSH/GitLog/Compare/编辑器/welcome）统一绝对定位叠放：
   同时过渡模式下新旧分支共存，靠 z-index 分层（enter 在上）。
   旧视图即使动画卡住留在 DOM，也被上层新视图盖住，不影响显示与操作。
   .md-mode-toggle / .md-find-panel 是浮层，自带 absolute 定位，不进全屏叠放。 */
.canvas > :not(.md-mode-toggle):not(.md-find-panel) {
  position: absolute;
  inset: 0;
}

.canvas > :deep(.log-panel) {
  height: 100%;
}

/* canvas-fade：v-show 视图（sessions/ssh/gitlog/compare）显隐淡入淡出。
   用 animation 而非 transition：WKWebView 空闲恢复时 rAF/动画事件可能丢失，
   transition 会把元素永久卡在 enter-from（opacity 0 = 黑屏）；
   animation 不播放时元素回到自身样式（可见），不会黑屏。 */
.canvas-fade-enter-active {
  animation: prism-canvas-fade-in var(--transition-medium) var(--ease-out);
}
.canvas-fade-leave-active {
  animation: prism-canvas-fade-out var(--transition-medium) var(--ease-out);
}
@keyframes prism-canvas-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes prism-canvas-fade-out {
  from { opacity: 1; }
  to { opacity: 0; }
}

/* canvas-stack：CompareView TransitionGroup 容器——叠放所有 compare 实例（v-show 切换） */
.canvas-stack {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.canvas-stack > * {
  pointer-events: auto;
  height: 100%;
}

/* canvas：互斥视图（CM/Image/md/welcome）交叉淡化 + 轻微上移。
   用 animation 而非 transition（理由同 canvas-fade）：动画事件/rAF 丢失时
   元素回到自身样式（opacity 1）保持可见，杜绝「标签已打开但编辑区黑屏」。
   同时模式下 enter 元素压在上层（z 2），leave 元素在下层（z 1）。 */
.canvas-enter-active {
  animation: prism-canvas-in var(--transition-slow) var(--ease-out);
  z-index: 2;
}
.canvas-leave-active {
  animation: prism-canvas-out var(--transition-fast) var(--ease-out);
  z-index: 1;
  /* 离场视图不接收交互：动画卡住残留时也不能挡住新视图 */
  pointer-events: none;
}
@keyframes prism-canvas-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes prism-canvas-out {
  from {
    opacity: 1;
    transform: translateY(0);
  }
  to {
    opacity: 0;
    transform: translateY(-2px);
  }
}

/* ctx：tab-ctx / editor-ctx 右键菜单 popover。
   同 canvas：用 animation，动画事件丢失时菜单仍可见可点（transparent 也不挡点击）。 */
.ctx-enter-active {
  animation: prism-ctx-in var(--transition-medium) var(--ease-out);
}
.ctx-leave-active {
  animation: prism-ctx-out var(--transition-fast) var(--ease-out);
}
@keyframes prism-ctx-in {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
@keyframes prism-ctx-out {
  from {
    opacity: 1;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(0.98);
  }
}

/* welcome 内部按钮 hover 平滑（之前是硬切） */
.welcome .cta,
.welcome .ghost {
  transition: background var(--transition-fast) var(--ease-out),
    color var(--transition-fast) var(--ease-out),
    border-color var(--transition-fast) var(--ease-out),
    transform var(--transition-fast) var(--ease-out),
    box-shadow var(--transition-fast) var(--ease-out);
}
.welcome .cta:hover {
  box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 25%, transparent);
}
.welcome .ghost:hover {
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-elevated));
  border-color: var(--accent);
  color: var(--accent);
}

/* ==================== Markdown 预览（Cursor 风格） ====================
   容器负责滚动；右上角 Segmented Control 定位在外层 .canvas 内。
   内容由 .md-preview-content 渲染。
   全部用 var(--*)，4 主题一次到位；正文 --text-primary 不再降到 secondary。 */
.md-preview {
  position: relative;
  height: 100%;
  overflow: auto;
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: var(--font-size-md);   /* 13px，紧凑 */
  line-height: 1.65;               /* 段落 1.65，从原 1.7 微降 */
  /* body 全局 user-select:none（应用型 UI 防误选）；预览是只读内容区，
     恢复文本选择以支持「选中 + ⌘C 复制」（与 CodeMirror 编辑区同策略） */
  user-select: text;
  -webkit-user-select: text;
}
.md-preview-content {
  /* 顶部多 48px 留给编辑内容区内的 Segmented Control；左右宽松；底部留 40vh 滚动余量 */
  padding: 48px 64px 40vh;
  max-width: 920px;
  margin: 0 auto;
}

/* 标题：分级 + 上下边距 */
.md-preview-content :deep(h1) {
  font-size: 28px;
  font-weight: 700;
  margin: 0 0 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-primary);
  letter-spacing: -0.01em;
}
.md-preview-content :deep(h2) {
  font-size: 22px;
  font-weight: 600;
  margin: 32px 0 12px;
  color: var(--text-primary);
  letter-spacing: -0.005em;
}
.md-preview-content :deep(h3) {
  font-size: 18px;
  font-weight: 600;
  margin: 24px 0 8px;
  color: var(--text-primary);
}
.md-preview-content :deep(h4) {
  font-size: 15px;
  font-weight: 600;
  margin: 20px 0 8px;
  color: var(--text-primary);
}
.md-preview-content :deep(h5),
.md-preview-content :deep(h6) {
  font-size: 13px;
  font-weight: 600;
  margin: 16px 0 8px;
  color: var(--text-secondary);
}

/* 段落：正文不再降级为 secondary */
.md-preview-content :deep(p) {
  margin: 0 0 12px;
  color: var(--text-primary);
}

/* 列表：黑点 / 数字 + 紧凑 */
.md-preview-content :deep(ul),
.md-preview-content :deep(ol) {
  padding-left: 1.6em;
  margin: 0 0 12px;
  color: var(--text-primary);
}
.md-preview-content :deep(ul) { list-style: disc; }
.md-preview-content :deep(ul ul) { list-style: circle; margin: 4px 0; }
.md-preview-content :deep(ul ul ul) { list-style: square; }
.md-preview-content :deep(ol) { list-style: decimal; }
.md-preview-content :deep(li) {
  margin: 4px 0;
  color: var(--text-primary);
}
.md-preview-content :deep(li > p) { margin: 4px 0; }

/* 任务列表（GFM）：方框标记 */
.md-preview-content :deep(input[type="checkbox"]) {
  margin-right: 6px;
  accent-color: var(--accent);
}

/* 引用：左边线 + 灰文本 */
.md-preview-content :deep(blockquote) {
  margin: 0 0 12px;
  padding: 4px 0 4px 14px;
  border-left: 3px solid var(--border-subtle);
  color: var(--text-secondary);
}
.md-preview-content :deep(blockquote > :last-child) { margin-bottom: 0; }

/* 行内代码：accent 软色 + accent 字色 */
.md-preview-content :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.92em;
  background: var(--accent-soft);
  color: var(--accent);
  padding: 1px 5px;
  border-radius: 4px;
}

/* 代码块：深底 + 圆角 + 横向溢出 */
.md-preview-content :deep(pre) {
  background: var(--bg-panel);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 12px 14px;
  margin: 0 0 12px;
  overflow: auto;
  line-height: 1.5;
  font-size: 12.5px;
}
.md-preview-content :deep(pre code) {
  background: none;
  color: var(--text-primary);
  padding: 0;
  font-size: inherit;
  border-radius: 0;
}

/* 链接：accent 色 + 半透下划线，hover 实化 */
.md-preview-content :deep(a) {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
}
.md-preview-content :deep(a:hover) {
  border-bottom-color: var(--accent);
}

/* 表格 */
.md-preview-content :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0 0 12px;
  font-size: 12.5px;
}
.md-preview-content :deep(th),
.md-preview-content :deep(td) {
  padding: 6px 12px;
  border: 1px solid var(--border-subtle);
  text-align: left;
  color: var(--text-primary);
}
.md-preview-content :deep(th) {
  background: var(--bg-panel);
  font-weight: 600;
}

/* 分割线 */
.md-preview-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--border-subtle);
  margin: 24px 0;
}

/* 图片 */
.md-preview-content :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
}

/* 强调（粗体 / 斜体 / 删除线） */
.md-preview-content :deep(strong) { font-weight: 600; color: var(--text-primary); }
.md-preview-content :deep(em) { font-style: italic; }
.md-preview-content :deep(del) { color: var(--text-muted); }

/* ==================== 代码块高亮（自研 5 类 token） ==================== */
.md-preview-content :deep(.tk-keyword) { color: #c586c0; }
.md-preview-content :deep(.tk-string)  { color: #ce9178; }
.md-preview-content :deep(.tk-comment) { color: #6a9955; font-style: italic; }
.md-preview-content :deep(.tk-number)  { color: #b5cea8; }
.md-preview-content :deep(.tk-type)    { color: #4ec9b0; }

/* 浅色主题（dawn）调亮 token 色，遵循 --accent 调性 */
[data-theme="dawn"] .md-preview-content :deep(.tk-keyword) { color: #af00db; }
[data-theme="dawn"] .md-preview-content :deep(.tk-string)  { color: #a31515; }
[data-theme="dawn"] .md-preview-content :deep(.tk-comment) { color: #008000; }
[data-theme="dawn"] .md-preview-content :deep(.tk-number)  { color: #098658; }
[data-theme="dawn"] .md-preview-content :deep(.tk-type)    { color: #267f99; }
/* ==================== MD 预览内查找 ====================
   浮层复用 .canvas 绝对定位（与 Segmented Control 同层，不进 canvas 过渡）；
   控件尺寸/配色对齐 CM 查找面板（.prism-find-*），只读故无替换行。 */
.md-find-panel {
  position: absolute;
  top: 10px;
  right: 76px;
  width: min(520px, calc(100% - 104px));
  padding: 6px 8px;
  border-radius: 10px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-modal);
  z-index: 6;
  transform-origin: top right;
  animation: prism-popover-in var(--transition-medium) var(--ease-out) both;
}
.md-find-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.md-find-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-app);
  color: var(--text-primary);
  font-size: 12px;
  transition: border-color var(--transition-fast) var(--ease-out),
    box-shadow var(--transition-fast) var(--ease-out);
}
.md-find-input:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border-subtle));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-soft) 70%, transparent);
}
.md-find-count {
  flex: 0 0 auto;
  min-width: 52px;
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
  white-space: nowrap;
}
.md-find-btn {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1;
  display: grid;
  place-items: center;
  transition: background var(--transition-fast) var(--ease-out),
    color var(--transition-fast) var(--ease-out);
}
.md-find-btn:hover {
  background: var(--accent-soft);
  color: var(--text-primary);
}
.md-find-btn.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.md-find-btn.md-find-toggle {
  font-size: 11px;
  font-weight: 600;
}
/* 命中：弱高亮；当前命中：强高亮 + 描边（对齐 .cm-searchMatch(-selected)） */
.md-preview-content :deep(mark.md-find-match) {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
.md-preview-content :deep(mark.md-find-match.is-current) {
  background: color-mix(in srgb, var(--accent) 55%, transparent);
  outline: 1px solid color-mix(in srgb, var(--accent) 70%, transparent);
}

/* ==================== MD 预览/编辑右上角 Segmented Control ====================
   absolute 锚定到 .canvas 右上角，编辑模式与预览模式均可见 */
.md-mode-toggle {
  position: absolute;
  top: 12px;
  right: 16px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-popover);
  z-index: 5;
}
.md-mode-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 6px;
  cursor: pointer;
  transition: background var(--transition-fast) var(--ease-out),
    color var(--transition-fast) var(--ease-out);
}
.md-mode-btn:hover {
  color: var(--text-primary);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.md-mode-btn.active {
  background: var(--accent-soft);
  color: var(--accent);
}

.welcome {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-secondary);
}

.welcome h1 {
  margin: 0;
  font-size: 26px;
  letter-spacing: -0.025em;
  color: var(--text-primary);
}

.welcome p {
  margin: 0;
}

.actions {
  margin-top: 16px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.cta {
  height: 34px;
  padding: 0 16px;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--accent-fg);
  font-weight: 600;
  box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 22%, transparent);
}

.ghost {
  height: 32px;
  padding: 0 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  background: var(--bg-inset);
}

.ghost:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.editor-ctx {
  position: fixed;
  z-index: 80;
  min-width: 160px;
  padding: 4px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
}

.editor-ctx button {
  text-align: left;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-primary);
}

.editor-ctx button:hover:not(:disabled) {
  background: var(--accent-soft);
}

.editor-ctx button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.editor-ctx hr {
  border: none;
  border-top: 1px solid var(--border-subtle);
  margin: 4px 0;
}

.editor-ctx .danger {
  color: var(--danger);
}

.tab-ctx {
  position: fixed;
  z-index: 80;
  min-width: 168px;
  padding: 4px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
}

.tab-ctx button {
  text-align: left;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-primary);
}

.tab-ctx button:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent);
}

.tab-ctx button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.tab-ctx hr {
  border: none;
  border-top: 1px solid var(--border-subtle);
  margin: 4px 0;
}
</style>
