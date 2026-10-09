// ==================== jdt:// 反编译类只读标签 ====================
import { t } from "@/i18n";
import { currentJavaClient, ensureJavaSession } from "@/features/java/javaSession";
import { displayNameFromJdtUri, virtualSourceCommand } from "@/features/java/jdtls";
import { useEditorStore } from "@/stores/editor";
import { useWorkspaceStore } from "@/stores/workspace";

export async function openJavaVirtualClass(uri: string): Promise<void> {
  const editor = useEditorStore();
  const existing = editor.tabs.find((tab) => tab.virtual?.uri === uri || tab.path === uri);
  if (existing) {
    editor.activate(existing.path);
    return;
  }
  const ready = await ensureJavaSession("file-open");
  const client = currentJavaClient();
  if (!ready || !client) {
    useWorkspaceStore().showNotice(t("java.notice.decompileFailed"));
    return;
  }
  try {
    const content = await client.request("workspace/executeCommand", virtualSourceCommand(uri));
    if (typeof content !== "string" || !content) {
      useWorkspaceStore().showNotice(t("java.notice.decompileFailed"));
      return;
    }
    editor.openVirtualTab(uri, displayNameFromJdtUri(uri), content, "Java");
  } catch {
    useWorkspaceStore().showNotice(t("java.notice.decompileFailed"));
  }
}
