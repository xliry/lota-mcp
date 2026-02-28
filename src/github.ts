export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
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

export type TaskStatus = "assigned" | "planned" | "approved" | "in-progress" | "completed";
export type TaskPriority = "low" | "medium" | "high";

export interface Task {
  id: number;
  number: number;
  title: string;
  status: string;
  assignee: string | null;
  priority: string | null;
  labels: string[];
  body: string;
  workspace: string | null;
}

export interface LotaError {
  error: string;
  code: string;
  details?: unknown;
}

// ── GitHub API fetch wrapper (with retry + backoff) ─────────

const MAX_RETRIES = 3;
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

  const resetIn = Math.max(0, Math.round((reset * 1000 - Date.now()) / 60000));
  if (remaining < 20) {
    console.warn(`\u26a0\ufe0f  GitHub rate limit CRITICAL: ${remaining}/${limit} remaining (resets in ${resetIn}m)`);
  } else if (remaining < 100) {
    console.warn(`\u26a0\ufe0f  GitHub rate limit low: ${remaining}/${limit} remaining (resets in ${resetIn}m)`);
  }
}

async function gh(path: string, opts: RequestInit = {}): Promise<unknown> {
  // Auto backoff when rate limit is critically low
  if (rateLimitInfo && rateLimitInfo.remaining < 20) {
    const waitUntil = rateLimitInfo.reset * 1000;
    const waitMs = Math.max(0, waitUntil - Date.now()) + 5000; // 5s buffer
    const waitMin = Math.round(waitMs / 60000);
    console.warn(`\u26a0\ufe0f  Rate limit critical (${rateLimitInfo.remaining} left) — backing off ${waitMin}m`);
    await new Promise(r => setTimeout(r, Math.min(waitMs, 5 * 60 * 1000))); // cap at 5m
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

      try { return JSON.parse(text); } catch (e) { console.warn(`[non-critical] GitHub response is not JSON, returning raw text: ${(e as Error).message}`); return text; }
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
    try { return JSON.parse(vMatch[1]); } catch (e) { console.warn(`[non-critical] failed to parse versioned ${type} metadata: ${(e as Error).message}`); }
  }
  // Fallback: legacy format <!-- lota:plan {...} -->
  const re = new RegExp(`<!-- lota:${type} (\\{.*?\\}) -->`, "s");
  const m = body.match(re);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { console.warn(`[non-critical] failed to parse legacy ${type} metadata: ${(e as Error).message}`); return null; }
}

function formatMetadata(type: string, data: Record<string, unknown>, humanText: string): string {
  return `${humanText}\n\n<!-- lota:${META_VERSION}:${type} ${JSON.stringify(data)} -->`;
}

function parseBodyMeta(body: string): Record<string, unknown> {
  // Try versioned first
  const vMatch = body.match(new RegExp(`<!-- lota:${META_VERSION}:meta (\\{.*?\\}) -->`, "s"));
  if (vMatch) { try { return JSON.parse(vMatch[1]); } catch (e) { console.warn(`[non-critical] failed to parse versioned body metadata: ${(e as Error).message}`); } }
  // Fallback legacy
  const m = body.match(/<!-- lota:meta (\{.*?\}) -->/s);
  if (!m) return {};
  try { return JSON.parse(m[1]); } catch (e) { console.warn(`[non-critical] failed to parse legacy body metadata: ${(e as Error).message}`); return {}; }
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

type GhIssue = { number: number; title: string; body?: string; labels: { name: string }[] };

function extractFromIssue(issue: GhIssue): Task {
  const labels = issue.labels.map(l => l.name);
  const status = labels.find(l => l.startsWith(LABEL.STATUS))?.slice(LABEL.STATUS.length) || "unknown";
  const assignee = labels.find(l => l.startsWith(LABEL.AGENT))?.slice(LABEL.AGENT.length) || null;
  const priority = labels.find(l => l.startsWith(LABEL.PRIORITY))?.slice(LABEL.PRIORITY.length) || null;
  const meta = parseBodyMeta(issue.body || "");
  const workspace = (meta.workspace as string) || null;
  return { id: issue.number, number: issue.number, title: issue.title, status, assignee, priority, labels, body: issue.body || "", workspace };
}

// ── Router ──────────────────────────────────────────────────

type Handler = (params: Record<string, string>, query: URLSearchParams, body?: Record<string, unknown>) => Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const paramNames: string[] = [];
  const regexStr = path.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name);
    return "(\\w+)";
  });
  return { method, pattern: new RegExp(`^${regexStr}$`), paramNames, handler };
}

// ── Handlers ────────────────────────────────────────────────

const getTasks: Handler = async (_params, query) => {
  const status = query.get("status");
  const labels = status
    ? `${LABEL.TYPE},${LABEL.STATUS}${status}`
    : `${LABEL.TYPE},${LABEL.AGENT}${agent()}`;
  const issues = await gh(`/repos/${repo()}/issues?labels=${encodeURIComponent(labels)}&state=open`) as GhIssue[];
  return issues.map(extractFromIssue);
};

const getTask: Handler = async (params) => {
  const { id } = params;
  const [issue, comments] = await Promise.all([
    gh(`/repos/${repo()}/issues/${id}`) as Promise<GhIssue>,
    gh(`/repos/${repo()}/issues/${id}/comments`) as Promise<Array<{ body: string; created_at: string; user: { login: string } }>>,
  ]);
  const task = extractFromIssue(issue);
  const plan = comments.map(c => parseMetadata(c.body, "plan")).find(Boolean) || null;
  const report = comments.map(c => parseMetadata(c.body, "report")).find(Boolean) || null;
  return { ...task, plan, report, comments: comments.map(c => ({ body: c.body, created_at: c.created_at, user: c.user.login })) };
};

const createTask: Handler = async (_params, _query, body) => {
  const { title, assign, priority, body: taskBody, workspace } = body as {
    title: string; assign?: string; priority?: string; body?: string; workspace?: string;
  };
  const labels = [LABEL.TYPE, `${LABEL.AGENT}${assign || agent()}`, `${LABEL.STATUS}assigned`];
  if (priority) labels.push(`${LABEL.PRIORITY}${priority}`);
  let finalBody = taskBody || "";
  if (workspace) {
    finalBody += `\n\n<!-- lota:${META_VERSION}:meta ${JSON.stringify({ workspace })} -->`;
  }
  return await gh(`/repos/${repo()}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body: finalBody, labels }),
  });
};

const savePlan: Handler = async (params, _query, body) => {
  const { id } = params;
  const { goals, affected_files, effort, notes } = body as {
    goals: string[]; affected_files?: string[]; effort?: string; notes?: string;
  };
  const humanText = `## Plan\n${goals.map(g => `- ${g}`).join("\n")}${effort ? `\nEstimated effort: ${effort}` : ""}${notes ? `\n\n${notes}` : ""}`;
  const comment = formatMetadata("plan", { goals, affected_files: affected_files || [], effort: effort || "medium", notes }, humanText);
  return await gh(`/repos/${repo()}/issues/${id}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: comment }),
  });
};

const updateStatus: Handler = async (params, _query, body) => {
  const id = Number(params.id);
  const { status } = body as { status: string };
  await swapLabels(id, LABEL.STATUS, `${LABEL.STATUS}${status}`);
  if (status === "completed") {
    await gh(`/repos/${repo()}/issues/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
  }
  return { ok: true, status };
};

const completeTask: Handler = async (params, _query, body) => {
  const { id } = params;
  const { summary, modified_files, new_files } = body as {
    summary: string; modified_files?: string[]; new_files?: string[];
  };
  const numId = Number(id);
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
    await swapLabels(numId, LABEL.STATUS, `${LABEL.STATUS}completed`);
    result.labelSwapped = true;
  } catch (err) {
    try {
      await swapLabels(numId, LABEL.STATUS, `${LABEL.STATUS}completed`);
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
        await swapLabels(numId, LABEL.STATUS, `${LABEL.STATUS}in-progress`);
      } catch (revertErr) {
        const revertMsg = `[task #${id}] Failed to revert label after close failure: ${(revertErr as Error).message}`;
        result.errors.push(revertMsg);
        console.error(revertMsg);
      }
      return result;
    }
  }

  return { ...result, ok: true };
};

const addComment: Handler = async (params, _query, body) => {
  const { id } = params;
  const { content } = body as { content: string };
  return await gh(`/repos/${repo()}/issues/${id}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: content }),
  });
};

const sync: Handler = async () => {
  // Fetch assigned tasks (need planning)
  const assignedLabels = `${LABEL.TYPE},${LABEL.AGENT}${agent()},${LABEL.STATUS}assigned`;
  const assignedIssues = await gh(`/repos/${repo()}/issues?labels=${encodeURIComponent(assignedLabels)}&state=open`) as GhIssue[];
  const assigned = assignedIssues.map(extractFromIssue);

  // Fetch approved tasks (ready to execute)
  const approvedLabels = `${LABEL.TYPE},${LABEL.AGENT}${agent()},${LABEL.STATUS}approved`;
  const approvedIssues = await gh(`/repos/${repo()}/issues?labels=${encodeURIComponent(approvedLabels)}&state=open`) as GhIssue[];
  const approved = approvedIssues.map(extractFromIssue);

  // Fetch in-progress tasks for comment detection
  const inProgressLabels = `${LABEL.TYPE},${LABEL.AGENT}${agent()},${LABEL.STATUS}in-progress`;
  const inProgressIssues = await gh(`/repos/${repo()}/issues?labels=${encodeURIComponent(inProgressLabels)}&state=open`) as Array<GhIssue & { comments: number }>;
  const inProgress = inProgressIssues.map(issue => ({
    ...extractFromIssue(issue),
    comment_count: issue.comments ?? 0,
  }));

  // Fetch recently completed tasks (closed) so we can detect new comments on them
  const completedLabels = `${LABEL.TYPE},${LABEL.AGENT}${agent()},${LABEL.STATUS}completed`;
  const completedIssues = await gh(`/repos/${repo()}/issues?labels=${encodeURIComponent(completedLabels)}&state=closed&per_page=10&sort=updated&direction=desc`) as Array<GhIssue & { comments: number }>;
  const recentlyCompleted = completedIssues.map(issue => ({
    ...extractFromIssue(issue),
    comment_count: issue.comments ?? 0,
  }));

  return { assigned, approved, in_progress: inProgress, recently_completed: recentlyCompleted };
};

// ── Route table ─────────────────────────────────────────────

const routes: Route[] = [
  route("GET",  "/tasks",              getTasks),
  route("GET",  "/tasks/:id",          getTask),
  route("POST", "/tasks",              createTask),
  route("POST", "/tasks/:id/plan",     savePlan),
  route("POST", "/tasks/:id/status",   updateStatus),
  route("POST", "/tasks/:id/complete", completeTask),
  route("POST", "/tasks/:id/comment",  addComment),
  route("GET",  "/sync",               sync),
];

// ── Main dispatcher ─────────────────────────────────────────

export async function lota(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
  const url = new URL(path, "http://localhost");
  const p = url.pathname;
  const query = url.searchParams;

  for (const r of routes) {
    if (r.method !== method) continue;
    const match = p.match(r.pattern);
    if (!match) continue;

    const params: Record<string, string> = {};
    r.paramNames.forEach((name, i) => { params[name] = match[i + 1]; });
    return r.handler(params, query, body);
  }

  throw Object.assign(
    new Error(`Unknown route: ${method} ${path}`),
    { code: "LOTA_UNKNOWN_ROUTE" }
  );
}
