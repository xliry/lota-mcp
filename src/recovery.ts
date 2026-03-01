import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { lota } from "./github.js";
import { cleanStaleWorktrees } from "./worktree.js";
import { tgSend } from "./telegram.js";
import { log, ok, dim, err } from "./logging.js";
import type { AgentConfig } from "./types.js";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TWO_MINUTES_MS = 2 * 60 * 1000;

type StaleTask = { id: number; title: string; assignee: string | null; retries?: number; updatedAt?: string };

// ── Startup recovery ─────────────────────────────────────────────
export async function recoverStaleTasks(config: AgentConfig): Promise<void> {
  process.env.GITHUB_TOKEN = config.githubToken;
  process.env.GITHUB_REPO = config.githubRepo;
  process.env.AGENT_NAME = config.agentName;

  log("🔍 Checking for stale in-progress tasks from previous crash...");

  let tasks: StaleTask[];
  try {
    tasks = await lota("GET", "/tasks?status=in-progress") as StaleTask[];
  } catch (e) {
    err(`Startup recovery check failed: ${(e as Error).message}`);
    return;
  }

  const myTasks = tasks.filter(t => t.assignee === config.agentName);
  if (!myTasks.length) {
    dim("  No stale in-progress tasks found.");
    return;
  }

  for (const task of myTasks) {
    if (task.updatedAt && Date.now() - new Date(task.updatedAt).getTime() < TWO_MINUTES_MS) {
      dim(`  ⏭ Skipping task #${task.id} "${task.title}" (updated < 2 min ago, may be active)`);
      continue;
    }

    let details: { workspace?: string };
    try {
      details = await lota("GET", `/tasks/${task.id}`) as { workspace?: string };
    } catch (e) {
      err(`Failed to fetch details for task #${task.id}: ${(e as Error).message}`);
      continue;
    }

    await recoverOrFailTask(task, details, config);
  }

  ok("Startup recovery complete.");
}

async function recoverOrFailTask(
  task: StaleTask,
  details: { workspace?: string },
  config: AgentConfig,
): Promise<void> {
  const retryCount = task.retries ?? 0;

  if (retryCount < 3) {
    const nextRetry = retryCount + 1;
    log(`🔄 Recovering task #${task.id} "${task.title}" (retry ${nextRetry}/3)`);
    try {
      await lota("PATCH", `/tasks/${task.id}/meta`, { retries: nextRetry });
      await lota("POST", `/tasks/${task.id}/status`, { status: "assigned" });
      await lota("POST", `/tasks/${task.id}/comment`, {
        content: `🔄 Auto-recovery: task was in-progress when agent crashed (retry ${nextRetry}/3).`,
      });
    } catch (e) {
      err(`Failed to recover task #${task.id}: ${(e as Error).message}`);
      return;
    }
    try { await tgSend(config, `🔄 Task #${task.id} auto-recovered after crash (retry ${nextRetry}/3): ${task.title}`); }
    catch (e) { err(`Telegram send failed: ${(e as Error).message}`); }
  } else {
    log(`❌ Task #${task.id} "${task.title}" — 3 crash recoveries exhausted, marking failed`);
    try {
      await lota("POST", `/tasks/${task.id}/status`, { status: "failed" });
      await lota("POST", `/tasks/${task.id}/comment`, {
        content: `❌ Task failed after 3 crash recoveries. Manual review needed.`,
      });
    } catch (e) {
      err(`Failed to mark task #${task.id} as failed: ${(e as Error).message}`);
      return;
    }
    try { await tgSend(config, `❌ Task #${task.id} failed after 3 retries: ${task.title}`); }
    catch (e) { err(`Telegram send failed: ${(e as Error).message}`); }
  }

  if (details.workspace) {
    const home = resolve(process.env.HOME || "/root");
    const wsPath = details.workspace.startsWith("~/")
      ? join(home, details.workspace.slice(2))
      : details.workspace;
    if (existsSync(wsPath)) {
      try { cleanStaleWorktrees(wsPath); dim(`  Cleaned stale worktrees for workspace: ${wsPath}`); }
      catch (e) { dim(`[non-critical] stale worktree cleanup failed for ${wsPath}: ${(e as Error).message}`); }
    }
  }
}

// ── Runtime stale-task recovery ──────────────────────────────────
export async function checkRuntimeStaleTasks(config: AgentConfig): Promise<void> {
  let tasks: Array<{ id: number; title: string; assignee: string | null; updatedAt?: string }>;
  try {
    tasks = await lota("GET", "/tasks?status=in-progress") as typeof tasks;
  } catch (e) {
    dim(`Runtime stale-task check failed: ${(e as Error).message}`);
    return;
  }

  const now = Date.now();
  for (const task of tasks.filter(t => t.assignee === config.agentName)) {
    if (!task.updatedAt) continue;
    const age = now - new Date(task.updatedAt).getTime();
    if (age < FIVE_MINUTES_MS) continue;

    const ageMin = Math.round(age / 60000);
    log(`🔄 Runtime recovery: task #${task.id} "${task.title}" stuck for ${ageMin}m — resetting to assigned`);
    try {
      await lota("POST", `/tasks/${task.id}/status`, { status: "assigned" });
      await lota("POST", `/tasks/${task.id}/comment`, {
        content: `🔄 Runtime recovery: task was stuck in-progress for ${ageMin} minutes. Reset to assigned for retry.`,
      });
    } catch (e) {
      err(`Failed to runtime-recover task #${task.id}: ${(e as Error).message}`);
    }
  }
}
