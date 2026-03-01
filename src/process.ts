import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lota } from "./github.js";
import * as git from "./git.js";
import { createWorktree, mergeWorktree, cleanupWorktree, type WorktreeInfo } from "./worktree.js";
import { log, ok, dim, err, formatEvent, writeToLog } from "./logging.js";
import { buildPrompt, resolveWorkspace } from "./prompt.js";
import type { AgentConfig, WorkData } from "./types.js";

let currentProcess: ChildProcess | null = null;
let busy = false;

export function getCurrentProcess(): ChildProcess | null { return currentProcess; }
export function resetBusy(): void { busy = false; }

// ── Git branch merge (simple branch strategy) ───────────────────
export function mergeBranch(workspace: string, branch: string): { success: boolean; hasConflicts: boolean; output: string } {
  // Step 1: Checkout main/master
  if (!git.checkout(workspace, "main")) {
    git.checkout(workspace, "master");
  }

  // Step 2: Pull latest
  git.pull(workspace, "origin", "main");

  // Step 3: Merge the branch
  if (!git.merge(workspace, branch)) {
    if (git.hasConflicts(workspace)) {
      git.mergeAbort(workspace);
      return { success: false, hasConflicts: true, output: "" };
    }
    return { success: false, hasConflicts: false, output: "" };
  }

  // Step 4: Push with retry (pull to rebase on conflict, then retry)
  for (let attempt = 0; attempt < 3; attempt++) {
    if (git.push(workspace, "origin main")) break;
    if (attempt < 2) git.pull(workspace, "origin", "main");
  }

  // Step 5: Cleanup branch
  git.deleteBranch(workspace, branch);
  git.deleteRemoteBranch(workspace, branch);

  return { success: true, hasConflicts: false, output: "" };
}

// ── Environment setup ────────────────────────────────────────────
function cleanEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE") || key === "CLAUDECODE" || key === "CLAUDE_SHELL_SESSION_ID") {
      delete env[key];
    }
  }
  return env;
}

function setupGitIdentity(env: NodeJS.ProcessEnv, config: AgentConfig): void {
  const email = `${config.githubRepo.split("/")[0]}@users.noreply.github.com`;
  env.GIT_AUTHOR_NAME = config.agentName;
  env.GIT_AUTHOR_EMAIL = email;
  env.GIT_COMMITTER_NAME = config.agentName;
  env.GIT_COMMITTER_EMAIL = email;
}

function writeTokenFile(config: AgentConfig): void {
  const tokenFile = join(process.env.HOME || "/root", "lota", ".github-token");
  try { writeFileSync(tokenFile, config.githubToken, { mode: 0o600 }); }
  catch (e) { dim(`[non-critical] failed to write token file: ${(e as Error).message}`); }
}

// ── Claude settings merge ────────────────────────────────────────
const REQUIRED_PERMISSIONS = [
  "mcp__lota__lota", "Bash(*)", "Read(*)", "Write(*)",
  "Edit(*)", "Glob(*)", "Grep(*)", "Task(*)", "WebFetch(*)", "WebSearch(*)",
];
const DENIED_TOOLS = ["TodoWrite", "Agent"];

function mergeClaudeSettings(settingsFile: string, withDeny = false): void {
  try {
    mkdirSync(dirname(settingsFile), { recursive: true });
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(readFileSync(settingsFile, "utf-8")); }
    catch (e) { dim(`[non-critical] failed to read ${settingsFile}: ${(e as Error).message}`); }

    const perms = existing.permissions as { allow?: string[]; deny?: string[] } || {};
    const mergedAllow = [...new Set([...(perms.allow || []), ...REQUIRED_PERMISSIONS])];
    const merged: Record<string, unknown> = {
      ...existing,
      permissions: {
        ...perms,
        allow: mergedAllow,
        ...(withDeny ? { deny: [...new Set([...(perms.deny || []), ...DENIED_TOOLS])] } : {}),
      },
    };
    writeFileSync(settingsFile, JSON.stringify(merged, null, 2) + "\n");
  } catch (e) {
    dim(`[non-critical] failed to write Claude settings to ${settingsFile}: ${(e as Error).message}`);
  }
}

// ── Worktree / branch setup ──────────────────────────────────────
interface BranchSetup {
  claudeCwd: string;
  worktreeInfo: WorktreeInfo | null;
  defaultBranch: string | null;
}

function setupBranchStrategy(config: AgentConfig, work: WorkData, workingDir: string): BranchSetup {
  if (!(work.phase === "execute" || work.phase === "single") || !work.tasks[0]?.id) {
    return { claudeCwd: workingDir, worktreeInfo: null, defaultBranch: null };
  }

  if (config.useWorktree) {
    const worktreeInfo = createWorktree(workingDir, config.agentName, work.tasks[0].id);
    if (worktreeInfo) {
      ok(`Worktree: ${worktreeInfo.worktreePath} (branch: ${worktreeInfo.branch})`);
      return { claudeCwd: worktreeInfo.worktreePath, worktreeInfo, defaultBranch: null };
    }
    dim(`Worktree skipped (not a git repo or failed): ${workingDir}`);
    return { claudeCwd: workingDir, worktreeInfo: null, defaultBranch: null };
  }

  const defaultBranch = `task-${work.tasks[0].id}-${config.agentName}`;
  ok(`Branch strategy: agent will work on branch ${defaultBranch}`);
  return { claudeCwd: workingDir, worktreeInfo: null, defaultBranch };
}

// ── Post-completion merge ────────────────────────────────────────
function handlePostCompletion(
  code: number,
  work: WorkData,
  worktreeInfo: WorktreeInfo | null,
  defaultBranch: string | null,
  workingDir: string,
  config: AgentConfig,
): void {
  if (worktreeInfo) {
    if (code === 0) {
      log(`Merging branch ${worktreeInfo.branch} back to main...`);
      const result = mergeWorktree(worktreeInfo.originalWorkspace, worktreeInfo.branch);
      if (result.success) {
        ok(`Merged ${worktreeInfo.branch} → main`);
        cleanupWorktree(worktreeInfo.originalWorkspace, config.agentName, worktreeInfo.branch);
      } else if (result.hasConflicts) {
        err(`Merge conflict on ${worktreeInfo.branch} — manual review needed`);
        err(result.output.slice(0, 200));
        for (const t of work.tasks) {
          lota("POST", `/tasks/${t.id}/comment`, {
            content: `⚠️ **Merge conflict**: Agent completed work on branch \`${worktreeInfo.branch}\` but auto-merge to main failed due to conflicts. Manual review needed.\n\nWorktree preserved at: \`${worktreeInfo.worktreePath}\``,
          }).catch(() => {});
        }
      } else {
        err(`Merge/push failed: ${result.output.slice(0, 200)}`);
        cleanupWorktree(worktreeInfo.originalWorkspace, config.agentName, worktreeInfo.branch);
      }
    } else {
      cleanupWorktree(worktreeInfo.originalWorkspace, config.agentName, worktreeInfo.branch);
    }
    return;
  }

  if (defaultBranch && code === 0) {
    log(`Merging branch ${defaultBranch} back to main...`);
    const result = mergeBranch(workingDir, defaultBranch);
    if (result.success) {
      ok(`Merged ${defaultBranch} → main`);
    } else if (result.hasConflicts) {
      err(`Merge conflict on ${defaultBranch} — manual review needed`);
      err(result.output.slice(0, 200));
      for (const t of work.tasks) {
        lota("POST", `/tasks/${t.id}/comment`, {
          content: `⚠️ **Merge conflict**: Agent completed work on branch \`${defaultBranch}\` but auto-merge to main failed due to conflicts. Branch preserved for manual review.`,
        }).catch(() => {});
      }
    } else {
      err(`Merge/push failed: ${result.output.slice(0, 200)}`);
    }
  }
}

// ── Timeout handler ──────────────────────────────────────────────
function setupTimeoutHandler(
  child: ChildProcess,
  config: AgentConfig,
  work: WorkData,
  worktreeInfo: WorktreeInfo | null,
  resolve: (code: number) => void,
): { killTimer: ReturnType<typeof setTimeout>; killedRef: { value: boolean } } {
  const killedRef = { value: false };
  const killTimer = setTimeout(() => {
    killedRef.value = true;
    err(`Claude process timed out after ${config.timeout}s — killed`);
    child.kill("SIGTERM");
    const forceKill = setTimeout(() => {
      if (currentProcess === child) child.kill("SIGKILL");
    }, 5000);
    forceKill.unref();

    for (const taskId of work.tasks.map(t => t.id)) {
      lota("POST", `/tasks/${taskId}/comment`, {
        content: `⚠️ **Agent timeout**: Claude subprocess was killed after ${config.timeout}s without completing. The task will be retried on the next cycle.`,
      }).catch(() => {});
      lota("POST", `/tasks/${taskId}/status`, { status: "assigned" }).catch(() => {});
    }
    if (worktreeInfo) {
      try { cleanupWorktree(worktreeInfo.originalWorkspace, config.agentName, worktreeInfo.branch); } catch { /* ignore */ }
    }
    currentProcess = null;
    busy = false;
    resolve(1);
  }, config.timeout * 1000);
  killTimer.unref();
  return { killTimer, killedRef };
}

// ── Main Claude subprocess ───────────────────────────────────────
export function runClaude(config: AgentConfig, work: WorkData): Promise<number> {
  if (busy) { dim("Already running, skipping..."); return Promise.resolve(0); }
  busy = true;

  return new Promise((resolve) => {
    const cleanEnv = cleanEnvironment();
    cleanEnv.GITHUB_TOKEN = config.githubToken;
    cleanEnv.GITHUB_REPO = config.githubRepo;
    cleanEnv.AGENT_NAME = config.agentName;
    setupGitIdentity(cleanEnv, config);
    writeTokenFile(config);

    mergeClaudeSettings(join(process.env.HOME || "/root", ".claude", "settings.json"), true);

    const isRoot = process.getuid?.() === 0;
    const args: string[] = [
      "--print", "--verbose", "--output-format", "stream-json",
      ...(isRoot ? [] : ["--dangerously-skip-permissions"]),
      "--model", config.model,
      ...(config.configPath ? ["--mcp-config", config.configPath] : []),
    ];

    const workingDir = resolveWorkspace(work);
    const rawWorkspace = work.tasks[0]?.workspace;
    if (rawWorkspace) {
      workingDir !== process.cwd() ? ok(`Workspace: ${workingDir}`) : err(`Workspace not found: ${rawWorkspace} — using cwd`);
    }

    const { claudeCwd, worktreeInfo, defaultBranch } = setupBranchStrategy(config, work, workingDir);
    const promptWork: WorkData = worktreeInfo
      ? { ...work, tasks: work.tasks.map(t => ({ ...t, workspace: worktreeInfo.worktreePath })) }
      : work;
    args.push("-p", buildPrompt(config.agentName, promptWork, config));

    mergeClaudeSettings(join(claudeCwd, ".claude", "settings.json"), false);

    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"], cwd: claudeCwd, env: cleanEnv });
    currentProcess = child;

    const { killTimer, killedRef } = setupTimeoutHandler(child, config, work, worktreeInfo, resolve);

    let jsonBuffer = "";
    child.stdout?.on("data", (d: Buffer) => {
      jsonBuffer += d.toString();
      const lines = jsonBuffer.split("\n");
      jsonBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { formatEvent(JSON.parse(line)); }
        catch { console.log(`  ${line}`); writeToLog(`  ${line}\n`); }
      }
    });

    child.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        if (line.trim()) writeToLog(`  [stderr] ${line}\n`);
      }
    });

    child.on("close", (code) => {
      if (killedRef.value) return;
      clearTimeout(killTimer);
      currentProcess = null;
      busy = false;
      handlePostCompletion(code ?? 1, work, worktreeInfo, defaultBranch, workingDir, config);
      resolve(code ?? 1);
    });

    child.on("error", (e) => {
      if (killedRef.value) return;
      clearTimeout(killTimer);
      currentProcess = null;
      busy = false;
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        err("'claude' not found. Install: npm i -g @anthropic-ai/claude-code");
      } else {
        err(`Spawn error: ${e.message}`);
      }
      resolve(1);
    });
  });
}
