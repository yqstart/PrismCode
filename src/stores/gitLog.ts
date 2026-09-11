import { computed, ref } from "vue";
import { defineStore } from "pinia";

const GIT_LOG_TAB_ID = "prism://git-log";

/**
 * Git Log / Graph：作为编辑区标签打开（对齐 VS Code Git Graph 入口形态），
 * 不再使用底栏工具窗口。
 */
export const useGitLogStore = defineStore("gitLog", () => {
  const open = ref(false);
  const focused = ref(false);
  /** 当前选中的提交完整 OID */
  const selectedId = ref<string | null>(null);

  const tabId = GIT_LOG_TAB_ID;
  const isFocused = computed(() => open.value && focused.value);

  function blurPeers() {
    void import("@/stores/sessions").then(({ useSessionsStore }) => {
      useSessionsStore().blurSessions();
    });
    void import("@/stores/compare").then(({ useCompareStore }) => {
      useCompareStore().blurCompare();
    });
  }

  function openLog() {
    open.value = true;
    focused.value = true;
    blurPeers();
  }

  function closeLog() {
    open.value = false;
    focused.value = false;
    selectedId.value = null;
  }

  function toggleLog() {
    if (open.value && focused.value) {
      closeLog();
      return;
    }
    openLog();
  }

  function focusLog() {
    if (!open.value) return;
    focused.value = true;
    blurPeers();
  }

  function blurLog() {
    focused.value = false;
  }

  function selectCommit(id: string | null) {
    selectedId.value = id;
  }

  return {
    open,
    focused,
    selectedId,
    tabId,
    isFocused,
    openLog,
    closeLog,
    toggleLog,
    focusLog,
    blurLog,
    selectCommit,
  };
});
