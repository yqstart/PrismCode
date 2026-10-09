import { ref } from "vue";
import { defineStore } from "pinia";

/** 设置面板分区标识 */
export type SettingsNav = "editor" | "java" | "shortcuts" | "system";

export const useUiStore = defineStore("ui", () => {
  const settingsOpen = ref(false);
  /** 设置面板当前分区（打开时可指定，供外部快速定位） */
  const settingsNav = ref<SettingsNav>("editor");

  function openSettings(nav?: SettingsNav) {
    if (nav) settingsNav.value = nav;
    settingsOpen.value = true;
  }

  function closeSettings() {
    settingsOpen.value = false;
  }

  function toggleSettings() {
    settingsOpen.value = !settingsOpen.value;
  }

  return {
    settingsOpen,
    settingsNav,
    openSettings,
    closeSettings,
    toggleSettings,
  };
});
