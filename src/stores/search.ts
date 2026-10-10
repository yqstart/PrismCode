import { ref } from "vue";
import { defineStore } from "pinia";
import {
  replaceInFiles,
  searchContent,
  searchFiles,
  type ContentHit,
  type FileSearchHit,
  type ReplaceResult,
} from "@/shared/searchApi";
import { useWorkspaceStore } from "@/stores/workspace";

/** Search Everywhere 分组模式：全部 / 文件 / 符号 / 动作 */
export type SearchEverywhereMode = "all" | "files" | "symbols" | "actions";

export const useSearchStore = defineStore("search", () => {
  const fileQuery = ref("");
  const contentQuery = ref("");
  const replaceText = ref("");
  const caseSensitive = ref(false);
  const extensions = ref("");
  const fileResults = ref<FileSearchHit[]>([]);
  const contentResults = ref<ContentHit[]>([]);
  const replacePreview = ref<ReplaceResult | null>(null);
  const loading = ref(false);
  const quickOpenVisible = ref(false);
  const findInFilesVisible = ref(false);
  // Search Everywhere（IDEA 风格弹层）：可见性、分组模式与输入内容都由 store 托管，
  // 组件只负责渲染与键盘交互；输入内容在打开时清空、关闭时不保留。
  const searchEverywhereVisible = ref(false);
  const searchEverywhereMode = ref<SearchEverywhereMode>("all");
  const searchEverywhereQuery = ref("");
  // 请求序号：只应用最后一次发起的搜索，丢弃过期（被后续搜索/关闭覆盖）的结果
  let contentSearchSeq = 0;
  let fileSearchSeq = 0;
  let replaceSeq = 0;
  const SEARCH_SUPERSEDED = "__MIROCODE_SEARCH_SUPERSEDED__";

  function isSupersededSearch(error: unknown): boolean {
    return (
      error instanceof Error ? error.message : String(error)
    ) === SEARCH_SUPERSEDED;
  }

  function parseExtensions(): string[] | undefined {
    const raw = extensions.value.trim();
    if (!raw) return undefined;
    return raw
      .split(/[,;\s]+/)
      .map((s) => s.trim().replace(/^\./, ""))
      .filter(Boolean);
  }

  /** 带超时的 race，返回清理函数。调用方必须在 finally 调 clear，
   * 这样 IPC 成功、失败、超时和序号过期都不会残留 timer。 */
  function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
    let timer: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(message)), ms);
    });
    return {
      promise: Promise.race([promise, timeout]),
      clear: () => {
        if (timer !== undefined) {
          window.clearTimeout(timer);
          timer = undefined;
        }
      },
    };
  }

  async function runFileSearch(query?: string) {
    const workspace = useWorkspaceStore();
    if (!workspace.rootPath) return;
    const q = (query ?? fileQuery.value).trim();
    const seq = ++fileSearchSeq;
    if (!q) {
      fileResults.value = [];
      loading.value = false;
      return;
    }
    // 请求序号：快速输入时只保留最后一次的响应，旧的返回直接丢弃
    const root = workspace.rootPath;
    loading.value = true;
    const guard = withTimeout(
      searchFiles(workspace.rootPath, q, {
        maxResults: 50,
        extraIgnores: workspace.extraIgnores,
        extensions: parseExtensions(),
      }),
      15_000,
      "搜索超时（15s），请缩小范围或重试",
    );
    try {
      const result = await guard.promise;
      // 已有更新的搜索，或期间切换了工作区：丢弃过期结果
      if (seq !== fileSearchSeq || workspace.rootPath !== root) return;
      fileResults.value = result;
    } catch (error) {
      if (seq !== fileSearchSeq || isSupersededSearch(error)) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    } finally {
      guard.clear();
      if (seq === fileSearchSeq) loading.value = false;
    }
  }

  async function runContentSearch() {
    const workspace = useWorkspaceStore();
    if (!workspace.rootPath) return;
    const q = contentQuery.value.trim();
    const seq = ++contentSearchSeq;
    if (!q) {
      contentResults.value = [];
      loading.value = false;
      return;
    }
    const root = workspace.rootPath;
    loading.value = true;
    const guard = withTimeout(
      searchContent(workspace.rootPath, q, {
        maxResults: 200,
        caseSensitive: caseSensitive.value,
        extraIgnores: workspace.extraIgnores,
        extensions: parseExtensions(),
        contextLines: 0,
      }),
      30_000,
      "搜索超时（30s），请缩小范围或重试",
    );
    try {
      const result = await guard.promise;
      // 若期间发起了新的搜索、已关闭或切换了工作区，丢弃本次过期结果
      if (seq !== contentSearchSeq || workspace.rootPath !== root) return;
      contentResults.value = result;
    } catch (error) {
      if (seq !== contentSearchSeq || isSupersededSearch(error)) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    } finally {
      guard.clear();
      if (seq === contentSearchSeq) loading.value = false;
    }
  }

  async function previewReplace() {
    const workspace = useWorkspaceStore();
    const root = workspace.rootPath;
    if (!root) return;
    const q = contentQuery.value.trim();
    if (!q) return;
    const seq = ++replaceSeq;
    loading.value = true;
    try {
      const result = await replaceInFiles(
        root,
        q,
        replaceText.value,
        {
          dryRun: true,
          caseSensitive: caseSensitive.value,
          extraIgnores: workspace.extraIgnores,
          extensions: parseExtensions(),
        },
      );
      if (seq !== replaceSeq || workspace.rootPath !== root) return;
      replacePreview.value = result;
    } catch (error) {
      if (seq !== replaceSeq || workspace.rootPath !== root) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    } finally {
      if (seq === replaceSeq && workspace.rootPath === root) {
        loading.value = false;
      }
    }
  }

  async function applyReplace() {
    const workspace = useWorkspaceStore();
    const root = workspace.rootPath;
    if (!root) return;
    const q = contentQuery.value.trim();
    if (!q) return;
    const seq = ++replaceSeq;
    loading.value = true;
    try {
      const result = await replaceInFiles(
        root,
        q,
        replaceText.value,
        {
          dryRun: false,
          caseSensitive: caseSensitive.value,
          extraIgnores: workspace.extraIgnores,
          extensions: parseExtensions(),
        },
      );
      if (seq !== replaceSeq || workspace.rootPath !== root) return;
      replacePreview.value = result;
      const skippedNote =
        (result.skippedLargeFiles ?? 0) > 0
          ? `，跳过 ${result.skippedLargeFiles} 个超 2MB 的大文件`
          : "";
      workspace.showNotice(
        `已替换 ${result.replacements} 处，涉及 ${result.changedFiles} 个文件${skippedNote}`,
      );
      await runContentSearch();
    } catch (error) {
      if (seq !== replaceSeq || workspace.rootPath !== root) return;
      workspace.showNotice(
        error instanceof Error ? error.message : String(error),
        3200,
      );
    } finally {
      if (seq === replaceSeq && workspace.rootPath === root) {
        loading.value = false;
      }
    }
  }

  function openQuickOpen() {
    findInFilesVisible.value = false;
    searchEverywhereVisible.value = false;
    invalidateFileSearch();
    quickOpenVisible.value = true;
    fileQuery.value = "";
  }

  function closeQuickOpen() {
    invalidateFileSearch();
    quickOpenVisible.value = false;
  }

  /** 输入框变化或组件销毁时使旧文件搜索失效，避免旧结果重新填回界面。 */
  function invalidateFileSearch() {
    fileSearchSeq += 1;
    fileResults.value = [];
    loading.value = false;
  }

  function openFindInFiles() {
    quickOpenVisible.value = false;
    searchEverywhereVisible.value = false;
    // 每次打开都重置状态，避免上次卡住的 loading / 残留结果影响体验
    fileSearchSeq += 1;
    invalidateFindInFiles();
    findInFilesVisible.value = true;
  }

  function closeFindInFiles() {
    findInFilesVisible.value = false;
    // 使进行中的搜索结果失效 + 重置 loading
    invalidateFindInFiles();
  }

  /**
   * 打开 Search Everywhere 弹层：清空输入并切到指定分组。
   * 同一时刻只保留一个搜索弹层，因此顺手收起 QuickOpen / 在文件中查找。
   */
  function openSearchEverywhere(mode: SearchEverywhereMode = "all") {
    quickOpenVisible.value = false;
    findInFilesVisible.value = false;
    invalidateFileSearch();
    searchEverywhereMode.value = mode;
    searchEverywhereQuery.value = "";
    searchEverywhereVisible.value = true;
  }

  /** 关闭 Search Everywhere：输入与在途文件搜索一并作废，下次打开不残留旧结果 */
  function closeSearchEverywhere() {
    searchEverywhereVisible.value = false;
    searchEverywhereQuery.value = "";
    invalidateFileSearch();
  }

  /** 查询条件变化时使旧搜索/替换结果失效，避免旧请求回写新条件的结果。 */
  function invalidateFindInFiles() {
    contentSearchSeq += 1;
    replaceSeq += 1;
    loading.value = false;
    contentResults.value = [];
    replacePreview.value = null;
  }

  function clearResults() {
    fileResults.value = [];
    contentResults.value = [];
    replacePreview.value = null;
    // 使进行中的搜索结果失效（文件搜索与内容搜索都要失效，
    // 否则工作区切换后旧工作区的在途结果仍会写回）
    fileSearchSeq += 1;
    contentSearchSeq += 1;
    replaceSeq += 1;
    loading.value = false;
  }

  return {
    fileQuery,
    contentQuery,
    replaceText,
    caseSensitive,
    extensions,
    fileResults,
    contentResults,
    replacePreview,
    loading,
    quickOpenVisible,
    findInFilesVisible,
    searchEverywhereVisible,
    searchEverywhereMode,
    searchEverywhereQuery,
    runFileSearch,
    runContentSearch,
    previewReplace,
    applyReplace,
    openQuickOpen,
    closeQuickOpen,
    invalidateFileSearch,
    invalidateFindInFiles,
    openFindInFiles,
    closeFindInFiles,
    openSearchEverywhere,
    closeSearchEverywhere,
    clearResults,
  };
});
