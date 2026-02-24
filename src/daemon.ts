#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { lota } from "./github.js";


// ── Config ──────────────────────────────────────────────────────

interface AgentConfig {
  configPath: string;
  model: string;
  interval: number;
  once: boolean;
  agentName: string;
  githubToken: string;
  githubRepo: string;
}

function parseArgs(): AgentConfig {
  const args = process.argv.slice(2);
  let interval = 15;
  let once = false;
  let mcpConfig = "";
  let model = "sonnet";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--interval": case "-i": interval = parseInt(args[++i], 10); break;
      case "--once": case "-1": once = true; break;
      case "--config": case "-c": mcpConfig = args[++i]; break;
      case "--model": case "-m": model = args[++i]; break;
      case "--help": case "-h":
        console.log(`Usage: lota-agent [options]

Autonomous LOTA agent (GitHub-backed).
Listens for assigned tasks, plans, executes, and reports.

Options:
  -c, --config <path>   MCP config file (default: .mcp.json)
  -m, --model <model>   Claude model (default: sonnet)
  -i, --interval <sec>  Poll interval in seconds (default: 15)
  -1, --once            Run once then exit
  -h, --help            Show this help`);
        process.exit(0);
    }
  }

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

  if (!configPath) {
    console.error("Error: .mcp.json not found. Run: lota-agent --help");
    process.exit(1);
  }

  // Read credentials from .mcp.json
  let githubToken = "", githubRepo = "", agentName = "";
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    const env = cfg.mcpServers?.lota?.env || {};
    githubToken = env.GITHUB_TOKEN || "";
    githubRepo = env.GITHUB_REPO || "";
    agentName = env.AGENT_NAME || "";
  } catch (e) {
    console.error(`Error reading ${configPath}: ${(e as Error).message}`);
    process.exit(1);
  }

  if (!githubToken) { console.error("Error: GITHUB_TOKEN missing in .mcp.json"); process.exit(1); }
  if (!githubRepo) { console.error("Error: GITHUB_REPO missing in .mcp.json"); process.exit(1); }
  if (!agentName) { console.error("Error: AGENT_NAME missing in .mcp.json"); process.exit(1); }

  return { configPath, model, interval, once, agentName, githubToken, githubRepo };
}

// ── Logging (stdout + file) ──────────────────────────────────────

const LOG_DIR = join(process.env.HOME || "~", ".lota", "lota");
const LOG_FILE = join(LOG_DIR, "agent.log");
mkdirSync(LOG_DIR, { recursive: true });
writeFileSync(LOG_FILE, ""); // clear on start

const time = () => new Date().toLocaleTimeString("en-US", { hour12: false });

function out(msg: string, plain: string) {
  console.log(msg);
  appendFileSync(LOG_FILE, `${plain}\n`);
}

const PRE = "\x1b[36m[lota-agent]\x1b[0m";
const log = (msg: string) => out(`${PRE} \x1b[90m${time()}\x1b[0m ${msg}`, `[${time()}] ${msg}`);
const ok = (msg: string) => out(`${PRE} \x1b[90m${time()}\x1b[0m \x1b[32m✓ ${msg}\x1b[0m`, `[${time()}] ✓ ${msg}`);
const dim = (msg: string) => out(`${PRE} \x1b[90m${time()} ${msg}\x1b[0m`, `[${time()}] ${msg}`);
const err = (msg: string) => out(`${PRE} \x1b[90m${time()}\x1b[0m \x1b[31m✗ ${msg}\x1b[0m`, `[${time()}] ✗ ${msg}`);

// ── Pre-check (zero-cost, no LLM) ──────────────────────────────

interface WorkData {
  tasks: { id: number; title: string; status: string; body?: string }[];
}

async function checkForWork(config: AgentConfig): Promise<WorkData> {
  // Set env vars so github.ts can use them
  process.env.GITHUB_TOKEN = config.githubToken;
  process.env.GITHUB_REPO = config.githubRepo;
  process.env.AGENT_NAME = config.agentName;

  const data = await lota("GET", "/sync") as { tasks: WorkData["tasks"] };
  return { tasks: data.tasks || [] };
}

// ── Prompt ──────────────────────────────────────────────────────

function buildPrompt(agentName: string, work: WorkData): string {
  const lines = [
    `You are autonomous LOTA agent "${agentName}". Use the lota() MCP tool for all API calls.`,
  ];

  if (work.tasks.length) {
    lines.push("", "── ASSIGNED TASKS ──");
    for (const t of work.tasks) {
      lines.push(`  Task #${t.id}: ${t.title || "(untitled)"}`);
      if (t.body) {
        lines.push("", "  ── TASK BODY ──", t.body, "  ── END BODY ──");
      }
    }
    lines.push(
      "",
      "  IMPORTANT: Before starting any task, ALWAYS read the full task details and comments first:",
      `    lota("GET", "/tasks/<id>")`,
      "  Comments may contain critical updates, requirement changes, or tech stack decisions.",
      "",
      "  For each task:",
      `    1. Read full details: lota("GET", "/tasks/<id>") — check body AND comments for updates`,
      `    2. Save plan: lota("POST", "/tasks/<id>/plan", {"goals": [...], "affected_files": [], "effort": "medium"})`,
      `    3. Set status: lota("POST", "/tasks/<id>/status", {"status": "in-progress"})`,
      "    4. Execute: read files, write code, run tests.",
      `    5. Complete: lota("POST", "/tasks/<id>/complete", {"summary": "...", "modified_files": [], "new_files": []})`,
    );
  }

  return lines.join("\n");
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

    const isRoot = process.getuid?.() === 0;
    const args = [
      "--print",
      ...(isRoot ? [] : ["--dangerously-skip-permissions"]),
      "--model", config.model,
      "--mcp-config", config.configPath,
      "-p", buildPrompt(config.agentName, work),
    ];

    if (isRoot) {
      dim("Running as root — skipping --dangerously-skip-permissions");
    }

    const child = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
      env: cleanEnv,
    });

    currentProcess = child;

    child.stdout?.on("data", (d: Buffer) => {
      const text = d.toString();
      for (const line of text.split("\n")) {
        if (line.trim()) {
          console.log(`  ${line}`);
          appendFileSync(LOG_FILE, `  ${line}\n`);
        }
      }
    });

    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      for (const line of text.split("\n")) {
        if (line.trim()) {
          console.error(`  ${line}`);
          appendFileSync(LOG_FILE, `  [stderr] ${line}\n`);
        }
      }
    });

    child.on("close", (code) => {
      currentProcess = null;
      busy = false;
      resolve(code ?? 1);
    });

    child.on("error", (e) => {
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
      process.exit(0);
    }
    stopped = true;
    log("Shutting down...");
    if (currentProcess) {
      currentProcess.kill("SIGTERM");
      setTimeout(() => {
        if (currentProcess) currentProcess.kill("SIGKILL");
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

  const banner = [
    "",
    "  ┌─────────────────────────┐",
    "  │      LOTA Agent         │",
    "  └─────────────────────────┘",
    `  agent:    ${config.agentName}`,
    `  model:    ${config.model}`,
    `  config:   ${config.configPath}`,
    `  interval: ${config.interval}s`,
    `  log:      ${LOG_FILE}`,
    "",
  ];
  for (const line of banner) {
    console.log(line);
    appendFileSync(LOG_FILE, `${line}\n`);
  }

  log("━━━ Agent active, waiting for tasks ━━━");
  console.log("");

  // Main loop: poll → check → spawn → sleep
  while (!stopped) {
    log("Checking for work...");

    let work: WorkData;
    try {
      work = await checkForWork(config);
    } catch (e) {
      err(`Pre-check failed: ${(e as Error).message}`);
      if (config.once) break;
      await sleep(config.interval);
      continue;
    }

    const taskCount = work.tasks.length;

    if (taskCount === 0) {
      dim(`No pending work — skipped Claude spawn`);
    } else {
      ok(`Found ${taskCount} task(s)`);
      for (const t of work.tasks) {
        dim(`  → #${t.id}: ${t.title}`);
      }
      console.log("  ─────────────────────────────────────");

      const cycleStart = Date.now();
      const code = await runClaude(config, work);
      const elapsed = Math.round((Date.now() - cycleStart) / 1000);

      console.log("  ─────────────────────────────────────");
      if (code === 0) {
        ok(`Cycle complete in ${elapsed}s (${taskCount} task(s))`);
      } else {
        err(`Claude exited with code ${code} after ${elapsed}s`);
      }
    }

    if (config.once) break;

    dim(`Polling in ${config.interval}s...`);
    await sleep(config.interval);
  }
}

main();
