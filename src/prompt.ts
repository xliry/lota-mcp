import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { err, dim } from "./logging.js";
import type { AgentConfig, WorkData } from "./types.js";

// ── Task body sanitization ───────────────────────────────────────
export function sanitizeTaskBody(body: string): string {
  let cleaned = body.replace(/<!--[\s\S]*?-->/g, "");
  cleaned = cleaned.replace(/!\[([^\]]*)\]\([^)]*\)/g, "[image: $1]");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  const MAX = 2000;
  const HEAD = 1000;
  const TAIL = 500;
  if (cleaned.length <= MAX) return cleaned;
  return cleaned.slice(0, HEAD) + "\n\n... [truncated] ...\n\n" + cleaned.slice(-TAIL);
}

// ── Build command resolution ─────────────────────────────────────
export function resolveBuildCmd(workspace?: string): string {
  if (!workspace) return "npm run build";
  const home = resolve(process.env.HOME || "/root");
  const dir = workspace.startsWith("~/") ? join(home, workspace.slice(2)) : workspace;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    if (pkg.scripts?.build) return "npm run build";
  } catch (e) { dim(`[non-critical] failed to read package.json for build cmd: ${(e as Error).message}`); }
  return "npx tsc";
}

// ── Workspace path resolution ────────────────────────────────────
export function resolveWorkspace(work: WorkData): string {
  const rawWorkspace = work.tasks[0]?.workspace;
  if (!rawWorkspace) return process.cwd();

  const home = resolve(process.env.HOME || "/root");

  if (rawWorkspace.includes("..")) {
    err(`Workspace path rejected (path traversal): ${rawWorkspace}`);
    return process.cwd();
  }

  const expanded = rawWorkspace.startsWith("~/")
    ? join(home, rawWorkspace.slice(2))
    : rawWorkspace;

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

// ── Prompt builder ───────────────────────────────────────────────
export function buildPrompt(agentName: string, work: WorkData, config: AgentConfig): string {
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

  // PHASE: SINGLE (auto mode)
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
