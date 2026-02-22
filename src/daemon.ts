#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";


// ── Config ──────────────────────────────────────────────────────

interface AgentConfig {
  configPath: string;
  model: string;
  interval: number;
  once: boolean;
  agentId: string;
  serviceKey: string;
  apiUrl: string;
  supabaseUrl: string;
}

function parseArgs(): AgentConfig {
  const args = process.argv.slice(2);
  let interval = 60;
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

Autonomous LOTA agent with Realtime notifications.
Listens for assigned tasks, plans, executes, and reports.

Options:
  -c, --config <path>   MCP config file (default: .mcp.json)
  -m, --model <model>   Claude model (default: sonnet)
  -i, --interval <sec>  Fallback poll interval in seconds (default: 60)
  -1, --once            Run once then exit
  -h, --help            Show this help`);
        process.exit(0);
    }
  }

  // Find .mcp.json
  const configPath = mcpConfig
    ? resolve(mcpConfig)
    : [resolve(".mcp.json"), resolve(process.env.HOME || "~", ".mcp.json")]
        .find(existsSync) || "";

  if (!configPath) {
    console.error("Error: .mcp.json not found. Run: lota-agent --help");
    process.exit(1);
  }

  // Read credentials from .mcp.json
  let agentId = "", serviceKey = "", apiUrl = "", supabaseUrl = "";
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    const env = cfg.mcpServers?.lota?.env || {};
    agentId = env.LOTA_AGENT_ID || "";
    serviceKey = env.LOTA_SERVICE_KEY || "";
    apiUrl = env.LOTA_API_URL || "https://lota-five.vercel.app";
    supabaseUrl = env.LOTA_SUPABASE_URL || "https://sewcejktazokzzrzsavo.supabase.co";
  } catch (e) {
    console.error(`Error reading ${configPath}: ${(e as Error).message}`);
    process.exit(1);
  }

  if (!agentId) { console.error("Error: LOTA_AGENT_ID missing in .mcp.json"); process.exit(1); }
  if (!serviceKey) { console.error("Error: LOTA_SERVICE_KEY missing in .mcp.json"); process.exit(1); }

  return { configPath, model, interval, once, agentId, serviceKey, apiUrl, supabaseUrl };
}

// ── Logging (stdout + file) ──────────────────────────────────────

const LOG_DIR = join(process.env.HOME || "/tmp", ".lota");
const LOG_FILE = join(LOG_DIR, "agent.log");
mkdirSync(LOG_DIR, { recursive: true });
writeFileSync(LOG_FILE, ""); // clear on start

const time = () => new Date().toLocaleTimeString("tr-TR", { hour12: false });

function out(msg: string, plain: string) {
  console.log(msg);
  appendFileSync(LOG_FILE, `${plain}\n`);
}

const PRE = "\x1b[36m[lota-agent]\x1b[0m";
const log = (msg: string) => out(`${PRE} \x1b[90m${time()}\x1b[0m ${msg}`, `[${time()}] ${msg}`);
const ok = (msg: string) => out(`${PRE} \x1b[90m${time()}\x1b[0m \x1b[32m✓ ${msg}\x1b[0m`, `[${time()}] ✓ ${msg}`);
const dim = (msg: string) => out(`${PRE} \x1b[90m${time()} ${msg}\x1b[0m`, `[${time()}] ${msg}`);
const err = (msg: string) => out(`${PRE} \x1b[90m${time()}\x1b[0m \x1b[31m✗ ${msg}\x1b[0m`, `[${time()}] ✗ ${msg}`);
const warn = (msg: string) => out(`${PRE} \x1b[90m${time()}\x1b[0m \x1b[33m⚠ ${msg}\x1b[0m`, `[${time()}] ⚠ ${msg}`);

// ── Prompt ──────────────────────────────────────────────────────

const PROMPT = [
  "You are an autonomous LOTA agent. Follow these steps:",
  "",
  "1. Call tasks(status='assigned') to check your assigned tasks",
  "2. If no assigned tasks, respond: 'No assigned tasks.' and stop.",
  "3. If there are tasks, pick the first one:",
  "   a. Call task(id) to read full details",
  "   b. If no technical_plan exists, call plan() to create one",
  "   c. Call status(id, 'in_progress')",
  "   d. Execute the plan: read files, write code, run tests",
  "   e. Call complete(id, summary, files_modified, files_created)",
  "4. Move to the next task if any remain.",
].join("\n");

// ── Claude subprocess ───────────────────────────────────────────

let currentProcess: ChildProcess | null = null;
let busy = false;

function runClaude(config: AgentConfig): Promise<number> {
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

    const child = spawn("claude", [
      "--print",
      "--dangerously-skip-permissions",
      "--model", config.model,
      "--mcp-config", config.configPath,
      "-p", PROMPT,
    ], {
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

// ── Realtime ────────────────────────────────────────────────────

async function resolveMemberUuid(config: AgentConfig): Promise<string> {
  const res = await fetch(`${config.apiUrl}/api/members`, {
    headers: { "Content-Type": "application/json", "x-service-key": config.serviceKey },
  });
  if (!res.ok) throw new Error(`Members API: ${res.status}`);
  const members = await res.json() as { id: string; agent_id: string }[];
  const member = members.find(m => m.agent_id === config.agentId);
  if (!member) throw new Error(`Agent "${config.agentId}" not found in members`);
  return member.id;
}

function startRealtime(config: AgentConfig, memberUuid: string, onEvent: (reason: string) => void): RealtimeChannel {
  const supabase = createClient(config.supabaseUrl, config.serviceKey);

  const channel = supabase
    .channel("agent-events")
    .on("postgres_changes", {
      event: "UPDATE",
      schema: "public",
      table: "tasks",
      filter: `assigned_to=eq.${memberUuid}`,
    }, (payload) => {
      const task = payload.new as { id: string; status: string; title?: string };
      if (task.status === "assigned") {
        ok(`Realtime: Task assigned → ${task.title || task.id}`);
        onEvent("task_assigned");
      }
    })
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "messages",
      filter: `receiver_id=eq.${memberUuid}`,
    }, () => {
      log("Realtime: New message received");
      onEvent("new_message");
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        ok("Realtime connected — listening for events");
      } else if (status === "CLOSED" || status === "CHANNEL_ERROR") {
        warn(`Realtime: ${status}`);
      }
    });

  return channel;
}

// ── Shutdown ────────────────────────────────────────────────────

let stopped = false;
let sleepResolve: (() => void) | null = null;
let realtimeChannel: RealtimeChannel | null = null;

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopped) {
      if (currentProcess) currentProcess.kill("SIGKILL");
      process.exit(0);
    }
    stopped = true;
    log("Shutting down...");
    realtimeChannel?.unsubscribe();
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

function sleep(sec: number): Promise<void> {
  return new Promise((r) => {
    sleepResolve = r;
    setTimeout(() => { sleepResolve = null; r(); }, sec * 1000);
  });
}

function wakeUp() {
  if (sleepResolve) {
    const r = sleepResolve;
    sleepResolve = null;
    r();
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const config = parseArgs();

  const banner = [
    "",
    "  ┌─────────────────────────┐",
    "  │      LOTA Agent         │",
    "  └─────────────────────────┘",
    `  agent:    ${config.agentId}`,
    `  model:    ${config.model}`,
    `  config:   ${config.configPath}`,
    `  interval: ${config.interval}s (fallback)`,
    `  log:      ${LOG_FILE}`,
    "",
  ];
  for (const line of banner) {
    console.log(line);
    appendFileSync(LOG_FILE, `${line}\n`);
  }

  // Connect Realtime FIRST, wait for connection before starting loop
  let realtimeReady = false;
  try {
    log("Resolving member UUID...");
    const memberUuid = await resolveMemberUuid(config);
    ok(`Member UUID: ${memberUuid}`);

    log("Connecting to Supabase Realtime...");
    realtimeChannel = startRealtime(config, memberUuid, (reason) => {
      log(`Wake up: ${reason}`);
      wakeUp();
    });

    // Wait a bit for Realtime to connect
    await new Promise<void>((r) => setTimeout(r, 2000));
    realtimeReady = true;
  } catch (e) {
    warn(`Realtime unavailable: ${(e as Error).message}`);
    warn("Running in poll-only mode.");
  }

  console.log("");
  log("━━━ Agent active, waiting for tasks ━━━");
  console.log("");

  // Main loop
  while (!stopped) {
    log("Checking for tasks...");
    console.log("  ─────────────────────────────────────");

    const code = await runClaude(config);

    console.log("  ─────────────────────────────────────");
    if (code === 0) {
      ok("Cycle complete.");
    } else {
      err(`Claude exited with code ${code}`);
    }

    if (config.once) break;

    if (realtimeReady) {
      dim(`Listening... (Realtime active, fallback poll in ${config.interval}s)`);
    } else {
      dim(`Polling in ${config.interval}s...`);
    }
    await sleep(config.interval);
  }

  if (!stopped) {
    realtimeChannel?.unsubscribe();
  }
}

main();
