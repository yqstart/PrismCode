<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "@/i18n";
import { PLAIN_INPUT_ATTRS } from "@/shared/plainInput";
import { useGitStore } from "@/stores/git";
import { useWorkspaceStore } from "@/stores/workspace";

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();

const { t } = useI18n();
const git = useGitStore();
const workspace = useWorkspaceStore();
const { branches, snapshot, loading } = storeToRefs(git);

const filter = ref("");
const filterRef = ref<HTMLInputElement | null>(null);
const ctxMenuRef = ref<HTMLElement | null>(null);
const selected = ref<string | null>(null);
const ctx = ref<{ x: number; y: number; name: string; isRemote: boolean } | null>(
  null,
);

const localBranches = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return branches.value
    .filter((b) => !b.isRemote)
    .filter((b) => !q || b.name.toLowerCase().includes(q));
});

const remoteBranches = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return branches.value
    .filter((b) => b.isRemote)
    .filter((b) => !q || b.name.toLowerCase().includes(q));
});

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      ctx.value = null;
      selected.value = null;
      return;
    }
    filter.value = "";
    if (workspace.rootPath) await git.refresh();
    await nextTick();
    filterRef.value?.focus();
  },
);

function close() {
  emit("close");
}

function selectRow(name: string) {
  selected.value = name;
}

async function onCheckoutLocal(name: string) {
  close();
  await git.checkout(name);
}

async function onCheckoutRemote(name: string) {
  close();
  await git.checkoutRemote(name);
}

function clampCtxPosition(x: number, y: number, width: number, height: number) {
  const pad = 8;
  let nextX = x;
  let nextY = y;
  if (nextX + width > window.innerWidth - pad) {
    nextX = Math.max(pad, window.innerWidth - width - pad);
  }
  if (nextY + height > window.innerHeight - pad) {
    const above = y - height;
    nextY = above >= pad ? above : Math.max(pad, window.innerHeight - height - pad);
  }
  return {
    x: Math.max(pad, nextX),
    y: Math.max(pad, nextY),
  };
}

function onCtx(event: MouseEvent, name: string, isRemote: boolean) {
  event.preventDefault();
  selected.value = name;
  ctx.value = { x: event.clientX, y: event.clientY, name, isRemote };
  void nextTick(() => {
    if (!ctx.value || !ctxMenuRef.value) return;
    const rect = ctxMenuRef.value.getBoundingClientRect();
    const pos = clampCtxPosition(ctx.value.x, ctx.value.y, rect.width, rect.height);
    if (pos.x !== ctx.value.x || pos.y !== ctx.value.y) {
      ctx.value = { ...ctx.value, x: pos.x, y: pos.y };
    }
  });
}

async function onNew() {
  close();
  const { promptInput } = await import("@/shared/promptDialog");
  const name = await promptInput({
    title: t("branches.newTitle"),
    label: t("branches.newLabel"),
    placeholder: "feature/my-branch",
    confirmText: t("branches.newConfirm"),
  });
  if (!name?.trim()) return;
  await git.createBranch(name.trim(), true);
}

async function onRename(target?: string) {
  const current = target ?? selected.value ?? snapshot.value.branch;
  if (!current) {
    workspace.showNotice(t("branches.selectToRename"));
    return;
  }
  const info = branches.value.find((b) => b.name === current);
  if (info?.isRemote) {
    workspace.showNotice(t("branches.selectLocalToRename"));
    return;
  }
  ctx.value = null;
  close();
  const { promptInput } = await import("@/shared/promptDialog");
  const name = await promptInput({
    title: t("branches.renameTitle"),
    label: t("branches.renameLabel"),
    defaultValue: current,
    confirmText: t("branches.renameConfirm"),
  });
  if (!name?.trim() || name.trim() === current) return;
  await git.renameBranch(current, name.trim());
}

async function onDelete(name?: string) {
  const target = name ?? selected.value;
  if (!target) {
    workspace.showNotice(t("branches.selectToDelete"));
    return;
  }
  const info = branches.value.find((b) => b.name === target);
  ctx.value = null;
  close();
  if (info?.isRemote) {
    await git.deleteRemoteBranch(target);
    return;
  }
  if (info?.isHead) {
    workspace.showNotice(t("branches.cannotDeleteCurrent"));
    return;
  }
  await git.deleteBranch(target);
}

async function onMerge(name: string) {
  ctx.value = null;
  close();
  // 仅去掉 origin/ 前缀；本地分支名可能自带斜杠（feature/foo），
  // slice(1) 会把它们误截断成 foo 导致合并找不到分支
  const localName = name.startsWith("origin/") ? name.slice("origin/".length) : name;
  await git.mergeBranch(localName);
}

async function onRebase(name: string) {
  ctx.value = null;
  close();
  await git.rebaseBranch(name);
}

async function onCompare(name: string) {
  ctx.value = null;
  close();
  await git.compareBranchWithCurrent(name);
}

async function onSetUpstream(name: string) {
  ctx.value = null;
  close();
  const remotes = remoteBranches.value.map((b) => b.name);
  const { promptInput } = await import("@/shared/promptDialog");
  const upstream = await promptInput({
    title: t("branches.setUpstreamTitle"),
    label: t("branches.setUpstreamLabel"),
    defaultValue: remotes.find((r) => r.endsWith(`/${name}`)) ?? remotes[0] ?? "origin/main",
    placeholder: "origin/feature",
    confirmText: t("branches.setUpstreamConfirm"),
  });
  if (!upstream?.trim()) return;
  await git.setUpstream(name, upstream.trim());
}

async function onCopy(name: string) {
  ctx.value = null;
  try {
    await navigator.clipboard.writeText(name);
    workspace.showNotice(t("branches.copiedName"));
  } catch {
    workspace.showNotice(t("gitLog.copyFailed"));
  }
}

async function onInteractiveRebase(name: string) {
  ctx.value = null;
  close();
  const { openInteractiveRebase } = await import("@/shared/gitRebaseDialog");
  await openInteractiveRebase({ onto: name });
}

function onDoc(event: MouseEvent) {
  if (!ctx.value) return;
  const t = event.target as Node;
  const el = document.getElementById("prism-branches-ctx");
  if (el && !el.contains(t)) ctx.value = null;
}

onMounted(() => document.addEventListener("mousedown", onDoc));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDoc));
</script>

<template>
  <div v-if="open" class="overlay" @mousedown.self="close">
    <div class="panel" role="dialog" :aria-label="t('branches.title')" @click="ctx = null">
      <header class="head">
        <strong>{{ t("branches.title") }}</strong>
        <button type="button" class="x" @click="close">×</button>
      </header>
      <input
        ref="filterRef"
        v-model="filter"
        v-bind="PLAIN_INPUT_ATTRS"
        class="filter"
        type="text"
        :placeholder="t('branches.filterPlaceholder')"
        @keydown.escape.stop="close"
      />

      <div class="section">
        <div class="sec-title">{{ t("branches.local") }}</div>
        <button
          v-for="b in localBranches"
          :key="b.name"
          type="button"
          class="item"
          :class="{ head: b.isHead, selected: selected === b.name }"
          :title="b.upstream ? `${b.name} → ${b.upstream}` : b.name"
          @click="selectRow(b.name); onCheckoutLocal(b.name)"
          @contextmenu="onCtx($event, b.name, false)"
        >
          <span class="name">{{ b.name }}</span>
          <span v-if="b.upstream" class="up">{{ b.upstream }}</span>
        </button>
        <p v-if="!localBranches.length" class="empty">
          {{ loading ? t("common.loading") : t("branches.noLocal") }}
        </p>
      </div>

      <div class="section">
        <div class="sec-title">{{ t("branches.remote") }}</div>
        <button
          v-for="b in remoteBranches"
          :key="b.name"
          type="button"
          class="item"
          :class="{ selected: selected === b.name }"
          :title="b.name"
          @click="selectRow(b.name); onCheckoutRemote(b.name)"
          @contextmenu="onCtx($event, b.name, true)"
        >
          <span class="name">{{ b.name }}</span>
        </button>
        <p v-if="!remoteBranches.length" class="empty">{{ t("branches.noRemote") }}</p>
      </div>

      <div class="footer">
        <button type="button" class="link" @click="onNew">{{ t("branches.newBranch") }}</button>
        <button type="button" class="link" @click="onRename()">{{ t("branches.rename") }}</button>
        <button type="button" class="link danger" @click="onDelete()">
          {{ t("branches.delete") }}
        </button>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="ctx"
        id="prism-branches-ctx"
        ref="ctxMenuRef"
        class="ctx"
        :style="{ left: `${ctx.x}px`, top: `${ctx.y}px` }"
        @click.stop
      >
        <button
          v-if="!ctx.isRemote"
          type="button"
          @click="onCheckoutLocal(ctx.name)"
        >
          {{ t("branches.checkout") }}
        </button>
        <button v-else type="button" @click="onCheckoutRemote(ctx.name)">
          {{ t("branches.checkoutAsLocal") }}
        </button>
        <button type="button" @click="onMerge(ctx.name)">{{ t("branches.mergeIntoCurrent") }}</button>
        <button type="button" @click="onRebase(ctx.name)">{{ t("branches.rebaseCurrentOnto") }}</button>
        <button type="button" @click="onInteractiveRebase(ctx.name)">
          {{ t("branches.interactiveRebaseOnto") }}
        </button>
        <button type="button" @click="onCompare(ctx.name)">{{ t("branches.compareWithCurrent") }}</button>
        <button
          v-if="!ctx.isRemote"
          type="button"
          @click="onSetUpstream(ctx.name)"
        >
          {{ t("branches.setUpstream") }}
        </button>
        <button
          v-if="!ctx.isRemote"
          type="button"
          @click="onRename(ctx.name)"
        >
          {{ t("branches.rename") }}
        </button>
        <button type="button" @click="onCopy(ctx.name)">{{ t("branches.copyName") }}</button>
        <button
          v-if="!ctx.isRemote && !branches.find((b) => b.name === ctx!.name)?.isHead"
          type="button"
          class="danger"
          @click="onDelete(ctx.name)"
        >
          {{ t("branches.delete") }}
        </button>
        <button
          v-if="ctx.isRemote"
          type="button"
          class="danger"
          @click="onDelete(ctx.name)"
        >
          {{ t("branches.deleteOnRemote") }}
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 75;
  background: transparent;
}
.panel {
  position: fixed;
  left: 12px;
  bottom: calc(var(--status-bar-height, 24px) + 8px);
  width: min(420px, calc(100vw - 24px));
  max-height: min(480px, 60vh);
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 6px;
  font-size: 13px;
}
.x {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--text-muted);
}
.x:hover {
  background: var(--accent-soft);
}
.filter {
  margin: 0 10px 8px;
  height: 30px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-app);
  color: var(--text-primary);
  font-size: 12px;
}
.section {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-bottom: 6px;
}
.sec-title {
  padding: 4px 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
}
.item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  text-align: left;
  font-size: 12px;
  color: var(--text-primary);
  min-width: 0;
  overflow: hidden;
}
.item:hover,
.item.selected {
  background: var(--accent-soft);
}
.item.head {
  color: var(--accent);
  font-weight: 600;
}
.name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.up {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 48%;
  margin-left: auto;
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty {
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-muted);
}
.footer {
  display: flex;
  gap: 10px;
  padding: 8px 12px;
  border-top: 1px solid var(--border-subtle);
}
.link {
  font-size: 12px;
  color: var(--accent);
}
.link:hover {
  text-decoration: underline;
}
.link.danger {
  color: var(--danger);
}
.ctx {
  position: fixed;
  z-index: 90;
  min-width: 200px;
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  padding: 4px;
  border-radius: 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
}
.ctx button {
  text-align: left;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-primary);
}
.ctx button:hover {
  background: var(--accent-soft);
}
.ctx button.danger {
  color: var(--danger);
}
</style>
