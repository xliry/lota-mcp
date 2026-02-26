#!/usr/bin/env node
import { spawn, execSync, type ChildProcess } from "node:child_process";
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

  // .mcp.json is optional now — token can come from env or gh auth

  // Read credentials from .mcp.json
  let githubToken = "", githubRepo = "", agentName = "";
  if (configPath) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      const env = cfg.mcpServers?.lota?.env || {};
      githubToken = env.GITHUB_TOKEN || "";
      githubRepo = env.GITHUB_REPO || "";
      agentName = env.AGENT_NAME || "";
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
    } catch { /* gh not installed or not logged in */ }
  }
  if (!githubToken) {
    console.error("Error: GitHub token not found. Checked: .mcp.json, $GITHUB_TOKEN env, gh auth token");
    process.exit(1);
  }

  // Defaults
  if (!githubRepo) githubRepo = process.env.GITHUB_REPO || "xliry/lota-agents";
  if (!agentName) agentName = process.env.AGENT_NAME || "lota";

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

const PRE = "\x1b[36m[lota]\x1b[0m";
const log = (msg: string) => out(`${PRE} \x1b[90m${time()}\x1b[0m ${msg}`, `[${time()}] ${msg}`);
const ok = (msg: string) => out(`${PRE} \x1b[90m${time()}\x1b[0m \x1b[32m✓ ${msg}\x1b[0m`, `[${time()}] ✓ ${msg}`);
const dim = (msg: string) => out(`${PRE} \x1b[90m${time()} ${msg}\x1b[0m`, `[${time()}] ${msg}`);
const err = (msg: string) => out(`${PRE} \x1b[90m${time()}\x1b[0m \x1b[31m✗ ${msg}\x1b[0m`, `[${time()}] ✗ ${msg}`);

// ── Pre-check (zero-cost, no LLM) ──────────────────────────────

interface WorkData {
  tasks: { id: number; title: string; status: string; body?: string; workspace?: string }[];
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

function buildPrompt(agentName: string, work: WorkData, config: AgentConfig): string {
  const repoOwner = config.githubRepo.split("/")[0] || agentName;
  const lines = [
    `You are autonomous LOTA agent "${agentName}". Use the lota() MCP tool for all API calls.`,
    "",
    "── RULES ──",
    "  GIT COMMIT RULES (MUST follow):",
    `    - git config user.name "${agentName}"`,
    `    - git config user.email "${repoOwner}@users.noreply.github.com"`,
    "    - NEVER put tokens or credentials in git remote URLs",
    "    - Use `git push` directly — GITHUB_TOKEN is already in your environment",
    "    - If remote URL needs auth, use: git remote set-url origin https://x-access-token:${GITHUB_TOKEN}@github.com/OWNER/REPO.git",
    "",
    "  REPO & WORKSPACE RULES:",
    "    - Task body may contain a repo link (e.g. 'Repo: https://github.com/user/project').",
    "    - If a repo link is provided: clone it to a temp dir, work there, commit and push when done.",
    "    - If a local workspace path is also provided AND it exists, use that instead of cloning.",
    "    - Use `git remote set-url origin https://x-access-token:${GITHUB_TOKEN}@github.com/OWNER/REPO.git` for push access.",
    "    - Use Write/Edit tools for file operations, NOT cat/heredoc via Bash.",
  ];

  // Subagent instructions
  lines.push(
    "",
    "── SUBAGENTS ──",
    "  Use the Task tool to spawn subagents for parallel and focused work:",
    "  - Explore agent (subagent_type: 'Explore'): Search codebase, find files, understand architecture",
    "  - Plan agent (subagent_type: 'Plan'): Design implementation approach before coding",
    "  - General agent (subagent_type: 'general-purpose'): Execute complex multi-step tasks",
    "",
    "  ALWAYS explore before planning. ALWAYS plan before coding.",
    "  Launch multiple Explore agents in parallel when investigating different areas.",
    "  Example:",
    '    Task({ prompt: "Find all auth-related files and understand the login flow", subagent_type: "Explore" })',
    '    Task({ prompt: "Search for existing test patterns in this project", subagent_type: "Explore" })',
  );

  if (work.tasks.length) {
    lines.push("", "── ASSIGNED TASKS ──");
    for (const t of work.tasks) {
      lines.push(`  Task #${t.id}: ${t.title || "(untitled)"}`);
      if (t.workspace) {
        lines.push(`  Workspace: ${t.workspace} (project is here — DO NOT clone)`);
      }
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
      "    2. Explore: Spawn Explore subagents to understand the codebase and affected areas",
      `    3. Plan: Use a Plan subagent OR save plan via lota("POST", "/tasks/<id>/plan", {"goals": [...], "affected_files": [], "effort": "medium"})`,
      `    4. Set status: lota("POST", "/tasks/<id>/status", {"status": "in-progress"})`,
      "    5. Execute: Write code, run tests. Use general-purpose subagents for parallel work if needed.",
      `    6. Complete: lota("POST", "/tasks/<id>/complete", {"summary": "...", "modified_files": [], "new_files": []})`,
    );
  }

  return lines.join("\n");
}

// ── Event formatter (stream-json → readable log) ────────────────

function formatEvent(event: any) {
  const t = time();
  const write = (icon: string, msg: string) => {
    const plain = `[${t}] ${icon} ${msg}`;
    const colored = `${PRE} \x1b[90m${t}\x1b[0m ${icon} ${msg}`;
    console.log(colored);
    appendFileSync(LOG_FILE, `${plain}\n`);
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
          const cmd = (input.command || "").slice(0, 120);
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
      "--verbose",
      "--output-format", "stream-json",
      ...(isRoot ? [] : ["--dangerously-skip-permissions"]),
      "--model", config.model,
      ...(config.configPath ? ["--mcp-config", config.configPath] : []),
      "-p", buildPrompt(config.agentName, work, config),
    ];

    if (isRoot) {
      dim("Running as root — skipping --dangerously-skip-permissions");
    }

    // Use workspace from first task as cwd if available
    const taskWorkspace = work.tasks[0]?.workspace;
    const workingDir = taskWorkspace && existsSync(taskWorkspace) ? taskWorkspace : process.cwd();
    if (taskWorkspace) {
      if (existsSync(taskWorkspace)) {
        ok(`Workspace: ${taskWorkspace}`);
      } else {
        err(`Workspace not found: ${taskWorkspace} — using cwd`);
      }
    }

    const child = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: workingDir,
      env: cleanEnv,
    });

    currentProcess = child;

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
          appendFileSync(LOG_FILE, `  ${line}\n`);
        }
      }
    });

    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      for (const line of text.split("\n")) {
        if (line.trim()) {
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
    "  │         Lota            │",
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
