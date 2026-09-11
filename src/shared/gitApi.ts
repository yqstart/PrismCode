import { invoke } from "@tauri-apps/api/core";

/**
 * 慢 IPC 自动检测阈值（毫秒）
 * - 大于此值的 IPC 会主动通过 workspace.showNotice 弹一条 warning
 * - 不依赖 DevTools 截屏；用户直接在 UI 看到"哪条 IPC 慢/卡"
 * - 仅在开发模式生效，避免生产环境噪音
 */
const SLOW_IPC_THRESHOLD_MS = 2000;

/**
 * 统一的 IPC invoke 包装：
 * - dev 模式 console.time/timeEnd 记录每个命令耗时
 * - dev 模式自动检测 >2s 的 IPC 主动弹 warn notice（不依赖 DevTools 截屏）
 * - 显式标注命令名，方便排查"哪个 IPC 调用慢 / 卡"
 */
function ipc<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!import.meta.env.DEV) {
    return invoke<T>(cmd, args);
  }
  const label = `ipc:${cmd}`;
  const started = performance.now();
  console.time(label);
  return invoke<T>(cmd, args).finally(() => {
    const elapsed = performance.now() - started;
    console.timeEnd(label);
    if (elapsed > SLOW_IPC_THRESHOLD_MS) {
      // 主动弹 warn notice，告知用户"哪条 IPC 卡了 + 多少毫秒"
      // 走动态 import 避免循环依赖
      void import("@/stores/workspace")
        .then(({ useWorkspaceStore }) => {
          try {
            useWorkspaceStore().showNotice(
              `⚠ IPC 慢调用：${cmd} 耗时 ${Math.round(elapsed)}ms（> ${SLOW_IPC_THRESHOLD_MS}ms 阈值）`,
              6000,
            );
          } catch {
            /* store 未初始化时静默忽略 */
          }
        })
        .catch(() => {
          /* 静默 */
        });
    }
  });
}

export interface GitStatusEntry {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  conflicted: boolean;
}

export interface GitStatusSnapshot {
  initialized: boolean;
  branch: string | null;
  upstream: string | null;
  /** 当前 HEAD 提交短 id（无提交 / detached 场景为空） */
  head: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
  conflictCount: number;
}

export interface GitBranchInfo {
  name: string;
  isHead: boolean;
  isRemote: boolean;
  upstream: string | null;
}

export interface GitCommitInfo {
  id: string;
  summary: string;
  author: string;
  authorEmail: string;
  committer: string;
  committerEmail: string;
  time: string;
  body: string;
  files: string[];
  changes: GitFileChange[];
  parents: string[];
  refs: string[];
  unpushed: boolean;
}

export interface GitFileChange {
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed" | "copied" | "typechange" | string;
}

export interface GitTagInfo {
  name: string;
  target: string;
  annotated: boolean;
  tagger: string | null;
  time: string | null;
  message: string | null;
}

export interface GitDiffResult {
  path: string;
  patch: string;
}

export type ConflictStrategy = "ours" | "theirs" | "manual";

export async function gitStatus(root: string): Promise<GitStatusSnapshot> {
  return ipc("git_status", { root });
}

export async function gitInit(root: string): Promise<void> {
  return ipc("git_init", { root });
}

export async function gitSetRemote(
  root: string,
  name: string,
  url: string,
): Promise<void> {
  return ipc("git_set_remote", { root, name, url });
}

export async function gitStage(root: string, paths: string[]): Promise<void> {
  return ipc("git_stage", { root, paths });
}

export async function gitUnstage(root: string, paths: string[]): Promise<void> {
  return ipc("git_unstage", { root, paths });
}

export async function gitCommit(
  root: string,
  message: string,
  paths?: string[],
  amend?: boolean,
): Promise<void> {
  return ipc("git_commit", {
    root,
    message,
    paths,
    amend: amend ?? false,
  });
}

export async function gitBranches(root: string): Promise<GitBranchInfo[]> {
  return ipc("git_branches", { root });
}

export async function gitCheckout(
  root: string,
  name: string,
  force?: boolean,
): Promise<void> {
  return ipc("git_checkout", { root, name, force: force ?? false });
}

export async function gitCreateBranch(
  root: string,
  name: string,
  checkout: boolean,
): Promise<void> {
  return ipc("git_create_branch", { root, name, checkout });
}

export async function gitDeleteBranch(root: string, name: string): Promise<void> {
  return ipc("git_delete_branch", { root, name });
}

export async function gitRenameBranch(
  root: string,
  from: string,
  to: string,
): Promise<void> {
  return ipc("git_rename_branch", { root, from, to });
}

export async function gitLog(
  root: string,
  limit?: number,
): Promise<GitCommitInfo[]> {
  return ipc("git_log", { root, limit });
}

export async function gitTags(root: string): Promise<GitTagInfo[]> {
  return ipc("git_tags", { root });
}

export async function gitCommitFiles(
  root: string,
  leftRef: string,
  rightRef: string,
): Promise<GitFileChange[]> {
  return ipc("git_commit_files", { root, leftRef, rightRef });
}

export async function gitCreateTag(
  root: string,
  name: string,
  commitId: string,
  message?: string,
  force?: boolean,
): Promise<void> {
  return ipc("git_create_tag", {
    root,
    name,
    commitId,
    message: message ?? null,
    force: force ?? false,
  });
}

export async function gitDeleteTag(root: string, name: string): Promise<void> {
  return ipc("git_delete_tag", { root, name });
}

export async function gitPushTag(
  root: string,
  remote: string,
  name: string,
): Promise<string> {
  return ipc("git_push_tag", { root, remote, name });
}

export async function gitDiff(
  root: string,
  path?: string,
  staged?: boolean,
): Promise<GitDiffResult> {
  return ipc("git_diff", { root, path, staged });
}

export interface GitFileSides {
  path: string;
  left: string;
  right: string;
  leftLabel: string;
  rightLabel: string;
}

export interface GitConflictSides {
  path: string;
  base: string;
  ours: string;
  theirs: string;
  working: string;
}

export async function gitFileSides(
  root: string,
  path: string,
  staged?: boolean,
): Promise<GitFileSides> {
  return ipc("git_file_sides", { root, path, staged });
}

export async function gitConflictSides(
  root: string,
  path: string,
): Promise<GitConflictSides> {
  return ipc("git_conflict_sides", { root, path });
}

/** 取 HEAD 中该文件的文本（未跟踪/不存在返回空串），供编辑器行内改动条逐行 diff */
export async function gitHeadText(root: string, path: string): Promise<string> {
  return ipc("git_head_text", { root, path });
}

export async function gitPull(
  root: string,
  auth?: { username: string; password: string; remember?: boolean },
): Promise<string> {
  return ipc("git_pull", {
    root,
    username: auth?.username ?? null,
    password: auth?.password ?? null,
    remember: auth?.remember ?? null,
  });
}

export async function gitPush(
  root: string,
  force?: boolean,
  auth?: { username: string; password: string; remember?: boolean },
): Promise<string> {
  return ipc("git_push", {
    root,
    force: force ?? false,
    username: auth?.username ?? null,
    password: auth?.password ?? null,
    remember: auth?.remember ?? null,
  });
}

export async function gitStash(
  root: string,
  message?: string,
  includeUntracked?: boolean,
): Promise<void> {
  return ipc("git_stash", {
    root,
    message,
    includeUntracked: includeUntracked ?? false,
  });
}

export interface GitStashEntry {
  index: number;
  id: string;
  message: string;
}

export async function gitStashList(root: string): Promise<GitStashEntry[]> {
  return ipc("git_stash_list", { root });
}

export async function gitStashPop(root: string, index?: number): Promise<void> {
  return ipc("git_stash_pop", { root, index: index ?? null });
}

export async function gitStashApply(root: string, index: number): Promise<void> {
  return ipc("git_stash_apply", { root, index });
}

export async function gitStashDrop(root: string, index: number): Promise<void> {
  return ipc("git_stash_drop", { root, index });
}

export async function gitDiscardPaths(
  root: string,
  paths: string[],
): Promise<void> {
  return ipc("git_discard_paths", { root, paths });
}

export async function gitResetHard(root: string): Promise<void> {
  return ipc("git_reset_hard", { root });
}

export async function gitUndoCommit(root: string): Promise<void> {
  return ipc("git_undo_commit", { root });
}

export async function gitRevertTo(root: string, commitId: string): Promise<void> {
  return ipc("git_revert_to", { root, commitId });
}

export async function gitMergeBranch(root: string, name: string): Promise<string> {
  return ipc("git_merge_branch", { root, name });
}

export async function gitMergeAbort(root: string): Promise<string> {
  return ipc("git_merge_abort", { root });
}

export async function gitConflictFiles(root: string): Promise<string[]> {
  return ipc("git_conflict_files", { root });
}

export async function gitResolveConflict(
  root: string,
  path: string,
  strategy: ConflictStrategy,
): Promise<void> {
  return ipc("git_resolve_conflict", { root, path, strategy });
}

export interface GitRemoteInfo {
  name: string;
  url: string | null;
}

export interface GitBlameLine {
  line: number;
  commitId: string;
  author: string;
  time: string;
  summary: string;
}

export type GitAuthPayload = {
  username: string;
  password: string;
  remember?: boolean;
};

/** 查 Prism Code 已记住的 HTTPS 用户名（按远程 host） */
export async function gitStoredUsername(url: string): Promise<string | null> {
  return ipc("git_stored_username", { url });
}

export async function gitFetch(
  root: string,
  remote?: string,
  auth?: GitAuthPayload,
): Promise<string> {
  return ipc("git_fetch", {
    root,
    remote: remote ?? null,
    username: auth?.username ?? null,
    password: auth?.password ?? null,
    remember: auth?.remember ?? null,
  });
}

export async function gitUpdateProject(
  root: string,
  strategy: "merge" | "rebase",
  auth?: GitAuthPayload,
): Promise<string> {
  return ipc("git_update_project", {
    root,
    strategy,
    username: auth?.username ?? null,
    password: auth?.password ?? null,
    remember: auth?.remember ?? null,
  });
}

export async function gitRebaseBranch(root: string, onto: string): Promise<string> {
  return ipc("git_rebase_branch", { root, onto });
}

export interface GitRebaseStatus {
  inProgress: boolean;
  kind: string;
  headName: string | null;
  onto: string | null;
  conflicted: boolean;
}

export type GitRebaseAction = "pick" | "reword" | "squash" | "fix" | "drop";

export interface GitRebaseStep {
  action: GitRebaseAction | string;
  commitId: string;
  message?: string | null;
}

export async function gitRebaseStatus(root: string): Promise<GitRebaseStatus> {
  return ipc("git_rebase_status", { root });
}

export async function gitRebaseContinue(root: string): Promise<string> {
  return ipc("git_rebase_continue", { root });
}

export async function gitRebaseAbort(root: string): Promise<string> {
  return ipc("git_rebase_abort", { root });
}

export async function gitRebaseSkip(root: string): Promise<string> {
  return ipc("git_rebase_skip", { root });
}

export async function gitRebasePlan(
  root: string,
  onto: string,
): Promise<GitCommitInfo[]> {
  return ipc("git_rebase_plan", { root, onto });
}

export async function gitRebaseInteractive(
  root: string,
  onto: string,
  steps: GitRebaseStep[],
): Promise<string> {
  return ipc("git_rebase_interactive", { root, onto, steps });
}

export async function gitCherryPick(root: string, commitId: string): Promise<string> {
  return ipc("git_cherry_pick", { root, commitId });
}

export async function gitReset(
  root: string,
  commitId: string,
  mode: "soft" | "mixed" | "hard",
): Promise<string> {
  return ipc("git_reset", { root, commitId, mode });
}

export async function gitBlame(root: string, path: string): Promise<GitBlameLine[]> {
  return ipc("git_blame", { root, path });
}

export async function gitRemotes(root: string): Promise<GitRemoteInfo[]> {
  return ipc("git_remotes", { root });
}

export async function gitUnpushedCommits(
  root: string,
  limit?: number,
): Promise<GitCommitInfo[]> {
  return ipc("git_unpushed_commits", { root, limit });
}

export async function gitSetUpstream(
  root: string,
  branch: string,
  upstream: string,
): Promise<void> {
  return ipc("git_set_upstream", { root, branch, upstream });
}

export async function gitCheckoutRemote(
  root: string,
  remoteRef: string,
  localName?: string,
): Promise<string> {
  return ipc("git_checkout_remote", {
    root,
    remoteRef,
    localName: localName ?? null,
  });
}

export async function gitRevertCommit(
  root: string,
  commitId: string,
): Promise<string> {
  return ipc("git_revert_commit", { root, commitId });
}

export async function gitCreateBranchAt(
  root: string,
  name: string,
  commitId: string,
  checkout: boolean,
): Promise<void> {
  return ipc("git_create_branch_at", { root, name, commitId, checkout });
}

export async function gitCheckoutCommit(
  root: string,
  commitId: string,
): Promise<string> {
  return ipc("git_checkout_commit", { root, commitId });
}

export async function gitDeleteRemoteBranch(
  root: string,
  remoteRef: string,
): Promise<string> {
  return ipc("git_delete_remote_branch", { root, remoteRef });
}

export async function gitBranchSides(
  root: string,
  leftRef: string,
  rightRef: string,
  path?: string,
): Promise<GitFileSides> {
  return ipc("git_branch_sides", {
    root,
    leftRef,
    rightRef,
    path: path ?? null,
  });
}
