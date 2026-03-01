export const GITHUB_REPO = process.env.GITHUB_REPO || "";
export const AGENT_NAME = process.env.AGENT_NAME || "";

const token = () => process.env.GITHUB_TOKEN || "";
const repo = () => process.env.GITHUB_REPO || "";
const agent = () => process.env.AGENT_NAME || "";

// ── Constants ────────────────────────────────────────────────

const LABEL = {
  TYPE: "task",
  AGENT: "agent:",
  STATUS: "status:",
  PRIORITY: "priority:",
} as const;

const META_VERSION = "v1";

type TaskStatus = "assigned" | "planned" | "approved" | "in-progress" | "completed" | "failed";
type TaskPriority = "low" | "medium" | "high";

interface Task {
  id: number;
  number: number;
  title: string;
  status: string;
  assignee: string | null;
  priority: string | null;
  labels: string[];
  body: string;
  workspace: string | null;
  depends_on: number[];
  retries: number;
  updatedAt?: string;
}

interface LotaError {
  error: string;
  code: string;
  details?: unknown;
}

// ── GitHub API fetch wrapper (with retry + backoff) ─────────

const MAX_RETRIES = 3;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const RATE_LIMIT_CRITICAL = 20;
const RATE_LIMIT_LOW = 100;
const RATE_LIMIT_BACKOFF_BUFFER_MS = 5_000;
const RATE_LIMIT_MAX_WAIT_MS = 5 * MS_PER_MINUTE;
const BASE_DELAY_MS = 1000;

// ── Rate limit tracking ──────────────────────────────────────

interface RateLimitInfo {
  remaining: number;
  limit: number;
  reset: number; // Unix timestamp (seconds)
  updatedAt: number; // Date.now()
}

let rateLimitInfo: RateLimitInfo | null = null;

export function getRateLimitInfo(): RateLimitInfo | null {
  return rateLimitInfo;
}

function updateRateLimit(headers: Headers): void {
  const remaining = parseInt(headers.get("x-ratelimit-remaining") || "", 10);
  const limit = parseInt(headers.get("x-ratelimit-limit") || "", 10);
  const reset = parseInt(headers.get("x-ratelimit-reset") || "", 10);
  if (isNaN(remaining) || isNaN(limit) || isNaN(reset)) return;

  rateLimitInfo = { remaining, limit, reset, updatedAt: Date.now() };

  const resetIn = Math.max(0, Math.round((reset * MS_PER_SECOND - Date.now()) / MS_PER_MINUTE));
  if (remaining < RATE_LIMIT_CRITICAL) {
    console.warn(`\u26a0\ufe0f  GitHub rate limit CRITICAL: ${remaining}/${limit} remaining (resets in ${resetIn}m)`);
  } else if (remaining < RATE_LIMIT_LOW) {
    console.warn(`\u26a0\ufe0f  GitHub rate limit low: ${remaining}/${limit} remaining (resets in ${resetIn}m)`);
  }
}

async function gh(path: string, opts: RequestInit = {}): Promise<unknown> {
  // Auto backoff when rate limit is critically low
  if (rateLimitInfo && rateLimitInfo.remaining < RATE_LIMIT_CRITICAL) {
    const waitUntil = rateLimitInfo.reset * MS_PER_SECOND;
    const waitMs = Math.max(0, waitUntil - Date.now()) + RATE_LIMIT_BACKOFF_BUFFER_MS;
    const waitMin = Math.round(waitMs / MS_PER_MINUTE);
    console.warn(`\u26a0\ufe0f  Rate limit critical (${rateLimitInfo.remaining} left) — backing off ${waitMin}m`);
    await new Promise(r => setTimeout(r, Math.min(waitMs, RATE_LIMIT_MAX_WAIT_MS)));
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`https://api.github.com${path}`, {
        ...opts,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token()}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          ...(opts.headers as Record<string, string> || {}),
        },
      });

      // Always update rate limit from response headers
      updateRateLimit(res.headers);

      // Rate limit — retry with backoff
      if (res.status === 403 || res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        throw Object.assign(
          new Error(`GitHub ${opts.method || "GET"} ${path} -> ${res.status}: ${text}`),
          { status: res.status }
        );
      }

      try { return JSON.parse(text); } catch { return text; }
    } catch (e) {
      lastError = e as Error;
      // Only retry on network errors, not on 4xx
      if ((e as { status?: number }).status && (e as { status?: number }).status! < 500) throw e;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, BASE_DELAY_MS * Math.pow(2, attempt)));
      }
    }
  }

  throw lastError || new Error(`GitHub request failed after ${MAX_RETRIES} retries`);
}

// ── Metadata helpers (versioned) ────────────────────────────

function parseMetadata(body: string, type: string): Record<string, unknown> | null {
  // Try versioned format first: <!-- lota:v1:plan {...} -->
  const vRe = new RegExp(`<!-- lota:${META_VERSION}:${type} (\\{.*?\\}) -->`, "s");
  const vMatch = body.match(vRe);
  if (vMatch) {
    try { return JSON.parse(vMatch[1]); } catch { /* malformed metadata — skip */ }
  }
  // Fallback: legacy format <!-- lota:plan {...} -->
  const re = new RegExp(`<!-- lota:${type} (\\{.*?\\}) -->`, "s");
  const m = body.match(re);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function formatMetadata(type: string, data: Record<string, unknown>, humanText: string): string {
  return `${humanText}\n\n<!-- lota:${META_VERSION}:${type} ${JSON.stringify(data)} -->`;
}

function parseBodyMeta(body: string): Record<string, unknown> {
  // Try versioned first
  const vMatch = body.match(new RegExp(`<!-- lota:${META_VERSION}:meta (\\{.*?\\}) -->`, "s"));
  if (vMatch) { try { return JSON.parse(vMatch[1]); } catch { /* malformed metadata — skip */ } }
  // Fallback legacy
  const m = body.match(/<!-- lota:meta (\{.*?\}) -->/s);
  if (!m) return {};
  try { return JSON.parse(m[1]); } catch { return {}; }
}

function replaceBodyMeta(body: string, newMeta: Record<string, unknown>): string {
  const tag = `<!-- lota:${META_VERSION}:meta ${JSON.stringify(newMeta)} -->`;
  const vRe = new RegExp(`<!-- lota:${META_VERSION}:meta \\{.*?\\} -->`, "s");
  if (vRe.test(body)) return body.replace(vRe, tag);
  const legacyRe = /<!-- lota:meta \{.*?\} -->/s;
  if (legacyRe.test(body)) return body.replace(legacyRe, tag);
  return `${body}\n\n${tag}`;
}

async function patchTaskMeta(id: number, updates: Record<string, unknown>): Promise<unknown> {
  const issue = await gh(`/repos/${repo()}/issues/${id}`) as GhIssue;
  const currentBody = issue.body || "";
  const existingMeta = parseBodyMeta(currentBody);
  const newMeta = { ...existingMeta, ...updates };
  const updatedBody = replaceBodyMeta(currentBody, newMeta);
  await gh(`/repos/${repo()}/issues/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ body: updatedBody }),
  });
  return { ok: true, meta: newMeta };
}

// ── Label helpers ───────────────────────────────────────────

async function swapLabels(issueNumber: number, prefix: string, newLabel: string): Promise<void> {
  // Use single PATCH to replace all labels atomically (instead of DELETE + POST)
  const issue = await gh(`/repos/${repo()}/issues/${issueNumber}`) as { labels: { name: string }[] };
  const kept = issue.labels.filter(l => !l.name.startsWith(prefix)).map(l => l.name);
  kept.push(newLabel);
  await gh(`/repos/${repo()}/issues/${issueNumber}/labels`, {
    method: "PUT",
    body: JSON.stringify({ labels: kept }),
  });
}

type GhIssue = { number: number; title: string; body?: string; labels: { name: string }[]; updated_at?: string };

function extractFromIssue(issue: GhIssue): Task {
  const labels = issue.labels.map(l => l.name);
  const status = labels.find(l => l.startsWith(LABEL.STATUS))?.slice(LABEL.STATUS.length) || "unknown";
  const assignee = labels.find(l => l.startsWith(LABEL.AGENT))?.slice(LABEL.AGENT.length) || null;
  const priority = labels.find(l => l.startsWith(LABEL.PRIORITY))?.slice(LABEL.PRIORITY.length) || null;
  const meta = parseBodyMeta(issue.body || "");
  const workspace = (meta.workspace as string) || null;
  const depends_on = Array.isArray(meta.depends_on) ? meta.depends_on as number[] : [];
  const retries = typeof meta.retries === "number" ? meta.retries : 0;
  return { id: issue.number, number: issue.number, title: issue.title, status, assignee, priority, labels, body: issue.body || "", workspace, depends_on, retries, updatedAt: issue.updated_at };
}

// ── Handlers ────────────────────────────────────────────────

async function getTasks(query: URLSearchParams): Promise<unknown> {
  const status = query.get("status");
  const labels = status
    ? `${LABEL.TYPE},${LABEL.STATUS}${status}`
    : `${LABEL.TYPE},${LABEL.AGENT}${agent()}`;
  const issues = await gh(`/repos/${repo()}/issues?labels=${encodeURIComponent(labels)}&state=open`) as GhIssue[];
  return issues.map(extractFromIssue);
}

async function getTask(id: number): Promise<unknown> {
  const [issue, comments] = await Promise.all([
    gh(`/repos/${repo()}/issues/${id}`) as Promise<GhIssue>,
    gh(`/repos/${repo()}/issues/${id}/comments`) as Promise<Array<{ body: string; created_at: string; user: { login: string } }>>,
  ]);
  const task = extractFromIssue(issue);
  const plan = comments.map(c => parseMetadata(c.body, "plan")).find(Boolean) || null;
  const report = comments.map(c => parseMetadata(c.body, "report")).find(Boolean) || null;
  return { ...task, plan, report, comments: comments.map(c => ({ body: c.body, created_at: c.created_at, user: c.user.login })) };
}

async function createTask(body: Record<string, unknown>): Promise<unknown> {
  const { title, assign, priority, body: taskBody, workspace, depends_on } = body as {
    title: string; assign?: string; priority?: string; body?: string; workspace?: string; depends_on?: number[];
  };
  const status = depends_on?.length ? "blocked" : "assigned";
  const labels = [LABEL.TYPE, `${LABEL.AGENT}${assign || agent()}`, `${LABEL.STATUS}${status}`];
  if (priority) labels.push(`${LABEL.PRIORITY}${priority}`);
  let finalBody = taskBody || "";
  const meta: Record<string, unknown> = {};
  if (workspace) meta.workspace = workspace;
  if (depends_on?.length) meta.depends_on = depends_on;
  if (Object.keys(meta).length) {
    finalBody += `\n\n<!-- lota:${META_VERSION}:meta ${JSON.stringify(meta)} -->`;
  }
  return await gh(`/repos/${repo()}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body: finalBody, labels }),
  });
}

async function savePlan(id: number, body: Record<string, unknown>): Promise<unknown> {
  const { goals, affected_files, effort, notes } = body as {
    goals: string[]; affected_files?: string[]; effort?: string; notes?: string;
  };
  const humanText = `## Plan\n${goals.map(g => `- ${g}`).join("\n")}${effort ? `\nEstimated effort: ${effort}` : ""}${notes ? `\n\n${notes}` : ""}`;
  const comment = formatMetadata("plan", { goals, affected_files: affected_files || [], effort: effort || "medium", notes }, humanText);
  return await gh(`/repos/${repo()}/issues/${id}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: comment }),
  });
}

async function updateStatus(id: number, body: Record<string, unknown>): Promise<unknown> {
  const { status } = body as { status: string };
  await swapLabels(id, LABEL.STATUS, `${LABEL.STATUS}${status}`);
  if (status === "completed") {
    await gh(`/repos/${repo()}/issues/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
    try {
      await unblockDependents(id);
    } catch (err) {
      console.error(`[task #${id}] Unblock dependents failed (non-fatal): ${(err as Error).message}`);
    }
  }
  return { ok: true, status };
}

async function completeTask(id: number, body: Record<string, unknown>): Promise<unknown> {
  // Idempotency guard — skip if already completed
  const issue = await gh(`/repos/${repo()}/issues/${id}`) as GhIssue;
  const currentLabels = issue.labels.map((l: { name: string }) => l.name);
  if (currentLabels.includes(`${LABEL.STATUS}completed`)) {
    return { ok: true, message: "Already completed (idempotent)" };
  }

  const { summary, modified_files, new_files } = body as {
    summary: string; modified_files?: string[]; new_files?: string[];
  };
  const result = {
    ok: false,
    commentPosted: false,
    labelSwapped: false,
    issueClosed: false,
    errors: [] as string[],
  };

  // Step 1: Post completion report comment
  const humanText = `## Completion Report\n${summary}${modified_files?.length ? `\n\nModified: ${modified_files.join(", ")}` : ""}${new_files?.length ? `\nNew: ${new_files.join(", ")}` : ""}`;
  const comment = formatMetadata("report", { summary, modified_files, new_files }, humanText);
  try {
    await gh(`/repos/${repo()}/issues/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: comment }),
    });
    result.commentPosted = true;
  } catch (err) {
    const msg = `[task #${id}] Step 1 (post comment) failed: ${(err as Error).message}`;
    result.errors.push(msg);
    console.error(msg);
    return result;
  }

  // Step 2: Swap status label to completed (retry once on failure)
  try {
    await swapLabels(id, LABEL.STATUS, `${LABEL.STATUS}completed`);
    result.labelSwapped = true;
  } catch (err) {
    try {
      await swapLabels(id, LABEL.STATUS, `${LABEL.STATUS}completed`);
      result.labelSwapped = true;
    } catch (retryErr) {
      const msg = `[task #${id}] Step 2 (label swap to completed) failed after retry: ${(retryErr as Error).message}`;
      result.errors.push(msg);
      console.error(msg);
      return result;
    }
  }

  // Step 3: Close the issue (retry once on failure)
  try {
    await gh(`/repos/${repo()}/issues/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
    result.issueClosed = true;
  } catch (err) {
    try {
      await gh(`/repos/${repo()}/issues/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed" }),
      });
      result.issueClosed = true;
    } catch (retryErr) {
      const msg = `[task #${id}] Step 3 (close issue) failed after retry: ${(retryErr as Error).message}. Reverting label to avoid completed+open inconsistency.`;
      result.errors.push(msg);
      console.error(msg);
      // Revert label to in-progress to keep state consistent (open + in-progress)
      try {
        await swapLabels(id, LABEL.STATUS, `${LABEL.STATUS}in-progress`);
      } catch (revertErr) {
        const revertMsg = `[task #${id}] Failed to revert label after close failure: ${(revertErr as Error).message}`;
        result.errors.push(revertMsg);
        console.error(revertMsg);
      }
      return result;
    }
  }

  // Step 4: Unblock dependent tasks whose dependencies are now all completed
  try {
    await unblockDependents(id);
  } catch (err) {
    console.error(`[task #${id}] Unblock dependents failed (non-fatal): ${(err as Error).message}`);
  }

  return { ...result, ok: true };
}

async function unblockDependents(completedTaskId: number): Promise<void> {
  // Fetch all open issues with status:blocked label (across all agents)
  const blockedIssues = await gh(
    `/repos/${repo()}/issues?labels=${encodeURIComponent(`${LABEL.TYPE},${LABEL.STATUS}blocked`)}&state=open&per_page=100`
  ) as GhIssue[];

  for (const issue of blockedIssues) {
    const task = extractFromIssue(issue);
    if (!task.depends_on.includes(completedTaskId)) continue;

    // Check if ALL dependencies are completed (closed)
    let allDepsCompleted = true;
    for (const depId of task.depends_on) {
      if (depId === completedTaskId) continue; // already completed
      try {
        const depIssue = await gh(`/repos/${repo()}/issues/${depId}`) as { state: string };
        if (depIssue.state !== "closed") {
          allDepsCompleted = false;
          break;
        }
      } catch {
        allDepsCompleted = false;
        break;
      }
    }

    if (allDepsCompleted) {
      await swapLabels(task.id, LABEL.STATUS, `${LABEL.STATUS}assigned`);
      console.log(`  🔓 Unblocked task #${task.id} "${task.title}" — all dependencies completed`);
    }
  }
}

async function addComment(id: number, body: Record<string, unknown>): Promise<unknown> {
  const { content } = body as { content: string };
  return await gh(`/repos/${repo()}/issues/${id}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: content }),
  });
}

async function assignTask(id: number, body: Record<string, unknown>): Promise<unknown> {
  const { agent: newAgent } = body as { agent: string };
  await swapLabels(id, LABEL.AGENT, `${LABEL.AGENT}${newAgent}`);
  return { ok: true, agent: newAgent };
}

async function sync(query?: URLSearchParams): Promise<unknown> {
  // If all=true, fetch tasks across all agents (used by Hub and lota-agent skill)
  const allAgents = query?.get("all") === "true";
  const agentLabels = allAgents ? LABEL.TYPE : `${LABEL.TYPE},${LABEL.AGENT}${agent()}`;

  const [openIssues, completedIssues] = await Promise.all([
    // Call 1: all open tasks for this agent
    gh(`/repos/${repo()}/issues?labels=${encodeURIComponent(agentLabels)}&state=open&per_page=100`) as Promise<Array<GhIssue & { comments: number }>>,
    // Call 2: recently completed (closed) tasks
    gh(`/repos/${repo()}/issues?labels=${encodeURIComponent(`${agentLabels},${LABEL.STATUS}completed`)}&state=closed&per_page=10&sort=updated&direction=desc`) as Promise<Array<GhIssue & { comments: number }>>,
  ]);

  // Filter open issues client-side by status label
  const assigned = openIssues
    .filter(i => i.labels.some(l => l.name === `${LABEL.STATUS}assigned`))
    .map(extractFromIssue);

  const approved = openIssues
    .filter(i => i.labels.some(l => l.name === `${LABEL.STATUS}approved`))
    .map(extractFromIssue);

  const inProgress = openIssues
    .filter(i => i.labels.some(l => l.name === `${LABEL.STATUS}in-progress`))
    .map(issue => ({ ...extractFromIssue(issue), comment_count: issue.comments ?? 0 }));

  const failed = openIssues
    .filter(i => i.labels.some(l => l.name === `${LABEL.STATUS}failed`))
    .map(issue => ({ ...extractFromIssue(issue), comment_count: issue.comments ?? 0 }));

  const blocked = openIssues
    .filter(i => i.labels.some(l => l.name === `${LABEL.STATUS}blocked`))
    .map(extractFromIssue);

  // Strip body from sync response to reduce token usage — use GET /tasks/:id for full details
  const slim = (t: Task) => ({ id: t.id, number: t.number, title: t.title, status: t.status, assignee: t.assignee, priority: t.priority, workspace: t.workspace, depends_on: t.depends_on });

  const recentlyCompleted = completedIssues.map(issue => ({
    ...slim(extractFromIssue(issue)),
    comment_count: issue.comments ?? 0,
  }));

  return {
    assigned: assigned.map(slim),
    approved: approved.map(slim),
    in_progress: inProgress.map(t => ({ ...slim(t), comment_count: (t as any).comment_count })),
    failed: failed.map(t => ({ ...slim(t), comment_count: (t as any).comment_count })),
    blocked: blocked.map(slim),
    recently_completed: recentlyCompleted,
  };
}

// ── Main dispatcher ─────────────────────────────────────────

export async function lota(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
  const [pathname, queryStr] = path.split("?");
  const query = new URLSearchParams(queryStr || "");
  const idMatch = pathname.match(/\/tasks\/(\d+)/);
  const id = idMatch ? Number(idMatch[1]) : undefined;
  const endpoint = pathname.replace(/\/tasks\/\d+/, "/tasks/:id");

  switch (`${method} ${endpoint}`) {
    case "GET /sync":              return sync(query);
    case "GET /tasks":             return getTasks(query);
    case "GET /tasks/:id":         return getTask(id!);
    case "POST /tasks":            return createTask(body!);
    case "POST /tasks/:id/plan":   return savePlan(id!, body!);
    case "POST /tasks/:id/status": return updateStatus(id!, body!);
    case "POST /tasks/:id/complete": return completeTask(id!, body!);
    case "POST /tasks/:id/comment": return addComment(id!, body!);
    case "POST /tasks/:id/assign": return assignTask(id!, body!);
    case "PATCH /tasks/:id/meta":  return patchTaskMeta(id!, body!);
    default: throw Object.assign(
      new Error(`Unknown route: ${method} ${path}`),
      { code: "LOTA_UNKNOWN_ROUTE" }
    );
  }
}
