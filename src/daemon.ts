#!/usr/bin/env node
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { lota } from "./github.js";


// ── Config ──────────────────────────────────────────────────────

type AgentMode = "auto" | "supervised";

interface AgentConfig {
  configPath: string;
  model: string;
  interval: number;
  once: boolean;
  mode: AgentMode;
  agentName: string;
  githubToken: string;
  githubRepo: string;
  telegramBotToken: string;
  telegramChatId: string;
}

function parseArgs(): AgentConfig {
  const args = process.argv.slice(2);
  let interval = 15;
  let once = false;
  let mcpConfig = "";
  let model = "sonnet";
  let mode: AgentMode = "auto";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--interval": case "-i": interval = parseInt(args[++i], 10); break;
      case "--once": case "-1": once = true; break;
      case "--config": case "-c": mcpConfig = args[++i]; break;
      case "--model": case "-m": model = args[++i]; break;
      case "--mode": mode = args[++i] as AgentMode; break;
      case "--help": case "-h":
        console.log(`Usage: lota-agent [options]

Autonomous LOTA agent (GitHub-backed).
Listens for assigned tasks, plans, executes, and reports.

Options:
  -c, --config <path>   MCP config file (default: .mcp.json)
  -m, --model <model>   Claude model (default: sonnet)
  -i, --interval <sec>  Poll interval in seconds (default: 15)
  --mode <auto|supervised>  auto = direct execution, supervised = Telegram approval (default: auto)
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
    } catch { /* gh not installed or not logged in */ }
  }
  if (!githubToken) {
    console.error("Error: GitHub token not found. Checked: .mcp.json, $GITHUB_TOKEN env, gh auth token");
    process.exit(1);
  }

  // Defaults
  if (!githubRepo) githubRepo = process.env.GITHUB_REPO || "xliry/lota-agents";
  if (!agentName) agentName = process.env.AGENT_NAME || "lota";

  // Supervised mode requires Telegram
  if (mode === "supervised" && !telegramBotToken) {
    console.log("\n  Supervised mode requires Telegram. Let's set it up:\n");
    console.log("  1. Open @BotFather on Telegram, send /newbot");
    console.log("  2. Name it anything (e.g. 'My Lota')");
    console.log("  3. Set TELEGRAM_BOT_TOKEN in .mcp.json under mcpServers.lota.env");
    console.log("  4. Run again with --mode supervised\n");
    process.exit(1);
  }

  return { configPath, model, interval, once, mode, agentName, githubToken, githubRepo, telegramBotToken, telegramChatId };
}

// ── Telegram API ────────────────────────────────────────────────

async function tgApi(botToken: string, method: string, body?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as { ok: boolean; result?: unknown; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

async function tgSend(config: AgentConfig, text: string, inlineKeyboard?: unknown[][]): Promise<unknown> {
  if (!config.telegramBotToken || !config.telegramChatId) return null;
  const body: Record<string, unknown> = {
    chat_id: config.telegramChatId,
    text,
    parse_mode: "Markdown",
  };
  if (inlineKeyboard) {
    body.reply_markup = { inline_keyboard: inlineKeyboard };
  }
  return tgApi(config.telegramBotToken, "sendMessage", body);
}

async function tgSetupChatId(config: AgentConfig): Promise<string> {
  // Poll for /start message to discover chat_id
  console.log("\n  Waiting for you to send /start to your Telegram bot...");
  let lastUpdateId = 0;
  for (let attempt = 0; attempt < 60; attempt++) { // 5 minutes max
    const data = await tgApi(config.telegramBotToken, "getUpdates", {
      offset: lastUpdateId + 1,
      timeout: 5,
    }) as Array<{ update_id: number; message?: { chat: { id: number }; text?: string } }>;

    for (const update of data) {
      lastUpdateId = update.update_id;
      if (update.message?.text === "/start") {
        const chatId = String(update.message.chat.id);
        // Save to .mcp.json
        if (config.configPath) {
          const cfg = JSON.parse(readFileSync(config.configPath, "utf-8"));
          if (cfg.mcpServers?.lota?.env) {
            cfg.mcpServers.lota.env.TELEGRAM_CHAT_ID = chatId;
            writeFileSync(config.configPath, JSON.stringify(cfg, null, 2) + "\n");
          }
        }
        // Send confirmation
        await tgApi(config.telegramBotToken, "sendMessage", {
          chat_id: chatId,
          text: "✅ Connected to Lota! You'll receive task notifications and approval requests here.",
        });
        return chatId;
      }
    }
  }
  throw new Error("Telegram setup timed out. Send /start to your bot and try again.");
}

async function tgWaitForApproval(config: AgentConfig, taskId: number, taskTitle: string): Promise<boolean> {
  // Send approval request with inline buttons
  await tgSend(config, `📋 *Plan ready for approval*\n\nTask #${taskId}: ${taskTitle}\n\nReview the plan and approve or reject:`, [
    [
      { text: "✅ Approve", callback_data: `approve_${taskId}` },
      { text: "❌ Reject", callback_data: `reject_${taskId}` },
    ],
  ]);

  // Poll for callback response
  let lastUpdateId = 0;
  while (true) {
    const data = await tgApi(config.telegramBotToken, "getUpdates", {
      offset: lastUpdateId + 1,
      timeout: 30, // long poll
    }) as Array<{
      update_id: number;
      callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
    }>;

    for (const update of data) {
      lastUpdateId = update.update_id;
      const cb = update.callback_query;
      if (!cb?.data) continue;

      // Acknowledge the button press
      await tgApi(config.telegramBotToken, "answerCallbackQuery", { callback_query_id: cb.id });

      if (cb.data === `approve_${taskId}`) {
        await tgSend(config, `🚀 Task #${taskId} approved! Executing now.`);
        return true;
      }
      if (cb.data === `reject_${taskId}`) {
        await tgSend(config, `⏸ Task #${taskId} rejected. Add a comment on GitHub with feedback.`);
        return false;
      }
    }
  }
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

interface TaskInfo {
  id: number;
  title: string;
  status: string;
  body?: string;
  workspace?: string;
  comment_count?: number;
}

interface CommentUpdate {
  id: number;
  title: string;
  workspace?: string;
  new_comment_count: number;
}

interface WorkData {
  phase: "plan" | "execute" | "comments";
  tasks: TaskInfo[];
  commentUpdates: CommentUpdate[];
}

// Track comment counts for in-progress tasks
const lastSeenComments = new Map<number, number>();

async function checkForWork(config: AgentConfig): Promise<WorkData | null> {
  // Set env vars so github.ts can use them
  process.env.GITHUB_TOKEN = config.githubToken;
  process.env.GITHUB_REPO = config.githubRepo;
  process.env.AGENT_NAME = config.agentName;

  const data = await lota("GET", "/sync") as {
    assigned: TaskInfo[];
    approved: TaskInfo[];
    in_progress: (TaskInfo & { comment_count: number })[];
  };

  const assigned = data.assigned || [];
  const approved = data.approved || [];
  const inProgress = data.in_progress || [];
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

  // Clean up tracking for tasks no longer in-progress
  const activeIds = new Set(inProgress.map(t => t.id));
  for (const id of lastSeenComments.keys()) {
    if (!activeIds.has(id)) lastSeenComments.delete(id);
  }

  // Priority: comments > approved (execute) > assigned (plan)
  if (commentUpdates.length) {
    return { phase: "comments", tasks: [], commentUpdates };
  }
  if (approved.length) {
    return { phase: "execute", tasks: approved, commentUpdates: [] };
  }
  if (assigned.length) {
    return { phase: "plan", tasks: assigned, commentUpdates: [] };
  }

  return null; // nothing to do
}

// ── Prompt ──────────────────────────────────────────────────────

function buildPrompt(agentName: string, work: WorkData, config: AgentConfig): string {
  const repoOwner = config.githubRepo.split("/")[0] || agentName;
  const lines = [
    `You are autonomous LOTA agent "${agentName}". Use the lota() MCP tool for all API calls.`,
    "",
    "── RULES ──",
    "  GITHUB TOKEN ACCESS:",
    "    - Token file: ~/.lota/.github-token (read it with: cat ~/.lota/.github-token)",
    "    - For curl API calls: TOKEN=$(cat ~/.lota/.github-token) && curl -H \"Authorization: token $TOKEN\" ...",
    "    - Do NOT waste time looking for env vars, gh auth, or debugging auth. Just read the token file.",
    "",
    "  GIT RULES (MUST follow):",
    `    - git config user.name "${agentName}"`,
    `    - git config user.email "${repoOwner}@users.noreply.github.com"`,
    "    - Git credential helper is pre-configured. Just use plain URLs (git clone/push/pull work automatically).",
    "    - If git clone fails, read token and use: git clone https://x-access-token:$(cat ~/.lota/.github-token)@github.com/OWNER/REPO.git",
    "",
    "  WORKSPACE & REPO RULES (priority order):",
    "    1. If a task has a workspace path AND it exists locally → cd into it. Then run `git pull` to make sure it's up to date.",
    "    2. If no workspace but a repo link exists (e.g. 'Repo: https://github.com/user/project') → clone it to /root/<repo-name>, work there.",
    "    - ALWAYS git pull before starting work to ensure you have the latest code.",
    "    - NEVER git clone a repo that already exists locally — use the existing directory.",
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
    "  Launch multiple Explore agents in parallel when investigating different areas.",
  );

  // ── PHASE: COMMENTS ──
  if (work.phase === "comments") {
    lines.push("", "── NEW COMMENTS DETECTED ──");
    lines.push("  PRIORITY: Read these and respond appropriately.");
    for (const cu of work.commentUpdates) {
      lines.push(`  Task #${cu.id}: "${cu.title}" has ${cu.new_comment_count} new comment(s)`);
      lines.push(`    → Read them: lota("GET", "/tasks/${cu.id}")`);
      if (cu.workspace) {
        lines.push(`    → Workspace: ${cu.workspace}`);
      }
    }
    lines.push(
      "",
      "  After reading new comments:",
      "  - If the user is giving feedback → adjust your work accordingly",
      "  - If the user is asking a question → reply with a comment",
      "  - If the user is changing requirements → update your approach",
    );
  }

  // ── PHASE: PLAN (assigned tasks — create plan, wait for approval) ──
  if (work.phase === "plan" && work.tasks.length) {
    lines.push("", "── PLAN PHASE — Create plans for approval ──");
    lines.push("  These tasks are NEW and need a plan. The user will review before you execute.");
    lines.push("");
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
      "  WORKFLOW for each task:",
      `    1. Read full details: lota("GET", "/tasks/<id>")`,
      "    2. Explore the codebase to understand what's needed (use Explore subagents)",
      `    3. Create a detailed plan: lota("POST", "/tasks/<id>/plan", {"goals": [...], "affected_files": [...], "effort": "..."})`,
      `    4. Set status to planned: lota("POST", "/tasks/<id>/status", {"status": "planned"})`,
      "",
      "  IMPORTANT:",
      "  - Do NOT execute any code changes. Only explore and plan.",
      "  - The plan should be clear enough for the user to approve or give feedback.",
      "  - After setting status to 'planned', STOP. The user will approve via Hub.",
    );
  }

  // ── PHASE: EXECUTE (approved tasks — do the work) ──
  if (work.phase === "execute" && work.tasks.length) {
    lines.push("", "── EXECUTE PHASE — Approved tasks, ready to work ──");
    lines.push("  These tasks have been reviewed and approved. Execute them now.");
    lines.push("");
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
      "  IMPORTANT: Read the full task details AND comments (including the plan) first:",
      `    lota("GET", "/tasks/<id>")`,
      "  Comments may contain approval notes, adjustments, or extra instructions from the user.",
      "",
      "  WORKFLOW:",
      `    1. Read: lota("GET", "/tasks/<id>") — check plan + any user comments`,
      `    2. Set status: lota("POST", "/tasks/<id>/status", {"status": "in-progress"})`,
      "    3. Execute the plan. Use subagents for parallel work if needed.",
      `    4. Complete: lota("POST", "/tasks/<id>/complete", {"summary": "...", "modified_files": [], "new_files": []})`,
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

    // Configure git to use GITHUB_TOKEN for authentication
    // Set global git config so all git operations (clone/push/pull) work automatically
    try {
      execSync(`git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password=${config.githubToken}"; }; f'`, { stdio: "ignore" });
      execSync(`git config --global user.name "${config.agentName}"`, { stdio: "ignore" });
      execSync(`git config --global user.email "${config.githubRepo.split("/")[0]}@users.noreply.github.com"`, { stdio: "ignore" });
    } catch { /* git config may fail in some environments */ }

    // Write token to a file so agent's Bash tool can read it
    // (Claude Code may sandbox env vars from Bash commands)
    const tokenFile = join(process.env.HOME || "/root", ".lota", ".github-token");
    try {
      writeFileSync(tokenFile, config.githubToken, { mode: 0o600 });
    } catch { /* may fail in some environments */ }

    // Ensure global Claude settings allow all tools (needed when --dangerously-skip-permissions
    // doesn't work, e.g. root user where it requires interactive confirmation)
    const claudeSettingsDir = join(process.env.HOME || "/root", ".claude");
    const claudeSettingsFile = join(claudeSettingsDir, "settings.json");
    try {
      mkdirSync(claudeSettingsDir, { recursive: true });
      const settings = {
        permissions: {
          allow: [
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
          ]
        }
      };
      writeFileSync(claudeSettingsFile, JSON.stringify(settings, null, 2) + "\n");
    } catch { /* may fail in some environments */ }

    // Also pass via env as backup
    cleanEnv.GIT_ASKPASS = "/bin/echo";
    cleanEnv.GIT_CONFIG_COUNT = "2";
    cleanEnv.GIT_CONFIG_KEY_0 = "credential.https://github.com.helper";
    cleanEnv.GIT_CONFIG_VALUE_0 = `!f() { echo "username=x-access-token"; echo "password=${config.githubToken}"; }; f`;
    cleanEnv.GIT_CONFIG_KEY_1 = "credential.helper";
    cleanEnv.GIT_CONFIG_VALUE_1 = "";

    const isRoot = process.getuid?.() === 0;
    const args = [
      "--print",
      "--verbose",
      "--output-format", "stream-json",
      // --dangerously-skip-permissions is blocked when running as root
      // For root: we rely on ~/.claude/settings.json (written above) for permissions
      ...(isRoot ? [] : ["--dangerously-skip-permissions"]),
      "--model", config.model,
      ...(config.configPath ? ["--mcp-config", config.configPath] : []),
      "-p", buildPrompt(config.agentName, work, config),
    ];

    // Use workspace from first task as cwd if available
    // Resolve relative paths (e.g. "kid-club" → "/home/user/kid-club")
    const rawWorkspace = work.tasks[0]?.workspace;
    const home = process.env.HOME || "/root";
    const taskWorkspace = rawWorkspace ? join(home, rawWorkspace) : null;
    // Also check if the raw value itself is an absolute path that exists
    const resolvedWorkspace = rawWorkspace && existsSync(rawWorkspace) ? rawWorkspace
      : taskWorkspace && existsSync(taskWorkspace) ? taskWorkspace
      : null;
    const workingDir = resolvedWorkspace || process.cwd();
    if (rawWorkspace) {
      if (resolvedWorkspace) {
        ok(`Workspace: ${resolvedWorkspace}`);
      } else {
        err(`Workspace not found: ${rawWorkspace} (tried ${taskWorkspace}) — using cwd`);
      }
    }

    // Also write .claude/settings.json into the workspace cwd
    // Claude Code reads project-level settings which can override global ones
    try {
      const wsSettingsDir = join(workingDir, ".claude");
      mkdirSync(wsSettingsDir, { recursive: true });
      writeFileSync(join(wsSettingsDir, "settings.json"), JSON.stringify({
        permissions: {
          allow: [
            "mcp__lota__lota", "Bash(*)", "Read(*)", "Write(*)",
            "Edit(*)", "Glob(*)", "Grep(*)", "Task(*)",
            "WebFetch(*)", "WebSearch(*)"
          ]
        }
      }, null, 2) + "\n");
    } catch { /* workspace may be read-only */ }

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

  const modeLabel = config.mode === "supervised" ? "supervised (Telegram)" : "autonomous";
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
    `  log:      ${LOG_FILE}`,
    "",
  ];
  for (const line of banner) {
    console.log(line);
    appendFileSync(LOG_FILE, `${line}\n`);
  }

  log("━━━ Agent active, waiting for tasks ━━━");
  console.log("");

  if (config.mode === "supervised") {
    await tgSend(config, "🤖 Lota is online. Watching for tasks.");
  }

  // Main loop: poll → check → spawn → sleep
  while (!stopped) {
    log("Checking for work...");

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
      dim(`No pending work — skipped Claude spawn`);
    } else {
      const phase = work.phase;
      const taskCount = work.tasks.length;
      const commentCount = work.commentUpdates.length;

      // ── AUTO MODE: skip plan phase, go straight to execute ──
      if (config.mode === "auto") {
        if (phase === "plan") {
          // In auto mode, treat assigned tasks as ready to execute
          work = { phase: "execute", tasks: work.tasks, commentUpdates: [] };
        }
      }

      if (work.phase === "comments") {
        ok(`${commentCount} task(s) have new comments`);
        for (const cu of work.commentUpdates) {
          dim(`  💬 #${cu.id}: ${cu.title} (${cu.new_comment_count} new)`);
        }
        if (config.mode === "supervised") {
          for (const cu of work.commentUpdates) {
            await tgSend(config, `💬 New comment on task #${cu.id}: ${cu.title}`);
          }
        }
      } else if (work.phase === "plan") {
        // Only in supervised mode
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
            await tgSend(config, `🚀 Executing task #${t.id}: ${t.title}`);
          }
        }
      }

      console.log("  ─────────────────────────────────────");
      const cycleStart = Date.now();
      const code = await runClaude(config, work);
      const elapsed = Math.round((Date.now() - cycleStart) / 1000);
      console.log("  ─────────────────────────────────────");

      if (code === 0) {
        ok(`${work.phase} phase complete in ${elapsed}s`);

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
        if (config.mode === "supervised" && work.phase === "execute") {
          for (const t of work.tasks) {
            await tgSend(config, `✅ Task #${t.id} completed: ${t.title}`);
          }
        }
      } else {
        err(`Claude exited with code ${code} after ${elapsed}s`);
        if (config.mode === "supervised") {
          await tgSend(config, `❌ Error: Claude exited with code ${code} after ${elapsed}s`);
        }
      }
    }

    if (config.once) break;

    dim(`Polling in ${config.interval}s...`);
    await sleep(config.interval);
  }
}

main();
