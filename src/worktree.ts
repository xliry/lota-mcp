import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
  originalWorkspace: string;
}

interface MergeResult {
  success: boolean;
  hasConflicts: boolean;
  output: string;
}

/** Check if a directory is a git repository. */
function isGitRepo(dir: string): boolean {
  try {
    execSync("git rev-parse --git-dir", { cwd: dir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Add `.worktrees/` to the workspace's .gitignore if not already present. */
function ensureWorktreeInGitignore(workspace: string): void {
  const gitignorePath = join(workspace, ".gitignore");
  try {
    let content = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
    const lines = content.split("\n").map(l => l.trim());
    if (!lines.includes(".worktrees/") && !lines.includes(".worktrees")) {
      if (content.length > 0 && !content.endsWith("\n")) content += "\n";
      content += ".worktrees/\n";
      writeFileSync(gitignorePath, content);
    }
  } catch { /* ignore — best effort */ }
}

/**
 * Create a git worktree for an agent to work in isolation.
 * Worktree path: `<workspace>/.worktrees/<agentName>`
 * Branch name: `task-<taskId>-<agentName>`
 * Returns null if the workspace is not a git repo or creation fails.
 */
export function createWorktree(
  workspace: string,
  agentName: string,
  taskId: number,
): WorktreeInfo | null {
  if (!isGitRepo(workspace)) return null;

  const branch = `task-${taskId}-${agentName}`;
  const worktreesDir = join(workspace, ".worktrees");
  const worktreePath = join(worktreesDir, agentName);

  try {
    mkdirSync(worktreesDir, { recursive: true });
    ensureWorktreeInGitignore(workspace);

    // Remove stale worktree for this agent slot if it exists
    if (existsSync(worktreePath)) {
      try {
        execSync(`git worktree remove "${worktreePath}" --force`, {
          cwd: workspace,
          stdio: "pipe",
        });
      } catch { /* may already be cleaned */ }
    }

    // Remove stale branch with same name if it exists
    try {
      execSync(`git branch -D "${branch}"`, { cwd: workspace, stdio: "pipe" });
    } catch { /* branch may not exist — that's fine */ }

    execSync(`git worktree add "${worktreePath}" -b "${branch}"`, {
      cwd: workspace,
      stdio: "pipe",
    });

    return { worktreePath, branch, originalWorkspace: workspace };
  } catch {
    return null;
  }
}

/**
 * Merge a worktree branch back to the current HEAD of the main workspace,
 * then push to origin.
 *
 * Strategy:
 * 1. Pull latest main so we're up-to-date with other agents' merges
 * 2. Try direct merge
 * 3. If conflict → rebase task branch on latest main, then fast-forward merge
 * 4. If rebase also conflicts → true conflict, needs manual resolution
 */
export function mergeWorktree(workspace: string, branch: string): MergeResult {
  // Stash any uncommitted changes in the workspace before merging
  let didStash = false;
  try {
    const stashOut = execSync("git stash", {
      cwd: workspace,
      encoding: "utf-8",
      stdio: "pipe",
    });
    didStash = !stashOut.includes("No local changes");
  } catch { /* ignore — stash may fail if nothing to stash */ }

  // Pull latest main before merging — prevents conflicts from other agents' recent pushes
  try {
    execSync("git pull --ff-only origin main", {
      cwd: workspace,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch {
    // If ff-only fails, try regular pull
    try {
      execSync("git pull origin main --no-edit", {
        cwd: workspace,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch { /* ignore — we'll try merge anyway */ }
  }

  try {
    const output = execSync(`git merge "${branch}" --no-edit`, {
      cwd: workspace,
      encoding: "utf-8",
      stdio: "pipe",
    });

    // Push merged main branch to origin
    try {
      execSync("git push origin HEAD", { cwd: workspace, stdio: "pipe" });
    } catch (pushErr) {
      if (didStash) try { execSync("git stash pop", { cwd: workspace, stdio: "pipe" }); } catch { /* ignore */ }
      return {
        success: false,
        hasConflicts: false,
        output: `Merge succeeded but push failed: ${(pushErr as Error).message}`,
      };
    }

    // Restore stashed changes after successful merge+push
    if (didStash) try { execSync("git stash pop", { cwd: workspace, stdio: "pipe" }); } catch { /* ignore */ }

    return { success: true, hasConflicts: false, output: String(output) };
  } catch (e) {
    const msg = String((e as Error).message || e);
    const hasConflicts = msg.includes("CONFLICT") || msg.toLowerCase().includes("conflict");

    if (hasConflicts) {
      // Abort the failed merge
      try {
        execSync("git merge --abort", { cwd: workspace, stdio: "pipe" });
      } catch { /* ignore */ }

      // Try rebase: update the task branch to include latest main, then fast-forward merge
      const rebaseResult = tryRebaseThenMerge(workspace, branch);
      if (rebaseResult) {
        if (didStash) try { execSync("git stash pop", { cwd: workspace, stdio: "pipe" }); } catch { /* ignore */ }
        return rebaseResult;
      }
    }

    // Restore stashed changes on failure
    if (didStash) try { execSync("git stash pop", { cwd: workspace, stdio: "pipe" }); } catch { /* ignore */ }
    return { success: false, hasConflicts, output: msg };
  }
}

/**
 * Attempt to rebase a task branch onto latest main and then fast-forward merge.
 * Returns MergeResult on success/push-failure, or null if rebase itself conflicts.
 */
function tryRebaseThenMerge(workspace: string, branch: string): MergeResult | null {
  // Get the worktree path for this branch to run rebase there
  const worktreesDir = join(workspace, ".worktrees");
  let worktreePath: string | null = null;

  // Find the worktree directory that has this branch checked out
  try {
    const listOut = execSync("git worktree list --porcelain", {
      cwd: workspace,
      encoding: "utf-8",
      stdio: "pipe",
    });
    for (const block of listOut.split("\n\n")) {
      if (block.includes(`branch refs/heads/${branch}`)) {
        const pathLine = block.split("\n").find(l => l.startsWith("worktree "));
        if (pathLine) worktreePath = pathLine.replace("worktree ", "");
        break;
      }
    }
  } catch { /* ignore */ }

  if (!worktreePath || !existsSync(worktreePath)) return null;

  // Rebase the task branch on latest main
  try {
    execSync("git rebase main", {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch {
    // Rebase conflicts — true conflict, abort and return null
    try { execSync("git rebase --abort", { cwd: worktreePath, stdio: "pipe" }); } catch { /* ignore */ }
    return null;
  }

  // Rebase succeeded — now fast-forward merge on main
  try {
    const output = execSync(`git merge "${branch}" --ff-only`, {
      cwd: workspace,
      encoding: "utf-8",
      stdio: "pipe",
    });

    // Push
    try {
      execSync("git push origin HEAD", { cwd: workspace, stdio: "pipe" });
    } catch (pushErr) {
      return {
        success: false,
        hasConflicts: false,
        output: `Rebase+merge succeeded but push failed: ${(pushErr as Error).message}`,
      };
    }

    return { success: true, hasConflicts: false, output: `Rebased and merged: ${String(output)}` };
  } catch (e) {
    // Fast-forward failed after rebase — shouldn't happen but handle it
    return null;
  }
}

/** Remove a worktree directory and its associated branch. */
export function cleanupWorktree(
  workspace: string,
  agentName: string,
  branch: string,
): void {
  const worktreePath = join(workspace, ".worktrees", agentName);
  try {
    if (existsSync(worktreePath)) {
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: workspace,
        stdio: "pipe",
      });
    }
  } catch { /* ignore */ }
  try {
    execSync(`git branch -D "${branch}"`, { cwd: workspace, stdio: "pipe" });
  } catch { /* ignore */ }
}

/**
 * Clean up stale worktrees from crashed agents.
 * Called on daemon startup to recover from unclean shutdowns.
 */
export function cleanStaleWorktrees(workspace: string): void {
  if (!isGitRepo(workspace)) return;

  // git worktree prune removes entries whose paths no longer exist
  try {
    execSync("git worktree prune", { cwd: workspace, stdio: "pipe" });
  } catch { /* ignore */ }

  const worktreesDir = join(workspace, ".worktrees");
  if (!existsSync(worktreesDir)) return;

  try {
    const entries = readdirSync(worktreesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryPath = join(worktreesDir, entry.name);
      try {
        execSync(`git worktree remove "${entryPath}" --force`, {
          cwd: workspace,
          stdio: "pipe",
        });
      } catch { /* ignore — may already be clean */ }
    }
  } catch { /* ignore */ }
}
