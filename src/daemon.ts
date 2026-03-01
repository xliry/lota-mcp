#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { lota, getRateLimitInfo } from "./github.js";
import { tgSend, tgSetupChatId, tgWaitForApproval } from "./telegram.js";
import { LOG_FILE, LOG_DIR, log, ok, dim, err, out, logMemory, closeLog } from "./logging.js";
import { checkForWork, refreshCommentBaselines } from "./comments.js";
import { recoverStaleTasks, checkRuntimeStaleTasks } from "./recovery.js";
import { runClaude, getCurrentProcess, resetBusy } from "./process.js";
import type { AgentConfig, AgentMode, WorkData } from "./types.js";

// ── PID registry ─────────────────────────────────────────────────
const AGENTS_DIR = join(LOG_DIR, ".agents");
mkdirSync(AGENTS_DIR, { recursive: true });

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
      try { unlinkSync(pidFile); } catch (e) { dim(`[non-critical] failed to remove malformed PID file: ${(e as Error).message}`); }
      return;
    }
    try {
      process.kill(pid, 0);
      log(`⚠️ Another instance of "${name}" may already be running (PID ${pid})`);
      if (data.started) log(`   Started: ${data.started}`);
      log(`   If it crashed, delete: ${pidFile}`);
    } catch (killErr) {
      const code = (killErr as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        dim(`Cleaning up stale PID file for "${name}" (PID ${pid} is dead)`);
        try { unlinkSync(pidFile); } catch (e) { dim(`[non-critical] failed to remove stale PID file: ${(e as Error).message}`); }
      } else if (code === "EPERM") {
        log(`⚠️ Agent "${name}" may already be running (PID ${pid}, EPERM)`);
      }
    }
  } catch (e) {
    dim(`[non-critical] Failed to check PID file: ${(e as Error).message}`);
    try { unlinkSync(pidFile); } catch (e) { dim(`[non-critical] failed to remove corrupted PID file: ${(e as Error).message}`); }
  }
}

function writePidFile(name: string, model: string): void {
  try {
    writeFileSync(getPidFile(name), JSON.stringify({ pid: process.pid, name, started: new Date().toISOString(), model }, null, 2) + "\n", { mode: 0o644 });
    dim(`PID file: ${getPidFile(name)}`);
  } catch (e) { dim(`[non-critical] Failed to write PID file: ${(e as Error).message}`); }
}

function removePidFile(name: string): void {
  try {
    if (existsSync(getPidFile(name))) { unlinkSync(getPidFile(name)); dim(`PID file removed: ${getPidFile(name)}`); }
  } catch (e) { dim(`[non-critical] Failed to remove PID file: ${(e as Error).message}`); }
}

// ── Argument parsing ─────────────────────────────────────────────
function loadCredentials(configPath: string, nameOverride: string): Pick<AgentConfig, "githubToken" | "githubRepo" | "agentName" | "telegramBotToken" | "telegramChatId"> {
  const expandEnv = (val: string): string => val.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] || "");

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
    } catch (e) { console.error(`Warning: could not read ${configPath}: ${(e as Error).message}`); }
  }

  if (!githubToken) githubToken = process.env.GITHUB_TOKEN || "";
  if (!githubToken) {
    try { githubToken = execSync("gh auth token 2>/dev/null", { encoding: "utf-8" }).trim(); }
    catch (e) { dim(`[non-critical] gh auth token failed: ${(e as Error).message}`); }
  }
  if (!githubToken) {
    console.error("Error: GitHub token not found. Checked: .mcp.json, $GITHUB_TOKEN env, gh auth token");
    process.exit(1);
  }

  if (!githubRepo) githubRepo = process.env.GITHUB_REPO || "xliry/lota-agents";
  if (!agentName) agentName = process.env.AGENT_NAME || "lota";
  if (nameOverride) agentName = nameOverride;

  return { githubToken, githubRepo, agentName, telegramBotToken, telegramChatId };
}

function parseArgs(): AgentConfig {
  const args = process.argv.slice(2);
  let interval = 15, once = false, mcpConfig = "", model = "sonnet";
  let mode: AgentMode = "auto", maxTasksPerCycle = 1, singlePhaseOverride: boolean | null = null;
  let timeout = 900, maxRssMb = 1024, nameOverride = "", useWorktree = false;

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

  const singlePhase = singlePhaseOverride !== null ? singlePhaseOverride : mode === "auto";

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
    return existsSync(home) ? home : "";
  }
  const configPath = mcpConfig ? resolve(mcpConfig) : findMcpConfig();

  if (mode === "supervised") {
    const creds = loadCredentials(configPath, nameOverride);
    if (!creds.telegramBotToken) {
      console.log("\n  Supervised mode requires Telegram. Let's set it up:\n");
      console.log("  1. Open @BotFather on Telegram, send /newbot");
      console.log("  2. Name it anything (e.g. 'My Lota')");
      console.log("  3. Set TELEGRAM_BOT_TOKEN in .mcp.json under mcpServers.lota.env");
      console.log("  4. Run again with --mode supervised\n");
      process.exit(1);
    }
  }

  const creds = loadCredentials(configPath, nameOverride);
  return { configPath, model, interval, once, mode, singlePhase, maxTasksPerCycle, timeout, maxRssMb, useWorktree, ...creds };
}

// ── Shutdown ─────────────────────────────────────────────────────
let stopped = false;
let sleepResolve: (() => void) | null = null;
let activeAgentName = "";

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    const cp = getCurrentProcess();
    if (stopped) {
      if (cp) cp.kill("SIGKILL");
      if (activeAgentName) removePidFile(activeAgentName);
      closeLog();
      process.exit(0);
    }
    stopped = true;
    log("Shutting down...");
    if (activeAgentName) removePidFile(activeAgentName);
    if (cp) {
      cp.kill("SIGTERM");
      setTimeout(() => { getCurrentProcess()?.kill("SIGKILL"); closeLog(); process.exit(0); }, 5000);
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

// ── Main loop helpers ────────────────────────────────────────────
function printBanner(config: AgentConfig): void {
  const modeLabel = config.mode === "supervised"
    ? "supervised (Telegram)"
    : config.singlePhase ? "autonomous (single-phase)" : "autonomous";
  const _home = process.env.HOME || "/root";
  const prettyPath = (p: string) => p.startsWith(_home) ? "~" + p.slice(_home.length) : p;
  const lines = [
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
  for (const line of lines) out(line, line);
}

async function logWorkActivity(work: WorkData, config: AgentConfig): Promise<void> {
  const taskCount = work.tasks.length;
  const commentCount = work.commentUpdates.length;

  if (work.phase === "comments") {
    ok(`${commentCount} task(s) have new comments`);
    for (const cu of work.commentUpdates) dim(`  💬 #${cu.id}: ${cu.title} (${cu.new_comment_count} new)`);
    if (config.mode === "supervised") {
      for (const cu of work.commentUpdates) {
        try { await tgSend(config, `💬 New comment on task #${cu.id}: ${cu.title}`); }
        catch (e) { err(`Telegram send failed: ${(e as Error).message}`); }
      }
    }
  } else if (work.phase === "single") {
    ok(`${taskCount} new task(s) — single-phase (explore+execute)`);
    for (const t of work.tasks) dim(`  ⚡ #${t.id}: ${t.title}`);
  } else if (work.phase === "plan") {
    ok(`${taskCount} new task(s) — creating plans for approval`);
    for (const t of work.tasks) dim(`  📋 #${t.id}: ${t.title}`);
  } else if (work.phase === "execute") {
    ok(`${taskCount} task(s) — executing`);
    for (const t of work.tasks) dim(`  🚀 #${t.id}: ${t.title}`);
    if (config.mode === "supervised") {
      for (const t of work.tasks) {
        try { await tgSend(config, `🚀 Executing task #${t.id}: ${t.title}`); }
        catch (e) { err(`Telegram send failed: ${(e as Error).message}`); }
      }
    }
  }
}

async function handleCycleResult(code: number, work: WorkData, elapsed: number, config: AgentConfig): Promise<void> {
  if (code === 0) {
    ok(`${work.phase} phase complete in ${elapsed}s`);

    if (config.mode === "auto" && work.phase === "plan") {
      for (const t of work.tasks) {
        await lota("POST", `/tasks/${t.id}/status`, { status: "approved" });
        ok(`Task #${t.id} auto-approved — will execute next cycle`);
      }
    }

    if (config.mode === "supervised" && work.phase === "plan") {
      for (const t of work.tasks) {
        ok(`Waiting for Telegram approval for task #${t.id}...`);
        const approved = await tgWaitForApproval(config, t.id, t.title);
        if (approved) {
          await lota("POST", `/tasks/${t.id}/status`, { status: "approved" });
          ok(`Task #${t.id} approved via Telegram`);
        } else {
          ok(`Task #${t.id} rejected via Telegram — skipping`);
        }
      }
    }

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
    for (const t of work.tasks) {
      lota("POST", `/tasks/${t.id}/comment`, {
        content: `⚠️ Agent crashed (exit code ${code}). Task reset to assigned for retry.`,
      }).catch(e => dim(`Comment failed for task #${t.id}: ${(e as Error).message}`));
      lota("POST", `/tasks/${t.id}/status`, { status: "assigned" }).catch(e => dim(`Status reset failed for task #${t.id}: ${(e as Error).message}`));
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const config = parseArgs();
  activeAgentName = config.agentName;

  checkAndCleanStalePid(config.agentName);
  writePidFile(config.agentName, config.model);

  if (config.mode === "supervised" && !config.telegramChatId) {
    try { config.telegramChatId = await tgSetupChatId(config); ok("Telegram connected!"); }
    catch (e) { err((e as Error).message); process.exit(1); }
  }

  printBanner(config);
  log("━━━ Agent active, waiting for tasks ━━━");
  console.log("");

  if (config.mode === "supervised") {
    try { await tgSend(config, "🤖 Lota is online. Watching for tasks."); }
    catch (e) { err(`Telegram send failed: ${(e as Error).message}`); }
  }

  await recoverStaleTasks(config);

  let emptyPolls = 0;
  let pollCycles = 0;
  const MAX_INTERVAL_MULTIPLIER = 4;

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
      const nextInterval = config.interval * Math.min(emptyPolls, MAX_INTERVAL_MULTIPLIER);
      if (emptyPolls === 1 || emptyPolls % 10 === 0) dim(`No pending work (${emptyPolls} checks) — next in ${nextInterval}s`);
      if (pollCycles % 10 === 0) { logMemory("Periodic", config); await checkRuntimeStaleTasks(config); }
      if (config.once) break;
      await sleep(nextInterval);
      continue;
    }

    emptyPolls = 0;
    await logWorkActivity(work, config);
    console.log("  ─────────────────────────────────────");
    logMemory("Pre-Claude", config);

    const cycleStart = Date.now();
    let code: number;
    try {
      code = await runClaude(config, work);
    } catch (e) {
      err(`runClaude threw an unexpected error: ${(e as Error).message ?? String(e)}`);
      resetBusy();
      if (config.once) break;
      await sleep(config.interval);
      continue;
    }

    const elapsed = Math.round((Date.now() - cycleStart) / 1000);
    logMemory("Post-Claude", config);
    console.log("  ─────────────────────────────────────");

    await handleCycleResult(code, work, elapsed, config);

    const processedIds = [...work.tasks.map(t => t.id), ...work.commentUpdates.map(cu => cu.id)];
    if (processedIds.length) await refreshCommentBaselines(processedIds);

    if (config.once) break;

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
