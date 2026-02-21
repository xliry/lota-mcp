#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import { LotaApiClient } from "./api.js";
import type { Task, Message } from "./types.js";

// ── Logger ──────────────────────────────────────────────────────────

const log = {
  info: (msg: string) => console.log(`[${ts()}] INFO  ${msg}`),
  warn: (msg: string) => console.log(`[${ts()}] WARN  ${msg}`),
  error: (msg: string) => console.error(`[${ts()}] ERROR ${msg}`),
};

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// ── Config ──────────────────────────────────────────────────────────

interface RunnerConfig {
  agentId: string;
  pollInterval: number;
  workDir: string;
  model: string;
  apiUrl: string;
  serviceKey: string;
  supabaseUrl: string;
  skipPlan: boolean;
  mcpServerPath: string;
}

interface ConfigFile {
  agent_id: string;
  api_url?: string;
  service_key?: string;
  work_dir?: string;
  model?: string;
  poll_interval?: number;
  supabase_url?: string;
  skip_plan?: boolean;
  mcp_server_path?: string;
}

function parseArgs(): RunnerConfig {
  const args = process.argv.slice(2);
  let configFile = "";
  let agentId = "";
  let pollInterval = 60000;
  let workDir = process.cwd();
  let model = "sonnet";
  let supabaseUrl = "";
  let skipPlan = false;
  let mcpServerPath = "";

  // First pass: check for --config
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config") configFile = args[++i];
  }

  // Load config file if provided
  if (configFile) {
    const configPath = resolve(configFile);
    if (!existsSync(configPath)) {
      console.error(`Config file not found: ${configPath}`);
      process.exit(1);
    }
    try {
      const cfg: ConfigFile = JSON.parse(readFileSync(configPath, "utf-8"));
      if (cfg.agent_id) agentId = cfg.agent_id;
      if (cfg.api_url) process.env.LOTA_API_URL = cfg.api_url;
      if (cfg.service_key) process.env.LOTA_SERVICE_KEY = cfg.service_key;
      if (cfg.work_dir) workDir = resolve(cfg.work_dir);
      if (cfg.model) model = cfg.model;
      if (cfg.poll_interval) pollInterval = cfg.poll_interval;
      if (cfg.supabase_url) supabaseUrl = cfg.supabase_url;
      if (cfg.skip_plan) skipPlan = cfg.skip_plan;
      if (cfg.mcp_server_path) mcpServerPath = cfg.mcp_server_path;
    } catch (e) {
      console.error(`Failed to parse config file: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  // CLI args override config file
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--agent-id":
        agentId = args[++i];
        break;
      case "--poll-interval":
        pollInterval = parseInt(args[++i], 10);
        break;
      case "--work-dir":
        workDir = args[++i];
        break;
      case "--model":
        model = args[++i];
        break;
      case "--supabase-url":
        supabaseUrl = args[++i];
        break;
      case "--skip-plan":
        skipPlan = true;
        break;
      case "--config":
        i++; // already handled
        break;
    }
  }

  const apiUrl = process.env.LOTA_API_URL || "https://lota-five.vercel.app";
  const serviceKey = process.env.LOTA_SERVICE_KEY || "";

  if (!agentId) {
    console.error(`Usage: node dist/runner.js --config agent.json
   or: node dist/runner.js --agent-id <id> [options]

Options:
  --config <path>        JSON config file (recommended)
  --agent-id <id>        Agent ID
  --work-dir <path>      Working directory (default: cwd)
  --model <model>        Claude model (default: sonnet)
  --poll-interval <ms>   Poll interval (default: 60000)
  --supabase-url <url>   Supabase project URL
  --skip-plan            Skip planning phase, go straight to execution

Env vars: LOTA_API_URL, LOTA_SERVICE_KEY`);
    process.exit(1);
  }
  if (!serviceKey) {
    console.error("Error: LOTA_SERVICE_KEY is required (env var or config file)");
    process.exit(1);
  }

  if (!supabaseUrl) {
    supabaseUrl = "https://sewcejktazokzzrzsavo.supabase.co";
  }

  // Default mcp_server_path to dist/index.js relative to this package
  if (!mcpServerPath) {
    mcpServerPath = join(import.meta.dirname, "index.js");
  }

  return { agentId, pollInterval, workDir, model, apiUrl, serviceKey, supabaseUrl, skipPlan, mcpServerPath };
}

// ── State ───────────────────────────────────────────────────────────

let config: RunnerConfig;
let api: LotaApiClient;
let currentTask: Task | null = null;
let currentPhase: "plan" | "execute" | null = null;
let currentProcess: ChildProcess | null = null;
const processedTaskIds = new Set<string>();
let lastMessageTimestamp: string;
let shuttingDown = false;
let realtimeChannel: RealtimeChannel | null = null;
let sleepResolve: (() => void) | null = null;

// ── API helpers ─────────────────────────────────────────────────────

async function fetchAssignedTasks(): Promise<Task[]> {
  return api.get<Task[]>("/api/tasks", {
    agentId: config.agentId,
    status: "assigned",
  });
}

async function fetchMessages(): Promise<Message[]> {
  return api.get<Message[]>("/api/messages", {
    agentId: config.agentId,
    since: lastMessageTimestamp,
  });
}

async function fetchTask(taskId: string): Promise<Task> {
  return api.get<Task>(`/api/tasks/${taskId}`);
}

async function updateTaskStatus(taskId: string, status: string): Promise<void> {
  await api.patch(`/api/tasks/${taskId}/status`, { status });
}

async function submitReport(taskId: string, output: string): Promise<void> {
  const summary = output.length > 500 ? output.slice(-500) : output;
  await api.post("/api/reports", {
    task_id: taskId,
    agent_id: config.agentId,
    summary,
  });
}

async function postComment(taskId: string, content: string): Promise<void> {
  await api.post(`/api/tasks/${taskId}/comments`, {
    agent_id: config.agentId,
    content,
  });
}

async function sendMessage(receiverId: string, content: string): Promise<void> {
  await api.post("/api/messages", {
    sender_agent_id: config.agentId,
    receiver_agent_id: receiverId,
    content,
  });
}

// ── Member UUID resolution ──────────────────────────────────────────

async function resolveMemberUuid(): Promise<string> {
  const members = await api.get<{ id: string; agent_id: string }[]>("/api/members");
  const member = members.find(m => m.agent_id === config.agentId);
  if (!member) throw new Error(`Member not found for agent_id: ${config.agentId}`);
  return member.id;
}

// ── Supabase Realtime ───────────────────────────────────────────────

function startRealtime(supabaseUrl: string, serviceKey: string, memberUuid: string): void {
  const supabase = createClient(supabaseUrl, serviceKey);

  realtimeChannel = supabase
    .channel("agent-events")
    .on("postgres_changes", {
      event: "UPDATE",
      schema: "public",
      table: "tasks",
      filter: `assigned_to=eq.${memberUuid}`,
    }, (payload) => {
      const task = payload.new as { id: string; status: string };
      if (task.status === "assigned" && !processedTaskIds.has(task.id)) {
        log.info(`Realtime: Task assigned -> ${task.id}`);
        wakeUp();
      }
    })
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "messages",
      filter: `receiver_id=eq.${memberUuid}`,
    }, (payload) => {
      const msg = payload.new as { sender_id: string };
      log.info(`Realtime: New message from ${msg.sender_id}`);
      wakeUp();
    })
    .subscribe((status) => {
      log.info(`Realtime subscription: ${status}`);
    });
}

// ── Prompt builders ─────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return [
    `You are agent "${config.agentId}" on the LOTA platform.`,
    `You have access to LOTA MCP tools for task management, reporting, and messaging.`,
    `Your agent_id is "${config.agentId}" — use it when calling tools that accept agent_id.`,
    `Work directory: ${config.workDir}`,
  ].join("\n");
}

function buildPlanPrompt(task: Task): string {
  const parts = [
    `# Task: ${task.title}`,
    `Task ID: ${task.id}`,
    `Priority: ${task.priority}`,
  ];

  if (task.brief) {
    parts.push("", "## Brief", task.brief);
  }

  parts.push(
    "",
    "## Your Job: Create a Technical Plan",
    "",
    "You are in the PLANNING phase. Do NOT write any code yet.",
    "",
    "1. Read and understand the task brief above.",
    "2. Explore the codebase to understand the current state.",
    "3. Create a technical plan by calling `save_task_plan` with:",
    `   - id: "${task.id}"`,
    "   - goals: list of concrete goals (title + completed: false)",
    "   - affected_files: files that will need changes",
    "   - estimated_effort: 'low', 'medium', or 'high'",
    "   - notes: approach, trade-offs, anything relevant",
    "",
    "IMPORTANT: Only call save_task_plan. Do NOT write code, do NOT call submit_report.",
  );

  return parts.join("\n");
}

function buildExecutePrompt(task: Task): string {
  const parts = [
    `# Task: ${task.title}`,
    `Task ID: ${task.id}`,
    `Priority: ${task.priority}`,
  ];

  if (task.brief) {
    parts.push("", "## Brief", task.brief);
  }

  if (task.technical_plan) {
    const plan = task.technical_plan;
    parts.push("", "## Technical Plan (approved)");
    if (plan.goals.length > 0) {
      parts.push("### Goals");
      for (const g of plan.goals) {
        parts.push(`- [ ] ${g.title}`);
      }
    }
    if (plan.affected_files.length > 0) {
      parts.push("### Affected Files");
      for (const f of plan.affected_files) {
        parts.push(`- ${f}`);
      }
    }
    if (plan.notes) {
      parts.push("### Notes", plan.notes);
    }
  }

  parts.push(
    "",
    "## Your Job: Execute the Plan",
    "",
    "You are in the EXECUTION phase. The plan above has been approved.",
    "",
    "1. Implement each goal in the plan.",
    "2. When finished, call `submit_report` with:",
    `   - task_id: "${task.id}"`,
    `   - agent_id: "${config.agentId}"`,
    "   - summary: what you did",
    "   - deliverables, new_files, modified_files as appropriate",
  );

  return parts.join("\n");
}

// ── MCP config ──────────────────────────────────────────────────────

function writeTempMcpConfig(): string {
  const configPath = join(config.workDir, `.mcp-runner-${config.agentId}.json`);
  const mcpConfig = {
    mcpServers: {
      lota: {
        command: "node",
        args: [config.mcpServerPath],
        env: {
          LOTA_API_URL: config.apiUrl,
          LOTA_SERVICE_KEY: config.serviceKey,
          LOTA_AGENT_ID: config.agentId,
        },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2));
  return configPath;
}

function cleanupMcpConfig(configPath: string): void {
  try {
    if (existsSync(configPath)) unlinkSync(configPath);
  } catch {
    // ignore cleanup errors
  }
}

// ── Claude subprocess ───────────────────────────────────────────────

// Tools allowed per phase
const PLAN_TOOLS = [
  "mcp__lota__save_task_plan",
  "mcp__lota__post_comment",
  "mcp__lota__get_task",
  "Read", "Glob", "Grep", "Bash",
];

const EXECUTE_TOOLS = [
  "mcp__lota__submit_report",
  "mcp__lota__post_comment",
  "mcp__lota__get_task",
  "Read", "Glob", "Grep", "Bash",
  "Edit", "Write",
];

function spawnClaude(prompt: string, mcpConfigPath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const allowedTools = currentPhase === "plan" ? PLAN_TOOLS : EXECUTE_TOOLS;

    const args = [
      "--print",
      "--model", config.model,
      "--mcp-config", mcpConfigPath,
      "--system-prompt", buildSystemPrompt(),
      "--allowedTools", allowedTools.join(","),
      "-p", prompt,
    ];

    log.info(`Spawning claude (${currentPhase || "task"})...`);

    // Remove Claude Code session env vars to avoid nested session errors
    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (key.startsWith("CLAUDE_CODE") || key === "CLAUDECODE" || key === "CLAUDE_SHELL_SESSION_ID") {
        delete cleanEnv[key];
      }
    }

    const child = spawn("claude", args, {
      cwd: config.workDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanEnv,
    });

    currentProcess = child;

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("close", (code) => {
      currentProcess = null;
      resolve({ code, stdout, stderr });
    });

    child.on("error", (err) => {
      currentProcess = null;
      resolve({ code: 1, stdout, stderr: stderr + "\n" + err.message });
    });
  });
}

// ── Two-phase task executor ─────────────────────────────────────────

async function executeTask(task: Task): Promise<void> {
  if (processedTaskIds.has(task.id)) return;
  if (currentTask) {
    log.warn(`Already working on task ${currentTask.id}, skipping ${task.id}`);
    return;
  }

  processedTaskIds.add(task.id);
  currentTask = task;
  log.info(`━━━ Task: ${task.id} — ${task.title} ━━━`);

  const mcpConfigPath = writeTempMcpConfig();

  try {
    // ── Phase 1: Plan ────────────────────────────────────────────
    if (!config.skipPlan && !task.technical_plan) {
      currentPhase = "plan";
      log.info(`[Phase 1/2] Planning...`);

      try {
        await postComment(task.id, "Starting planning phase...");
      } catch { /* ignore */ }

      const planResult = await spawnClaude(buildPlanPrompt(task), mcpConfigPath);

      if (planResult.code !== 0) {
        log.error(`Planning failed (exit code ${planResult.code})`);
        try {
          await postComment(task.id, `Planning phase failed (exit ${planResult.code})`);
        } catch { /* ignore */ }
        currentPhase = null;
        currentTask = null;
        return;
      }

      log.info(`Planning complete, fetching updated task...`);

      // Re-fetch task to get the saved plan
      try {
        task = await fetchTask(task.id);
        currentTask = task;
      } catch (e) {
        log.error(`Failed to re-fetch task: ${(e as Error).message}`);
      }

      if (!task.technical_plan) {
        log.warn(`Agent did not save a plan. Proceeding to execution anyway.`);
      } else {
        log.info(`Plan saved: ${task.technical_plan.goals.length} goals, effort: ${task.technical_plan.estimated_effort}`);
      }
    } else if (task.technical_plan) {
      log.info(`Plan already exists, skipping to execution.`);
    } else {
      log.info(`--skip-plan enabled, skipping to execution.`);
    }

    // ── Phase 2: Execute ─────────────────────────────────────────
    currentPhase = "execute";
    log.info(`[Phase 2/2] Executing...`);

    try {
      await updateTaskStatus(task.id, "in_progress");
    } catch (e) {
      log.error(`Failed to update task status: ${(e as Error).message}`);
    }

    try {
      await postComment(task.id, "Starting execution phase...");
    } catch { /* ignore */ }

    const execResult = await spawnClaude(buildExecutePrompt(task), mcpConfigPath);

    if (execResult.code === 0) {
      log.info(`Execution complete.`);
      try {
        await submitReport(task.id, execResult.stdout);
        log.info(`Report submitted, task completed.`);
      } catch (e) {
        log.error(`Failed to submit report: ${(e as Error).message}`);
        try {
          await updateTaskStatus(task.id, "completed");
        } catch { /* ignore */ }
      }
    } else {
      log.error(`Execution failed (exit code ${execResult.code})`);
      try {
        await postComment(task.id, `Execution failed (exit ${execResult.code})`);
        if (task.delegated_from) {
          await sendMessage(
            task.delegated_from,
            `Task "${task.title}" (${task.id}) failed — exit code ${execResult.code}`
          );
        }
      } catch { /* ignore */ }
    }
  } finally {
    cleanupMcpConfig(mcpConfigPath);
    currentPhase = null;
    currentTask = null;
  }
}

// ── Message handler ─────────────────────────────────────────────────

async function handleMessage(message: Message): Promise<void> {
  const content = message.content.trim().toLowerCase();
  log.info(`Message from ${message.sender_id}: ${message.content.trim()}`);

  // Pattern: "start working on task <id>"
  const startMatch = content.match(/start\s+(?:working\s+on\s+)?task\s+(\S+)/);
  if (startMatch) {
    const taskId = startMatch[1];
    log.info(`Received request to start task: ${taskId}`);

    try {
      const task = await fetchTask(taskId);

      if (processedTaskIds.has(task.id)) {
        log.warn(`Task ${taskId} was already processed this session`);
        return;
      }

      if (currentTask) {
        log.warn(`Busy with task ${currentTask.id}, queueing ${taskId} for next poll`);
        return;
      }

      await executeTask(task);
    } catch (e) {
      log.error(`Failed to handle task request: ${(e as Error).message}`);
    }
    return;
  }

  // Pattern: "status" — reply with current status
  if (content === "status" || content === "what are you doing") {
    try {
      const reply = currentTask
        ? `Working on task ${currentTask.id}: "${currentTask.title}" (phase: ${currentPhase})`
        : "Idle, waiting for tasks.";
      if (message.sender_id) {
        await sendMessage(message.sender_id, reply);
      }
    } catch (e) {
      log.error(`Failed to send status reply: ${(e as Error).message}`);
    }
    return;
  }

  log.info(`Unrecognized message, ignoring.`);
}

// ── Poll functions ──────────────────────────────────────────────────

async function pollForTasks(): Promise<void> {
  if (currentTask) return;

  try {
    const tasks = await fetchAssignedTasks();
    for (const task of tasks) {
      if (!processedTaskIds.has(task.id)) {
        await executeTask(task);
        break;
      }
    }
  } catch (e) {
    log.error(`Poll tasks error: ${(e as Error).message}`);
  }
}

async function pollForMessages(): Promise<void> {
  try {
    const messages = await fetchMessages();
    for (const msg of messages) {
      await handleMessage(msg);
      if (msg.created_at > lastMessageTimestamp) {
        lastMessageTimestamp = msg.created_at;
      }
    }
  } catch (e) {
    log.error(`Poll messages error: ${(e as Error).message}`);
  }
}

async function pollCycle(): Promise<void> {
  await pollForMessages();
  await pollForTasks();
}

// ── Shutdown ────────────────────────────────────────────────────────

function setupShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down...`);

    if (realtimeChannel) {
      realtimeChannel.unsubscribe();
      realtimeChannel = null;
      log.info("Realtime unsubscribed.");
    }

    wakeUp();

    if (currentProcess) {
      log.info("Waiting for active subprocess to finish...");
      currentProcess.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (currentProcess) {
            log.warn("Subprocess did not exit in time, killing...");
            currentProcess.kill("SIGKILL");
          }
          resolve();
        }, 30000);

        const check = setInterval(() => {
          if (!currentProcess) {
            clearInterval(check);
            clearTimeout(timeout);
            resolve();
          }
        }, 500);
      });
    }

    log.info("Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  config = parseArgs();

  api = new LotaApiClient();
  api.setAgentId(config.agentId);

  lastMessageTimestamp = new Date().toISOString();

  setupShutdownHandlers();

  log.info("╔══════════════════════════════════════╗");
  log.info("║       LOTA Agent Runner v3.0         ║");
  log.info("╚══════════════════════════════════════╝");
  log.info(`Agent:     ${config.agentId}`);
  log.info(`API:       ${config.apiUrl}`);
  log.info(`Supabase:  ${config.supabaseUrl}`);
  log.info(`Work dir:  ${config.workDir}`);
  log.info(`Model:     ${config.model}`);
  log.info(`Poll:      ${config.pollInterval}ms (fallback)`);
  log.info(`Planning:  ${config.skipPlan ? "disabled" : "enabled"}`);
  log.info("");

  // Verify connectivity
  try {
    const tasks = await fetchAssignedTasks();
    log.info(`Connected. Found ${tasks.length} assigned task(s).`);
  } catch (e) {
    log.error(`Failed to connect to LOTA API: ${(e as Error).message}`);
    process.exit(1);
  }

  // Resolve member UUID for Realtime filters
  let memberUuid: string;
  try {
    memberUuid = await resolveMemberUuid();
    log.info(`Resolved member UUID: ${memberUuid}`);
  } catch (e) {
    log.error(`Failed to resolve member UUID: ${(e as Error).message}`);
    log.warn("Continuing without Realtime (poll-only mode).");
    memberUuid = "";
  }

  // Start Supabase Realtime subscription
  if (memberUuid) {
    startRealtime(config.supabaseUrl, config.serviceKey, memberUuid);
  }

  // Main loop
  log.info("Entering poll loop...");
  while (!shuttingDown) {
    await pollCycle();
    await sleep(config.pollInterval);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    sleepResolve = resolve;
    setTimeout(() => {
      sleepResolve = null;
      resolve();
    }, ms);
  });
}

function wakeUp(): void {
  if (sleepResolve) {
    const resolve = sleepResolve;
    sleepResolve = null;
    resolve();
  }
}

main().catch((e) => {
  log.error(`Fatal: ${(e as Error).message}`);
  process.exit(1);
});
