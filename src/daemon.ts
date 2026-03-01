#!/usr/bin/env node
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, statSync, createWriteStream, unlinkSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { resolve, join } from "node:path";
import { lota, getRateLimitInfo } from "./github.js";
import { createWorktree, mergeWorktree, cleanupWorktree, cleanStaleWorktrees, type WorktreeInfo } from "./worktree.js";
import { tgSend, tgSetupChatId, tgWaitForApproval } from "./telegram.js";


// ── Time & size constants ────────────────────────────────────────
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const BUILD_OUTPUT_TRUNCATE = 1000;

// ── Early name detection (before log init) ──────────────────────
// Quick pre-scan of argv for --name/-n so LOG_FILE is set correctly at module level.
function _earlyGetName(): string {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "--name" || args[i] === "-n") return args[i + 1];
  }
  return "";
}
const _EARLY_AGENT_NAME = _earlyGetName();

// ── Config ──────────────────────────────────────────────────────

type AgentMode = "auto" | "supervised";

interface AgentConfig {
  configPath: string;
  model: string;
  interval: number;
  once: boolean;
  mode: AgentMode;
  singlePhase: boolean;
  agentName: string;
  maxTasksPerCycle: number;
  githubToken: string;
  githubRepo: string;
  telegramBotToken: string;
  telegramChatId: string;
  timeout: number;
  maxRssMb: number;
  useWorktree: boolean;
}

function parseArgs(): AgentConfig {
  const args = process.argv.slice(2);
  let interval = 15;
  let once = false;
  let mcpConfig = "";
  let model = "sonnet";
  let mode: AgentMode = "auto";
  let maxTasksPerCycle = 1;
  let singlePhaseOverride: boolean | null = null;
  let timeout = 900;
  let maxRssMb = 1024;
  let nameOverride = "";
  let useWorktree = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--interval": case "-i": interval = parseInt(args[++i], 10); break;
      case "--once": case "-1": once = true; break;
      case "--config": case "-c": mcpConfig = args[++i]; break;
      case "--model": case "-m": model = args[++i]; break;
      case "--mode": mode = args[++i] as AgentMode; break;
      case "--max-tasks": case "-t": maxTasksPerCycle = Math.max(1, parseInt(args[++i], 10)); break;
      case "--single-phase": singlePhaseOverride = true; break;
      case "--no-single-phase": singlePhaseOverride = false; break;
      case "--timeout": timeout = parseInt(args[++i], 10); break;
      case "--max-rss": maxRssMb = parseInt(args[++i], 10); break;
      case "--name": case "-n": nameOverride = args[++i]; break;
      case "--worktree": useWorktree = true; break;
      case "--help": case "-h":
        console.log(`Usage: lota-agent [options]

Autonomous LOTA agent (GitHub-backed).
Listens for assigned tasks, plans, executes, and reports.

Options:
  -n, --name <name>     Agent identity (default: lota). Sets log file, PID file, and task label filter.
  -c, --config <path>   MCP config file (default: .mcp.json)
  -m, --model <model>   Claude model (default: sonnet)
  -i, --interval <sec>  Poll interval in seconds (default: 15)
  -t, --max-tasks <n>   Max tasks per execute cycle (default: 1)
  --timeout <sec>       Claude subprocess timeout in seconds (default: 600)
  --mode <auto|supervised>  auto = direct execution, supervised = Telegram approval (default: auto)
  --single-phase        Merge plan+execute into one Claude invocation (default: on in auto mode)
  --no-single-phase     Use separate plan→approve→execute phases even in auto mode
  --worktree            Use git worktree isolation (default: simple branch strategy)
  -1, --once            Run once then exit
  -h, --help            Show this help`);
        process.exit(0);
    }
  }

  // Default: single-phase is enabled in auto mode, disabled in supervised mode
  const singlePhase = singlePhaseOverride !== null ? singlePhaseOverride : mode === "auto";

  // Find .mcp.json — search upward from cwd, then $HOME
  function findMcpConfig(): string {
    let dir = process.cwd();
    while (true) {
      const candidate = join(dir, ".mcp.json");
      if (existsSync(candidate)) return candidate;
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
    const home = resolve(process.env.HOME || "~", ".mcp.json");
    if (existsSync(home)) return home;
    return "";
  }
  const configPath = mcpConfig ? resolve(mcpConfig) : findMcpConfig();

  // .mcp.json is optional now — token can come from env or gh auth

  // Expand ${VAR} references to actual env values
  const expandEnv = (val: string): string =>
    val.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] || "");

  // Read credentials from .mcp.json
  let githubToken = "", githubRepo = "", agentName = "";
  let telegramBotToken = "", telegramChatId = "";
  if (configPath) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      const env = cfg.mcpServers?.lota?.env || {};
      githubToken = expandEnv(env.GITHUB_TOKEN || "");
      githubRepo = expandEnv(env.GITHUB_REPO || "");
      agentName = expandEnv(env.AGENT_NAME || "");
      telegramBotToken = expandEnv(env.TELEGRAM_BOT_TOKEN || "");
      telegramChatId = expandEnv(env.TELEGRAM_CHAT_ID || "");
    } catch (e) {
      console.error(`Warning: could not read ${configPath}: ${(e as Error).message}`);
    }
  }

  // Token discovery fallback: .mcp.json → env → gh auth token
  if (!githubToken) {
    githubToken = process.env.GITHUB_TOKEN || "";
  }
  if (!githubToken) {
    try {
      githubToken = execSync("gh auth token 2>/dev/null", { encoding: "utf-8" }).trim();
    } catch (e) { dim(`[non-critical] gh auth token failed: ${(e as Error).message}`); }
  }
  if (!githubToken) {
    console.error("Error: GitHub token not found. Checked: .mcp.json, $GITHUB_TOKEN env, gh auth token");
    process.exit(1);
  }

  // Defaults
  if (!githubRepo) githubRepo = process.env.GITHUB_REPO || "xliry/lota-agents";
  if (!agentName) agentName = process.env.AGENT_NAME || "lota";
  // CLI --name flag overrides everything
  if (nameOverride) agentName = nameOverride;

  // Supervised mode requires Telegram
  if (mode === "supervised" && !telegramBotToken) {
    console.log("\n  Supervised mode requires Telegram. Let's set it up:\n");
    console.log("  1. Open @BotFather on Telegram, send /newbot");
    console.log("  2. Name it anything (e.g. 'My Lota')");
    console.log("  3. Set TELEGRAM_BOT_TOKEN in .mcp.json under mcpServers.lota.env");
    console.log("  4. Run again with --mode supervised\n");
    process.exit(1);
  }

  return { configPath, model, interval, once, mode, singlePhase, agentName, maxTasksPerCycle, githubToken, githubRepo, telegramBotToken, telegramChatId, timeout, maxRssMb, useWorktree };
}

// ── Logging (stdout + file) ──────────────────────────────────────

const LOG_DIR = join(process.env.HOME || "~", "lota");
// Default agent (lota) keeps backwards-compatible `agent.log`; named agents get `agent-<name>.log`
const LOG_FILE = (_EARLY_AGENT_NAME && _EARLY_AGENT_NAME !== "lota")
  ? join(LOG_DIR, `agent-${_EARLY_AGENT_NAME}.log`)
  : join(LOG_DIR, "agent.log");
const BYTES_PER_MB = 1024 * 1024;
const LOG_MAX_BYTES = 5 * BYTES_PER_MB;
const MEMORY_WARNING_MB = 500;
const MEMORY_CRITICAL_MB = 800;

const AGENTS_DIR = join(LOG_DIR, ".agents");
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(AGENTS_DIR, { recursive: true });

function rotateLogs(): void {
  if (existsSync(`${LOG_FILE}.1`)) renameSync(`${LOG_FILE}.1`, `${LOG_FILE}.2`);
  if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 0) renameSync(LOG_FILE, `${LOG_FILE}.1`);
}

rotateLogs();

let logStream: WriteStream = createWriteStream(LOG_FILE, { flags: "a" });
logStream.on("error", () => {}); // silently ignore log write errors

function checkRotate(): void {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size >= LOG_MAX_BYTES) {
      logStream.end();
      rotateLogs();
      logStream = createWriteStream(LOG_FILE, { flags: "a" });
      logStream.on("error", () => {});
    }
  } catch (e) { dim(`[non-critical] log rotation failed: ${(e as Error).message}`); }
}

const time = () => new Date().toLocaleTimeString("en-US", { hour12: false });

// Write startup banner to mark new session
const startupBanner = `\n${"=".repeat(60)}\n[SESSION START] ${new Date().toISOString()}\n${"=".repeat(60)}\n`;
logStream.write(startupBanner);

function out(msg: string, plain: string) {
  checkRotate();
  console.log(msg);
  logStream.write(`${plain}\n`);
}

const PRE = "\x1b[36m[lota]\x1b[0m";
const log = (msg: string) => out(`${PRE} \x1b[90m${time()}\x1b[0m ${msg}`, `[${time()}] ${msg}`);
const ok = (msg: string) => out(`${PRE} \x1b[90m${time()}\x1b[0m \x1b[32m✓ ${msg}\x1b[0m`, `[${time()}] ✓ ${msg}`);
const dim = (msg: string) => out(`${PRE} \x1b[90m${time()} ${msg}\x1b[0m`, `[${time()}] ${msg}`);
const err = (msg: string) => out(`${PRE} \x1b[90m${time()}\x1b[0m \x1b[31m✗ ${msg}\x1b[0m`, `[${time()}] ✗ ${msg}`);

// ── Memory monitoring ────────────────────────────────────────────

function logMemory(label: string, config: AgentConfig): void {
  const mem = process.memoryUsage();
  const heapUsedMb = Math.round(mem.heapUsed / BYTES_PER_MB);
  const heapTotalMb = Math.round(mem.heapTotal / BYTES_PER_MB);
  const rssMb = Math.round(mem.rss / BYTES_PER_MB);

  if (heapUsedMb > MEMORY_CRITICAL_MB) {
    err(`🔴 Critical memory [${label}]: ${heapUsedMb}MB heap used / ${heapTotalMb}MB total, RSS: ${rssMb}MB — consider restarting`);
    const maybeGc = (global as { gc?: () => void }).gc;
    if (typeof maybeGc === "function") {
      maybeGc();
      const afterMb = Math.round(process.memoryUsage().heapUsed / BYTES_PER_MB);
      dim(`  GC freed ${heapUsedMb - afterMb}MB (heap now ${afterMb}MB)`);
    }
  } else if (heapUsedMb > MEMORY_WARNING_MB) {
    log(`⚠️ High memory [${label}]: ${heapUsedMb}MB heap used / ${heapTotalMb}MB total, RSS: ${rssMb}MB`);
  } else {
    dim(`Memory [${label}]: heap ${heapUsedMb}/${heapTotalMb}MB, RSS: ${rssMb}MB`);
  }

  if (rssMb > config.maxRssMb) {
    err(`🔴 RSS ${rssMb}MB exceeds limit ${config.maxRssMb}MB — graceful exit (code 42)`);
    process.exit(42);
  }
}

// ── PID registry ─────────────────────────────────────────────────

let activeAgentName = ""; // set in main() after parseArgs, used by shutdown handler

function getPidFile(name: string): string {
  return join(AGENTS_DIR, `${name}.pid`);
}

function checkAndCleanStalePid(name: string): void {
  const pidFile = getPidFile(name);
  if (!existsSync(pidFile)) return;
  try {
    const data = JSON.parse(readFileSync(pidFile, "utf-8")) as { pid?: number; started?: string };
    const pid = data.pid;
    if (typeof pid !== "number") {
      dim(`Removing malformed PID file for "${name}"`);
      try { unlinkSync(pidFile); } catch { /* ignore */ }
      return;
    }
    try {
      process.kill(pid, 0); // signal 0 = existence check, does not kill
      // Process is alive
      log(`⚠️ Another instance of "${name}" may already be running (PID ${pid})`);
      if (data.started) log(`   Started: ${data.started}`);
      log(`   If it crashed, delete: ${pidFile}`);
    } catch (killErr) {
      const code = (killErr as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        // No such process — stale
        dim(`Cleaning up stale PID file for "${name}" (PID ${pid} is dead)`);
        try { unlinkSync(pidFile); } catch { /* ignore */ }
      } else if (code === "EPERM") {
        // Process exists but we can't signal it (different user) — treat as alive
        log(`⚠️ Agent "${name}" may already be running (PID ${pid}, EPERM)`);
      }
    }
  } catch (e) {
    dim(`[non-critical] Failed to check PID file: ${(e as Error).message}`);
    try { unlinkSync(pidFile); } catch { /* ignore */ }
  }
}

function writePidFile(name: string, model: string): void {
  const pidFile = getPidFile(name);
  try {
    const data = {
      pid: process.pid,
      name,
      started: new Date().toISOString(),
      model,
    };
    writeFileSync(pidFile, JSON.stringify(data, null, 2) + "\n", { mode: 0o644 });
    dim(`PID file: ${pidFile}`);
  } catch (e) {
    dim(`[non-critical] Failed to write PID file: ${(e as Error).message}`);
  }
}

function removePidFile(name: string): void {
  const pidFile = getPidFile(name);
  try {
    if (existsSync(pidFile)) {
      unlinkSync(pidFile);
      dim(`PID file removed: ${pidFile}`);
    }
  } catch (e) {
    dim(`[non-critical] Failed to remove PID file: ${(e as Error).message}`);
  }
}

// ── Startup recovery ─────────────────────────────────────────────

async function recoverStaleTasks(config: AgentConfig): Promise<void> {
  process.env.GITHUB_TOKEN = config.githubToken;
  process.env.GITHUB_REPO = config.githubRepo;
  process.env.AGENT_NAME = config.agentName;

  log("🔍 Checking for stale in-progress tasks from previous crash...");

  let tasks: Array<{ id: number; title: string; assignee: string | null; retries?: number; updatedAt?: string }>;
  try {
    tasks = await lota("GET", "/tasks?status=in-progress") as Array<{ id: number; title: string; assignee: string | null; retries?: number; updatedAt?: string }>;
  } catch (e) {
    err(`Startup recovery check failed: ${(e as Error).message}`);
    return;
  }

  const myTasks = tasks.filter(t => t.assignee === config.agentName);
  if (!myTasks.length) {
    dim("  No stale in-progress tasks found.");
    return;
  }

  const TWO_MINUTES_MS = 2 * 60 * 1000;

  for (const task of myTasks) {
    if (task.updatedAt) {
      const updatedAt = new Date(task.updatedAt).getTime();
      if (Date.now() - updatedAt < TWO_MINUTES_MS) {
        dim(`  ⏭ Skipping task #${task.id} "${task.title}" (updated < 2 min ago, may be active)`);
        continue;
      }
    }

    let details: { workspace?: string };
    try {
      details = await lota("GET", `/tasks/${task.id}`) as { workspace?: string };
    } catch (e) {
      err(`Failed to fetch details for task #${task.id}: ${(e as Error).message}`);
      continue;
    }

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
        continue;
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
        continue;
      }
      try { await tgSend(config, `❌ Task #${task.id} failed after 3 retries: ${task.title}`); }
      catch (e) { err(`Telegram send failed: ${(e as Error).message}`); }
    }

    // Clean up stale worktrees for this task's workspace
    if (details.workspace) {
      const home = resolve(process.env.HOME || "/root");
      const wsPath = details.workspace.startsWith("~/")
        ? join(home, details.workspace.slice(2))
        : details.workspace;
      if (existsSync(wsPath)) {
        try {
          cleanStaleWorktrees(wsPath);
          dim(`  Cleaned stale worktrees for workspace: ${wsPath}`);
        } catch { /* ignore */ }
      }
    }
  }

  log("✅ Startup recovery complete.");
}

// ── Runtime stale-task recovery (periodic, every N poll cycles) ──

const FIVE_MINUTES_MS = 5 * 60 * 1000;

async function checkRuntimeStaleTasks(config: AgentConfig): Promise<void> {
  let tasks: Array<{ id: number; title: string; assignee: string | null; updatedAt?: string }>;
  try {
    tasks = await lota("GET", "/tasks?status=in-progress") as Array<{ id: number; title: string; assignee: string | null; updatedAt?: string }>;
  } catch (e) {
    dim(`Runtime stale-task check failed: ${(e as Error).message}`);
    return;
  }

  const myTasks = tasks.filter(t => t.assignee === config.agentName);
  if (!myTasks.length) return;

  const now = Date.now();
  for (const task of myTasks) {
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

// ── Pre-check (zero-cost, no LLM) ──────────────────────────────

interface TaskInfo {
  id: number;
  title: string;
  status: string;
  body?: string;
  workspace?: string;
  comment_count?: number;
  plan?: {
    affected_files?: string[];
    goals?: string[];
  };
}

interface CommentUpdate {
  id: number;
  title: string;
  workspace?: string;
  new_comment_count: number;
}

interface WorkData {
  phase: "plan" | "execute" | "comments" | "single";
  tasks: TaskInfo[];
  commentUpdates: CommentUpdate[];
}

// ── Comment baseline persistence ────────────────────────────────

const BASELINES_FILE = join(process.env.HOME || "/root", "lota", ".comment-baselines.json");

interface BaselineEntry {
  count: number;
  ts: number; // ms timestamp of last update (for 7-day cleanup)
}

// Track comment counts for in-progress tasks
const lastSeenComments = new Map<number, number>();
loadCommentBaselines();

async function checkForWork(config: AgentConfig): Promise<WorkData | null> {
  // Set env vars so github.ts can use them
  process.env.GITHUB_TOKEN = config.githubToken;
  process.env.GITHUB_REPO = config.githubRepo;
  process.env.AGENT_NAME = config.agentName;

  const data = await lota("GET", "/sync") as {
    assigned: TaskInfo[];
    approved: TaskInfo[];
    in_progress: (TaskInfo & { comment_count: number })[];
    recently_completed: (TaskInfo & { comment_count: number })[];
  };

  const assigned = data.assigned || [];
  const approved = data.approved || [];
  const inProgress = data.in_progress || [];
  const recentlyCompleted = data.recently_completed || [];
  const commentUpdates: CommentUpdate[] = [];

  // Check for new comments on in-progress tasks
  for (const task of inProgress) {
    const lastSeen = lastSeenComments.get(task.id) ?? -1;
    const currentCount = task.comment_count ?? 0;

    if (lastSeen === -1) {
      lastSeenComments.set(task.id, currentCount);
    } else if (currentCount > lastSeen) {
      const newCount = currentCount - lastSeen;
      commentUpdates.push({
        id: task.id,
        title: task.title,
        workspace: task.workspace ?? undefined,
        new_comment_count: newCount,
      });
      lastSeenComments.set(task.id, currentCount);
    }
  }

  // Check for new comments on recently completed (closed) tasks
  for (const task of recentlyCompleted) {
    const lastSeen = lastSeenComments.get(task.id) ?? -1;
    const currentCount = task.comment_count ?? 0;

    if (lastSeen === -1) {
      // First time seeing this completed task — record baseline without triggering
      lastSeenComments.set(task.id, currentCount);
    } else if (currentCount > lastSeen) {
      const newCount = currentCount - lastSeen;
      commentUpdates.push({
        id: task.id,
        title: task.title,
        workspace: task.workspace ?? undefined,
        new_comment_count: newCount,
      });
      lastSeenComments.set(task.id, currentCount);
    }
  }

  // Clean up tracking for tasks no longer active or in recently-completed list
  const activeIds = new Set([
    ...inProgress.map(t => t.id),
    ...recentlyCompleted.map(t => t.id),
  ]);
  for (const id of lastSeenComments.keys()) {
    if (!activeIds.has(id)) lastSeenComments.delete(id);
  }

  // Persist baselines so newly-established baselines survive a restart
  saveCommentBaselines();

  // Priority: comments > approved (execute) > assigned (plan)
  if (commentUpdates.length) {
    return { phase: "comments", tasks: [], commentUpdates };
  }
  if (approved.length) {
    const sorted = approved.sort((a, b) => a.id - b.id);
    const tasksToExecute = sorted.slice(0, config.maxTasksPerCycle);
    // Fetch full details to include plan context (affected_files, goals) in the execute prompt
    const enrichedTasks = await Promise.all(
      tasksToExecute.map(async (t) => {
        try {
          const details = await lota("GET", `/tasks/${t.id}`) as { plan?: { affected_files?: string[]; goals?: string[] } };
          return { ...t, plan: details.plan };
        } catch {
          return t;
        }
      })
    );
    return { phase: "execute", tasks: enrichedTasks, commentUpdates: [] };
  }
  if (assigned.length) {
    const sorted = assigned.sort((a, b) => a.id - b.id);
    const phase = config.singlePhase ? "single" : "plan";
    return { phase, tasks: sorted.slice(0, config.maxTasksPerCycle), commentUpdates: [] };
  }

  return null; // nothing to do
}

// After a Claude cycle, re-fetch comment counts for all processed tasks so the
// agent's own post-execution comments don't trigger a spurious "comments" phase.
async function refreshCommentBaselines(taskIds: number[]): Promise<void> {
  for (const id of taskIds) {
    try {
      const task = await lota("GET", `/tasks/${id}`) as { comments?: unknown[] };
      const count = task.comments?.length ?? 0;
      lastSeenComments.set(id, count);
    } catch (e) { dim(`[non-critical] refreshCommentBaselines failed for task #${id}: ${(e as Error).message}`); }
  }
  saveCommentBaselines();
}

function loadCommentBaselines(): void {
  try {
    if (!existsSync(BASELINES_FILE)) return;
    const raw = readFileSync(BASELINES_FILE, "utf-8");
    const data = JSON.parse(raw) as Record<string, BaselineEntry>;
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    let loaded = 0;
    for (const [idStr, entry] of Object.entries(data)) {
      const id = parseInt(idStr, 10);
      if (isNaN(id)) continue;
      if (entry.ts < cutoff) continue; // skip stale entries
      lastSeenComments.set(id, entry.count);
      loaded++;
    }
    if (loaded > 0) dim(`[baselines] loaded ${loaded} comment baseline(s) from disk`);
  } catch (e) {
    dim(`[non-critical] loadCommentBaselines: ${(e as Error).message}`);
  }
}

function saveCommentBaselines(): void {
  try {
    const now = Date.now();
    const cutoff = now - SEVEN_DAYS_MS;
    const data: Record<string, BaselineEntry> = {};

    // Save all current in-memory entries with a fresh timestamp
    for (const [id, count] of lastSeenComments.entries()) {
      data[String(id)] = { count, ts: now };
    }

    // Preserve recently-seen entries from the existing file that are no longer
    // in memory (e.g. tasks pruned by the cleanup loop) but haven't expired yet
    try {
      if (existsSync(BASELINES_FILE)) {
        const existing = JSON.parse(readFileSync(BASELINES_FILE, "utf-8")) as Record<string, BaselineEntry>;
        for (const [idStr, entry] of Object.entries(existing)) {
          if (!data[idStr] && entry.ts >= cutoff) {
            data[idStr] = entry;
          }
        }
      }
    } catch { /* ignore read errors — best effort */ }

    const tmpFile = BASELINES_FILE + ".tmp";
    writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    renameSync(tmpFile, BASELINES_FILE);
  } catch (e) {
    dim(`[non-critical] saveCommentBaselines: ${(e as Error).message}`);
  }
}

// ── Prompt ──────────────────────────────────────────────────────

function sanitizeTaskBody(body: string): string {
  // Strip HTML comments (<!-- ... -->)
  let cleaned = body.replace(/<!--[\s\S]*?-->/g, "");
  // Strip image markdown (![alt](url))
  cleaned = cleaned.replace(/!\[([^\]]*)\]\([^)]*\)/g, "[image: $1]");
  // Collapse excessive blank lines
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  const MAX = 2000;
  const HEAD = 1000;
  const TAIL = 500;
  if (cleaned.length <= MAX) return cleaned;

  return cleaned.slice(0, HEAD) + "\n\n... [truncated] ...\n\n" + cleaned.slice(-TAIL);
}

function resolveBuildCmd(workspace?: string): string {
  if (!workspace) return "npm run build";
  const home = resolve(process.env.HOME || "/root");
  const dir = workspace.startsWith("~/") ? join(home, workspace.slice(2)) : workspace;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    if (pkg.scripts?.build) return "npm run build";
  } catch {}
  return "npx tsc";
}

function buildPrompt(agentName: string, work: WorkData, config: AgentConfig): string {
  // ── PHASE: COMMENTS ──
  if (work.phase === "comments") {
    const list = work.commentUpdates.map(cu =>
      `  #${cu.id} "${cu.title}": ${cu.new_comment_count} new comment(s)${cu.workspace ? ` — ${cu.workspace}` : ""}`
    ).join("\n");
    return [
      `You are agent "${agentName}". Your MCP tool is lota().`,
      "",
      "NEW COMMENTS on tasks. Read via lota API and respond appropriately.",
      "  - User feedback → adjust your work",
      "  - Question → reply with a comment",
      "  - Changed requirements → update your approach",
      "",
      list,
    ].join("\n");
  }

  const t = work.tasks[0];
  if (!t) return `You are agent "${agentName}". No tasks assigned.`;

  const buildCmd = resolveBuildCmd(t.workspace);
  const taskHeader = `TASK #${t.id}: ${t.title}\nWorkspace: ${t.workspace ?? "(none)"}\nBuild: ${buildCmd}`;
  const body = t.body ? "\n" + sanitizeTaskBody(t.body) : "";

  // ── PHASE: PLAN ──
  if (work.phase === "plan") {
    return [
      `You are agent "${agentName}". Your MCP tool is lota().`,
      "",
      "PLAN PHASE — Explore, then plan. Do NOT execute code.",
      "",
      "WORKFLOW:",
      `  1. lota("POST", "/tasks/${t.id}/plan", {goals: [...], affected_files: [...], effort: "..."})`,
      `  2. lota("POST", "/tasks/${t.id}/status", {status: "planned"})`,
      "  3. STOP. User will approve via Hub before you execute.",
      "",
      taskHeader,
      body,
    ].join("\n");
  }

  // Shared RULES for execute/single phases
  const branchName = `task-${t.id}-${agentName}`;
  const branchRule = config.useWorktree
    ? "  - You are already in the correct workspace directory (git worktree)."
    : `  - You are in the workspace directory. First, run: git checkout -b ${branchName} (or git checkout ${branchName} if it exists). Push to this branch.`;
  const rules = [
    "RULES:",
    branchRule,
    "  - Git identity is pre-configured. Do not run git config.",
    "  - Token file: ~/lota/.github-token (for git push auth).",
    `  - Run \`${buildCmd}\` before pushing. Fix errors before committing.`,
    `  - Make ONE focused commit: "feat: description (#${t.id})"`,
    "  - Do NOT use TodoWrite, Agent tool, or Task tool.",
    "  - Do NOT re-read the task via lota API. The task body is below.",
    "  - Do NOT post plan comments. Your commit is the audit trail.",
    "  - If push gets 403, report as comment and stop.",
    "  - Use `gh` CLI for GitHub operations, NOT curl.",
    "  - NEVER force push.",
  ].join("\n");

  const workflow = [
    "WORKFLOW:",
    `  1. lota("POST", "/tasks/${t.id}/status", {status: "in-progress"})`,
    "  2. Do the work. Build. Test. Commit. Push.",
    `  3. lota("POST", "/tasks/${t.id}/complete", {summary: "..."})`,
  ].join("\n");

  // ── PHASE: EXECUTE ──
  if (work.phase === "execute") {
    const goals = t.plan?.goals?.length
      ? "\nGOALS:\n" + t.plan.goals.map(g => `  - ${g}`).join("\n")
      : "";
    const files = t.plan?.affected_files?.length
      ? "\nFILES:\n" + t.plan.affected_files.map(f => `  - ${f}`).join("\n")
      : "";
    return [
      `You are agent "${agentName}". Your MCP tool is lota().`,
      "",
      workflow,
      "",
      rules,
      "",
      taskHeader,
      body,
      goals,
      files,
    ].join("\n");
  }

  // ── PHASE: SINGLE (auto mode) ──
  return [
    `You are agent "${agentName}". Your MCP tool is lota().`,
    "",
    workflow,
    "",
    rules,
    "",
    taskHeader,
    body,
  ].join("\n");
}

// ── Event formatter (stream-json → readable log) ────────────────

interface ClaudeEvent {
  type: string;
  subtype?: string;
  content_block?: { type?: string; name?: string };
  message?: { content?: Array<{ type: string; name?: string; text?: string; input?: Record<string, unknown> }> };
  cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
}

function formatEvent(event: ClaudeEvent) {
  const t = time();
  const write = (icon: string, msg: string) => {
    const plain = `[${t}] ${icon} ${msg}`;
    const colored = `${PRE} \x1b[90m${t}\x1b[0m ${icon} ${msg}`;
    console.log(colored);
    logStream.write(`${plain}\n`);
  };

  // Tool use (agent calling a tool)
  if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
    const name = event.content_block.name || "unknown";
    write("🔧", `Tool: ${name}`);
    return;
  }

  // Tool result
  if (event.type === "result" && event.subtype === "tool_result") {
    return; // skip verbose tool results
  }

  // Assistant text
  if (event.type === "assistant" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "tool_use") {
        const name = block.name || "";
        const input = block.input || {};

        if (name === "Write" || name === "Edit") {
          write("📝", `${name}: ${input.file_path || ""}`);
        } else if (name === "Read") {
          write("📖", `Read: ${input.file_path || ""}`);
        } else if (name === "Bash") {
          const cmd = String(input.command || "").slice(0, 120);
          write("💻", `Bash: ${cmd}`);
        } else if (name === "Glob" || name === "Grep") {
          write("🔍", `${name}: ${input.pattern || ""}`);
        } else if (name === "Task") {
          const desc = input.description || "";
          const type = input.subagent_type || "";
          const bg = input.run_in_background ? " [bg]" : "";
          write("🤖", `Subagent (${type}): ${desc}${bg}`);
        } else if (name.startsWith("mcp__lota")) {
          const method = input.method || "";
          const path = input.path || "";
          write("🔗", `LOTA: ${method} ${path}`);
        } else {
          write("🔧", `${name}`);
        }
      } else if (block.type === "text") {
        const text = (block.text || "").slice(0, 200);
        if (text.trim()) {
          write("💬", text.replace(/\n/g, " ").trim());
        }
      }
    }
    return;
  }

  // System/result messages
  if (event.type === "result") {
    const cost = event.cost_usd ? `$${event.cost_usd.toFixed(4)}` : "";
    const dur = event.duration_ms ? `${(event.duration_ms / 1000).toFixed(1)}s` : "";
    const turns = event.num_turns || 0;
    write("✅", `Done — ${turns} turns, ${dur}, ${cost}`);
    return;
  }
}

// ── Workspace resolution ────────────────────────────────────────

function resolveWorkspace(work: WorkData): string {
  const rawWorkspace = work.tasks[0]?.workspace;
  if (!rawWorkspace) return process.cwd();

  const home = resolve(process.env.HOME || "/root");

  // Reject path traversal attempts
  if (rawWorkspace.includes("..")) {
    err(`Workspace path rejected (path traversal): ${rawWorkspace}`);
    return process.cwd();
  }

  // Expand ~/... to absolute path
  const expanded = rawWorkspace.startsWith("~/")
    ? join(home, rawWorkspace.slice(2))
    : rawWorkspace;

  // For absolute paths, ensure they stay under $HOME
  if (expanded.startsWith("/")) {
    if (!expanded.startsWith(home + "/") && expanded !== home) {
      err(`Workspace path rejected (escapes home): ${rawWorkspace}`);
      return process.cwd();
    }
    const candidate = resolve(expanded);
    if (existsSync(candidate)) return candidate;
    return process.cwd();
  }

  const candidate = resolve(home, expanded);

  if (existsSync(candidate)) return candidate;
  return process.cwd();
}


// ── Simple branch merge (default, no worktree) ──────────────────

function mergeBranch(workspace: string, branch: string): { success: boolean; hasConflicts: boolean; output: string } {
  const gitOpts = { cwd: workspace, encoding: "utf-8" as const };
  try {
    // Ensure we're on main
    try {
      execSync("git checkout main", gitOpts);
    } catch (e) {
      // Some repos use master
      try { execSync("git checkout master", gitOpts); } catch { /* ignore */ }
    }

    // Pull latest main
    try {
      execSync("git pull --ff-only origin main", gitOpts);
    } catch {
      try { execSync("git pull origin main --no-edit", gitOpts); } catch { /* ignore */ }
    }

    // Merge the task branch
    try {
      execSync(`git merge "${branch}" --no-edit`, gitOpts);
    } catch (e) {
      const status = execSync("git status --short", gitOpts);
      if (status.includes("UU") || status.includes("AA") || status.includes("DD")) {
        try { execSync("git merge --abort", gitOpts); } catch { /* ignore */ }
        return { success: false, hasConflicts: true, output: (e as Error).message };
      }
      return { success: false, hasConflicts: false, output: (e as Error).message };
    }

    // Push to origin with retry
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        execSync("git push origin main", gitOpts);
        break;
      } catch {
        if (attempt < 2) {
          try { execSync("git pull --ff-only origin main", gitOpts); } catch { /* ignore */ }
        }
      }
    }

    // Clean up task branch (local + remote)
    try { execSync(`git branch -d "${branch}"`, gitOpts); } catch { /* ignore */ }
    try { execSync(`git push origin --delete "${branch}"`, gitOpts); } catch { /* ignore */ }

    return { success: true, hasConflicts: false, output: "" };
  } catch (e) {
    return { success: false, hasConflicts: false, output: (e as Error).message };
  }
}

// ── Claude subprocess ───────────────────────────────────────────

let currentProcess: ChildProcess | null = null;
let busy = false;

function runClaude(config: AgentConfig, work: WorkData): Promise<number> {
  if (busy) {
    dim("Already running, skipping...");
    return Promise.resolve(0);
  }
  busy = true;

  return new Promise((resolve) => {
    // Clean env to prevent nested Claude session errors
    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (key.startsWith("CLAUDE_CODE") || key === "CLAUDECODE" || key === "CLAUDE_SHELL_SESSION_ID") {
        delete cleanEnv[key];
      }
    }

    // Set GitHub env vars for the Claude subprocess
    cleanEnv.GITHUB_TOKEN = config.githubToken;
    cleanEnv.GITHUB_REPO = config.githubRepo;
    cleanEnv.AGENT_NAME = config.agentName;

    // Set git identity via env vars (scoped to subprocess only — never touches ~/.gitconfig)
    const agentEmail = `${config.githubRepo.split("/")[0]}@users.noreply.github.com`;
    cleanEnv.GIT_AUTHOR_NAME = config.agentName;
    cleanEnv.GIT_AUTHOR_EMAIL = agentEmail;
    cleanEnv.GIT_COMMITTER_NAME = config.agentName;
    cleanEnv.GIT_COMMITTER_EMAIL = agentEmail;

    // Write token to a file so agent's Bash tool can read it
    // (Claude Code may sandbox env vars from Bash commands)
    const tokenFile = join(process.env.HOME || "/root", "lota", ".github-token");
    try {
      writeFileSync(tokenFile, config.githubToken, { mode: 0o600 });
    } catch (e) { dim(`[non-critical] failed to write token file: ${(e as Error).message}`); }

    // Ensure global Claude settings allow all tools — merge with existing settings
    // to avoid destroying user preferences like skipDangerousModePermissionPrompt
    const claudeSettingsDir = join(process.env.HOME || "/root", ".claude");
    const claudeSettingsFile = join(claudeSettingsDir, "settings.json");
    try {
      mkdirSync(claudeSettingsDir, { recursive: true });
      let existingSettings: Record<string, unknown> = {};
      try {
        existingSettings = JSON.parse(readFileSync(claudeSettingsFile, "utf-8"));
      } catch (e) { dim(`[non-critical] failed to read ${claudeSettingsFile}: ${(e as Error).message}`); }
      const requiredPermissions = [
        "mcp__lota__lota",
        "Bash(*)",
        "Read(*)",
        "Write(*)",
        "Edit(*)",
        "Glob(*)",
        "Grep(*)",
        "Task(*)",
        "WebFetch(*)",
        "WebSearch(*)"
      ];
      const currentAllow: string[] = (existingSettings.permissions as { allow?: string[] })?.allow || [];
      const mergedAllow = [...new Set([...currentAllow, ...requiredPermissions])];
      const deniedTools = ["TodoWrite", "Agent"];
      const currentDeny: string[] = (existingSettings.permissions as { deny?: string[] })?.deny || [];
      const mergedDeny = [...new Set([...currentDeny, ...deniedTools])];
      const mergedSettings = {
        ...existingSettings,
        permissions: {
          ...(existingSettings.permissions as object || {}),
          allow: mergedAllow,
          deny: mergedDeny,
        },
      };
      writeFileSync(claudeSettingsFile, JSON.stringify(mergedSettings, null, 2) + "\n");
    } catch (e) { dim(`[non-critical] failed to write Claude settings to ${claudeSettingsFile}: ${(e as Error).message}`); }

    const isRoot = process.getuid?.() === 0;
    const args: string[] = [
      "--print",
      "--verbose",
      "--output-format", "stream-json",
      // --dangerously-skip-permissions is blocked when running as root
      // For root: we rely on ~/.claude/settings.json (written above) for permissions
      ...(isRoot ? [] : ["--dangerously-skip-permissions"]),
      "--model", config.model,
      ...(config.configPath ? ["--mcp-config", config.configPath] : []),
    ];

    // Use workspace from first task as cwd if available
    const workingDir = resolveWorkspace(work);
    const rawWorkspace = work.tasks[0]?.workspace;
    if (rawWorkspace) {
      if (workingDir !== process.cwd()) {
        ok(`Workspace: ${workingDir}`);
      } else {
        err(`Workspace not found: ${rawWorkspace} — using cwd`);
      }
    }

    // Create git worktree for isolation (only when --worktree flag is set)
    let claudeCwd = workingDir;
    let worktreeInfo: WorktreeInfo | null = null;
    let defaultBranch: string | null = null;
    if ((work.phase === "execute" || work.phase === "single") && work.tasks[0]?.id) {
      if (config.useWorktree) {
        worktreeInfo = createWorktree(workingDir, config.agentName, work.tasks[0].id);
        if (worktreeInfo) {
          claudeCwd = worktreeInfo.worktreePath;
          ok(`Worktree: ${claudeCwd} (branch: ${worktreeInfo.branch})`);
        } else {
          dim(`Worktree skipped (not a git repo or failed): ${workingDir}`);
        }
      } else {
        defaultBranch = `task-${work.tasks[0].id}-${config.agentName}`;
        ok(`Branch strategy: agent will work on branch ${defaultBranch}`);
      }
    }

    // Build prompt — point agent to worktree path if isolation is active
    const promptWork: WorkData = worktreeInfo ? {
      ...work,
      tasks: work.tasks.map(t => ({
        ...t,
        workspace: t.workspace && worktreeInfo ? worktreeInfo.worktreePath : t.workspace,
      })),
    } : work;
    args.push("-p", buildPrompt(config.agentName, promptWork, config));

    // Also merge .claude/settings.json into the workspace cwd (or worktree)
    // Claude Code reads project-level settings which can override global ones
    try {
      const wsSettingsDir = join(claudeCwd, ".claude");
      mkdirSync(wsSettingsDir, { recursive: true });
      const wsSettingsFile = join(wsSettingsDir, "settings.json");
      let wsExistingSettings: Record<string, unknown> = {};
      try {
        wsExistingSettings = JSON.parse(readFileSync(wsSettingsFile, "utf-8"));
      } catch (e) { dim(`[non-critical] failed to read workspace settings at ${wsSettingsFile}: ${(e as Error).message}`); }
      const wsRequiredPermissions = [
        "mcp__lota__lota", "Bash(*)", "Read(*)", "Write(*)",
        "Edit(*)", "Glob(*)", "Grep(*)", "Task(*)",
        "WebFetch(*)", "WebSearch(*)"
      ];
      const wsCurrentAllow: string[] = (wsExistingSettings.permissions as { allow?: string[] })?.allow || [];
      const wsMergedAllow = [...new Set([...wsCurrentAllow, ...wsRequiredPermissions])];
      writeFileSync(wsSettingsFile, JSON.stringify({
        ...wsExistingSettings,
        permissions: {
          ...(wsExistingSettings.permissions as object || {}),
          allow: wsMergedAllow,
        },
      }, null, 2) + "\n");
    } catch (e) { dim(`[non-critical] failed to write workspace settings (workspace may be read-only): ${(e as Error).message}`); }

    const child = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: claudeCwd,
      env: cleanEnv,
    });

    currentProcess = child;

    // ── Timeout guard ──────────────────────────────────────────────
    let killed = false;
    const timeoutMs = config.timeout * 1000;
    const killTimer = setTimeout(() => {
      killed = true;
      err(`Claude process timed out after ${config.timeout}s — killed`);
      child.kill("SIGTERM");

      // Give the process 5 seconds to exit gracefully, then SIGKILL
      const forceKill = setTimeout(() => {
        if (currentProcess === child) {
          child.kill("SIGKILL");
        }
      }, 5000);
      forceKill.unref();

      // Post a warning comment and reset task status so it gets picked up again
      const taskIds = work.tasks.map((t) => t.id);
      for (const taskId of taskIds) {
        lota("POST", `/tasks/${taskId}/comment`, {
          content: `⚠️ **Agent timeout**: Claude subprocess was killed after ${config.timeout}s without completing. The task will be retried on the next cycle.`,
        }).catch(() => { /* best-effort */ });
        lota("POST", `/tasks/${taskId}/status`, { status: "assigned" }).catch(() => { /* best-effort */ });
      }

      // Clean up worktree on timeout
      if (worktreeInfo) {
        try {
          cleanupWorktree(worktreeInfo.originalWorkspace, config.agentName, worktreeInfo.branch);
        } catch { /* ignore */ }
      }

      currentProcess = null;
      busy = false;
      resolve(1);
    }, timeoutMs);
    killTimer.unref();

    let jsonBuffer = "";

    child.stdout?.on("data", (d: Buffer) => {
      jsonBuffer += d.toString();
      const lines = jsonBuffer.split("\n");
      jsonBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          formatEvent(event);
        } catch {
          // Not JSON, log raw
          console.log(`  ${line}`);
          logStream.write(`  ${line}\n`);
        }
      }
    });

    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      for (const line of text.split("\n")) {
        if (line.trim()) {
          logStream.write(`  [stderr] ${line}\n`);
        }
      }
    });

    child.on("close", (code) => {
      if (killed) return; // already handled by timeout
      clearTimeout(killTimer);
      currentProcess = null;
      busy = false;

      // Handle worktree: merge back to main or clean up
      if (worktreeInfo) {
        if (code === 0) {
          log(`Merging branch ${worktreeInfo.branch} back to main...`);
          const mergeResult = mergeWorktree(worktreeInfo.originalWorkspace, worktreeInfo.branch);
          if (mergeResult.success) {
            ok(`Merged ${worktreeInfo.branch} → main`);
            cleanupWorktree(worktreeInfo.originalWorkspace, config.agentName, worktreeInfo.branch);
          } else if (mergeResult.hasConflicts) {
            err(`Merge conflict on ${worktreeInfo.branch} — manual review needed`);
            err(mergeResult.output.slice(0, 200));
            for (const t of work.tasks) {
              lota("POST", `/tasks/${t.id}/comment`, {
                content: `⚠️ **Merge conflict**: Agent completed work on branch \`${worktreeInfo.branch}\` but auto-merge to main failed due to conflicts. Manual review needed.\n\nWorktree preserved at: \`${worktreeInfo.worktreePath}\``,
              }).catch(() => { /* best-effort */ });
            }
            // Leave worktree intact for manual resolution
          } else {
            err(`Merge/push failed: ${mergeResult.output.slice(0, 200)}`);
            cleanupWorktree(worktreeInfo.originalWorkspace, config.agentName, worktreeInfo.branch);
          }
        } else {
          // Task failed — clean up worktree
          cleanupWorktree(worktreeInfo.originalWorkspace, config.agentName, worktreeInfo.branch);
        }
      } else if (defaultBranch && code === 0) {
        // Default branch strategy: merge task branch → main
        log(`Merging branch ${defaultBranch} back to main...`);
        const mergeResult = mergeBranch(workingDir, defaultBranch);
        if (mergeResult.success) {
          ok(`Merged ${defaultBranch} → main`);
        } else if (mergeResult.hasConflicts) {
          err(`Merge conflict on ${defaultBranch} — manual review needed`);
          err(mergeResult.output.slice(0, 200));
          for (const t of work.tasks) {
            lota("POST", `/tasks/${t.id}/comment`, {
              content: `⚠️ **Merge conflict**: Agent completed work on branch \`${defaultBranch}\` but auto-merge to main failed due to conflicts. Branch preserved for manual review.`,
            }).catch(() => { /* best-effort */ });
          }
        } else {
          err(`Merge/push failed: ${mergeResult.output.slice(0, 200)}`);
        }
      }

      resolve(code ?? 1);
    });

    child.on("error", (e) => {
      if (killed) return; // already handled by timeout
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

// ── Shutdown ────────────────────────────────────────────────────

let stopped = false;
let sleepResolve: (() => void) | null = null;

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopped) {
      if (currentProcess) currentProcess.kill("SIGKILL");
      if (activeAgentName) removePidFile(activeAgentName);
      logStream.end();
      process.exit(0);
    }
    stopped = true;
    log("Shutting down...");
    if (activeAgentName) removePidFile(activeAgentName);
    if (currentProcess) {
      currentProcess.kill("SIGTERM");
      setTimeout(() => {
        if (currentProcess) currentProcess.kill("SIGKILL");
        logStream.end();
        process.exit(0);
      }, 5000);
    }
    sleepResolve?.();
  });
}

const MS_PER_SECOND = 1000;

function sleep(sec: number): Promise<void> {
  return new Promise((r) => {
    sleepResolve = r;
    setTimeout(() => { sleepResolve = null; r(); }, sec * MS_PER_SECOND);
  });
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const config = parseArgs();
  activeAgentName = config.agentName;

  // PID registry: check for stale/live instances, then register this one
  checkAndCleanStalePid(config.agentName);
  writePidFile(config.agentName, config.model);

  // Telegram setup for supervised mode
  if (config.mode === "supervised" && !config.telegramChatId) {
    try {
      config.telegramChatId = await tgSetupChatId(config);
      ok("Telegram connected!");
    } catch (e) {
      err((e as Error).message);
      process.exit(1);
    }
  }

  const modeLabel = config.mode === "supervised"
    ? "supervised (Telegram)"
    : config.singlePhase ? "autonomous (single-phase)" : "autonomous";
  const _home = process.env.HOME || "/root";
  const prettyPath = (p: string) => p.startsWith(_home) ? "~" + p.slice(_home.length) : p;
  const banner = [
    "",
    "  ┌─────────────────────────┐",
    "  │         Lota            │",
    "  └─────────────────────────┘",
    `  agent:    ${config.agentName}`,
    `  mode:     ${modeLabel}`,
    `  model:    ${config.model}`,
    `  config:   ${config.configPath}`,
    `  interval: ${config.interval}s`,
    `  max-tasks: ${config.maxTasksPerCycle} per cycle`,
    `  log:      ${prettyPath(LOG_FILE)}`,
    `  pid:      ${prettyPath(getPidFile(config.agentName))}`,
    "",
  ];
  for (const line of banner) {
    console.log(line);
    logStream.write(`${line}\n`);
  }

  log("━━━ Agent active, waiting for tasks ━━━");
  console.log("");

  if (config.mode === "supervised") {
    try { await tgSend(config, "🤖 Lota is online. Watching for tasks."); }
    catch (e) { err(`Telegram send failed: ${(e as Error).message}`); }
  }

  // Recover stale in-progress tasks from a previous crash before polling
  await recoverStaleTasks(config);

  // Main loop: poll → check → spawn → sleep
  let emptyPolls = 0;
  let pollCycles = 0;
  const MAX_INTERVAL_MULTIPLIER = 4; // max 4x base interval (60s with 15s base)
  while (!stopped) {
    pollCycles++;
    let work: WorkData | null;
    try {
      work = await checkForWork(config);
    } catch (e) {
      err(`Pre-check failed: ${(e as Error).message}`);
      if (config.once) break;
      await sleep(config.interval);
      continue;
    }

    if (!work) {
      emptyPolls++;
      const multiplier = Math.min(emptyPolls, MAX_INTERVAL_MULTIPLIER);
      const nextInterval = config.interval * multiplier;
      if (emptyPolls === 1 || emptyPolls % 10 === 0) {
        dim(`No pending work (${emptyPolls} checks) — next in ${nextInterval}s`);
      }
      if (pollCycles % 10 === 0) {
        logMemory("Periodic", config);
        await checkRuntimeStaleTasks(config);
      }
      if (config.once) break;
      await sleep(nextInterval);
      continue;
    }

    emptyPolls = 0; // reset on work found
    const phase = work.phase;
      const taskCount = work.tasks.length;
      const commentCount = work.commentUpdates.length;

      // Both modes now go through plan phase.
      // Auto mode: plan → user approves via Lota Hub → execute
      // Supervised mode: plan → user approves via Telegram → execute

      if (work.phase === "comments") {
        ok(`${commentCount} task(s) have new comments`);
        for (const cu of work.commentUpdates) {
          dim(`  💬 #${cu.id}: ${cu.title} (${cu.new_comment_count} new)`);
        }
        if (config.mode === "supervised") {
          for (const cu of work.commentUpdates) {
            try { await tgSend(config, `💬 New comment on task #${cu.id}: ${cu.title}`); }
            catch (e) { err(`Telegram send failed: ${(e as Error).message}`); }
          }
        }
      } else if (work.phase === "single") {
        ok(`${taskCount} new task(s) — single-phase (explore+execute)`);
        for (const t of work.tasks) {
          dim(`  ⚡ #${t.id}: ${t.title}`);
        }
      } else if (work.phase === "plan") {
        ok(`${taskCount} new task(s) — creating plans for approval`);
        for (const t of work.tasks) {
          dim(`  📋 #${t.id}: ${t.title}`);
        }
      } else if (work.phase === "execute") {
        ok(`${taskCount} task(s) — executing`);
        for (const t of work.tasks) {
          dim(`  🚀 #${t.id}: ${t.title}`);
        }
        if (config.mode === "supervised") {
          for (const t of work.tasks) {
            try { await tgSend(config, `🚀 Executing task #${t.id}: ${t.title}`); }
            catch (e) { err(`Telegram send failed: ${(e as Error).message}`); }
          }
        }
      }

      console.log("  ─────────────────────────────────────");
      logMemory("Pre-Claude", config);
      const cycleStart = Date.now();
      let code: number;
      try {
        code = await runClaude(config, work);
      } catch (e) {
        err(`runClaude threw an unexpected error: ${(e as Error).message ?? String(e)}`);
        busy = false;
        if (config.once) break;
        await sleep(config.interval);
        continue;
      }
      const elapsed = Math.round((Date.now() - cycleStart) / 1000);
      logMemory("Post-Claude", config);
      console.log("  ─────────────────────────────────────");

      if (code === 0) {
        ok(`${work.phase} phase complete in ${elapsed}s`);

        // AUTO: after plan phase (when --no-single-phase is set), auto-approve and continue to execute
        if (config.mode === "auto" && phase === "plan") {
          for (const t of work.tasks) {
            await lota("POST", `/tasks/${t.id}/status`, { status: "approved" });
            ok(`Task #${t.id} auto-approved — will execute next cycle`);
          }
        }

        // SUPERVISED: after plan phase, wait for Telegram approval
        if (config.mode === "supervised" && phase === "plan") {
          for (const t of work.tasks) {
            ok(`Waiting for Telegram approval for task #${t.id}...`);
            const approved = await tgWaitForApproval(config, t.id, t.title);
            if (approved) {
              // Set status to approved via GitHub
              await lota("POST", `/tasks/${t.id}/status`, { status: "approved" });
              ok(`Task #${t.id} approved via Telegram`);
            } else {
              ok(`Task #${t.id} rejected via Telegram — skipping`);
            }
          }
        }

        // Notify completion
        if (config.mode === "supervised" && (work.phase === "execute" || work.phase === "single")) {
          for (const t of work.tasks) {
            try { await tgSend(config, `✅ Task #${t.id} completed: ${t.title}`); }
            catch (e) { err(`Telegram send failed: ${(e as Error).message}`); }
          }
        }
      } else {
        err(`Claude exited with code ${code} after ${elapsed}s`);
        if (config.mode === "supervised") {
          try { await tgSend(config, `❌ Error: Claude exited with code ${code} after ${elapsed}s`); }
          catch (e) { err(`Telegram send failed: ${(e as Error).message}`); }
        }
        // Reset in-progress tasks back to assigned so they get picked up on next poll
        for (const t of work.tasks) {
          lota("POST", `/tasks/${t.id}/comment`, {
            content: `⚠️ Agent crashed (exit code ${code}). Task reset to assigned for retry.`,
          }).catch(() => { /* best-effort */ });
          lota("POST", `/tasks/${t.id}/status`, { status: "assigned" }).catch(() => { /* best-effort */ });
        }
      }

      // Refresh comment baselines so the agent's own post-cycle comments
      // don't appear as "new" on the next poll.
      const processedIds = [
        ...work.tasks.map(t => t.id),
        ...work.commentUpdates.map(cu => cu.id),
      ];
      if (processedIds.length) {
        await refreshCommentBaselines(processedIds);
      }

    if (config.once) break;

    // Log rate limit status and memory every 10 cycles; also check for stuck tasks
    if (pollCycles % 10 === 0) {
      const rl = getRateLimitInfo();
      if (rl) {
        const resetIn = Math.max(0, Math.round((rl.reset * 1000 - Date.now()) / 60000));
        dim(`Rate limit: ${rl.remaining}/${rl.limit} remaining (resets in ${resetIn}m)`);
      }
      logMemory("Periodic", config);
      await checkRuntimeStaleTasks(config);
    }

    dim(`Polling in ${config.interval}s...`);
    await sleep(config.interval);
  }
}

main().catch((e) => {
  err(`Fatal: ${(e as Error).message}`);
  process.exit(1);
});
