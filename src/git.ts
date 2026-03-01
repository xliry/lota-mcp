import { execSync } from "node:child_process";
import { dim } from "./logging.js";

// ── Core helper ───────────────────────────────────────────────────

/** Run a git command. Never throws — returns ok/output result. */
export function gitExec(cmd: string, cwd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe" });
    return { ok: true, output: String(output ?? "") };
  } catch (e) {
    return { ok: false, output: String((e as Error).message ?? e) };
  }
}

// ── State query functions ─────────────────────────────────────────

/** Check if a directory is a git repository. */
export function isGitRepo(dir: string): boolean {
  const r = gitExec("git rev-parse --git-dir", dir);
  return r.ok;
}

/** Check if a local branch exists. */
export function branchExists(cwd: string, branch: string): boolean {
  const r = gitExec(`git rev-parse --verify "refs/heads/${branch}"`, cwd);
  return r.ok;
}

/** Check if a worktree path is registered with git. */
export function worktreeExists(cwd: string, path: string): boolean {
  const r = gitExec("git worktree list --porcelain", cwd);
  if (!r.ok) return false;
  return r.output.includes(`worktree ${path}`);
}

/** Check if there are uncommitted changes (staged or unstaged). */
export function hasUncommittedChanges(cwd: string): boolean {
  const r = gitExec("git status --porcelain", cwd);
  if (!r.ok) return false;
  return r.output.trim().length > 0;
}

/** Get the current branch name, or null if detached / not a repo. */
export function getCurrentBranch(cwd: string): string | null {
  const r = gitExec("git rev-parse --abbrev-ref HEAD", cwd);
  if (!r.ok) return null;
  const branch = r.output.trim();
  return branch === "HEAD" ? null : branch;
}

/** Check if the working tree has unresolved merge conflicts. */
export function hasConflicts(cwd: string): boolean {
  const r = gitExec("git status --short", cwd);
  if (!r.ok) return false;
  return r.output.split("\n").some(line => /^(UU|AA|DD|AU|UA|DU|UD)/.test(line));
}

// ── Safe action functions ─────────────────────────────────────────

/** Checkout a branch. Returns true on success. */
export function checkout(cwd: string, branch: string): boolean {
  const r = gitExec(`git checkout "${branch}"`, cwd);
  if (!r.ok) dim(`[git] checkout "${branch}" failed: ${r.output.slice(0, 120)}`);
  return r.ok;
}

/**
 * Delete a local branch. Checks branchExists first.
 * Uses -D (force) to handle unmerged branches.
 */
export function deleteBranch(cwd: string, branch: string): boolean {
  if (!branchExists(cwd, branch)) return true; // already gone
  const r = gitExec(`git branch -D "${branch}"`, cwd);
  if (!r.ok) dim(`[git] branch -D "${branch}" failed: ${r.output.slice(0, 120)}`);
  return r.ok;
}

/** Delete a remote-tracking branch. Returns true on success. */
export function deleteRemoteBranch(cwd: string, branch: string): boolean {
  const r = gitExec(`git push origin --delete "${branch}"`, cwd);
  if (!r.ok) dim(`[git] push --delete "${branch}" failed: ${r.output.slice(0, 120)}`);
  return r.ok;
}

/** Stash uncommitted changes. Returns true if something was stashed. */
export function stash(cwd: string): boolean {
  const r = gitExec("git stash", cwd);
  if (!r.ok) { dim(`[git] stash failed: ${r.output.slice(0, 120)}`); return false; }
  return !r.output.includes("No local changes");
}

/** Pop the most recent stash entry. Returns true on success. */
export function stashPop(cwd: string): boolean {
  const r = gitExec("git stash pop", cwd);
  if (!r.ok) dim(`[git] stash pop failed: ${r.output.slice(0, 120)}`);
  return r.ok;
}

/** Pull with fast-forward only; falls back to regular pull on failure. Returns true on success. */
export function pull(cwd: string, remote = "origin", branch = "main"): boolean {
  const ff = gitExec(`git pull --ff-only ${remote} ${branch}`, cwd);
  if (ff.ok) return true;
  const r = gitExec(`git pull ${remote} ${branch} --no-edit`, cwd);
  if (!r.ok) dim(`[git] pull ${remote} ${branch} failed: ${r.output.slice(0, 120)}`);
  return r.ok;
}

/** Push to remote. Returns true on success. */
export function push(cwd: string, args = "origin HEAD"): boolean {
  const r = gitExec(`git push ${args}`, cwd);
  if (!r.ok) dim(`[git] push ${args} failed: ${r.output.slice(0, 120)}`);
  return r.ok;
}

/** Merge a branch with --no-edit. Returns true on success. */
export function merge(cwd: string, branch: string, ffOnly = false): boolean {
  const flag = ffOnly ? "--ff-only" : "--no-edit";
  const r = gitExec(`git merge "${branch}" ${flag}`, cwd);
  if (!r.ok) dim(`[git] merge "${branch}" failed: ${r.output.slice(0, 120)}`);
  return r.ok;
}

/** Abort an in-progress merge. Returns true on success. */
export function mergeAbort(cwd: string): boolean {
  const r = gitExec("git merge --abort", cwd);
  if (!r.ok) dim(`[git] merge --abort failed: ${r.output.slice(0, 120)}`);
  return r.ok;
}

/** Rebase the current branch onto another. Returns true on success. */
export function rebase(cwd: string, onto: string): boolean {
  const r = gitExec(`git rebase ${onto}`, cwd);
  if (!r.ok) dim(`[git] rebase ${onto} failed: ${r.output.slice(0, 120)}`);
  return r.ok;
}

/** Abort an in-progress rebase. Returns true on success. */
export function rebaseAbort(cwd: string): boolean {
  const r = gitExec("git rebase --abort", cwd);
  if (!r.ok) dim(`[git] rebase --abort failed: ${r.output.slice(0, 120)}`);
  return r.ok;
}

/** Add a new worktree at path on a new branch. Returns true on success. */
export function worktreeAdd(cwd: string, path: string, branch: string): boolean {
  const r = gitExec(`git worktree add "${path}" -b "${branch}"`, cwd);
  if (!r.ok) dim(`[git] worktree add "${path}" failed: ${r.output.slice(0, 120)}`);
  return r.ok;
}

/**
 * Remove a worktree. Checks worktreeExists first.
 * Uses --force to handle dirty worktrees.
 */
export function worktreeRemove(cwd: string, path: string): boolean {
  if (!worktreeExists(cwd, path)) return true; // already gone
  const r = gitExec(`git worktree remove "${path}" --force`, cwd);
  if (!r.ok) dim(`[git] worktree remove "${path}" failed: ${r.output.slice(0, 120)}`);
  return r.ok;
}

/** Prune stale worktree entries. Returns true on success. */
export function worktreePrune(cwd: string): boolean {
  const r = gitExec("git worktree prune", cwd);
  if (!r.ok) dim(`[git] worktree prune failed: ${r.output.slice(0, 120)}`);
  return r.ok;
}

/** Return the raw output of `git worktree list --porcelain`, or empty string on failure. */
export function worktreeList(cwd: string): string {
  const r = gitExec("git worktree list --porcelain", cwd);
  if (!r.ok) dim(`[git] worktree list failed: ${r.output.slice(0, 120)}`);
  return r.ok ? r.output : "";
}

/** Hard-reset the working tree to HEAD~n (use with care). Returns true on success. */
export function resetHard(cwd: string, ref = "HEAD~1"): boolean {
  const r = gitExec(`git reset --hard ${ref}`, cwd);
  if (!r.ok) dim(`[git] reset --hard ${ref} failed: ${r.output.slice(0, 120)}`);
  return r.ok;
}
