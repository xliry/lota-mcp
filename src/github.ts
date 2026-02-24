const token = () => process.env.GITHUB_TOKEN || "";
const repo = () => process.env.GITHUB_REPO || "";
const agent = () => process.env.AGENT_NAME || "";

// ── GitHub API fetch wrapper ────────────────────────────────────

async function gh(path: string, opts: RequestInit = {}): Promise<unknown> {
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
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${opts.method || "GET"} ${path} -> ${res.status}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── Metadata helpers ────────────────────────────────────────────

function parseMetadata(body: string, type: string): Record<string, unknown> | null {
  const re = new RegExp(`<!-- lota:${type} (\\{.*?\\}) -->`, "s");
  const m = body.match(re);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function formatMetadata(type: string, data: Record<string, unknown>, humanText: string): string {
  return `${humanText}\n\n<!-- lota:${type} ${JSON.stringify(data)} -->`;
}

// ── Label helpers ───────────────────────────────────────────────

async function swapLabels(issueNumber: number, removePrefix: string, addLabel: string): Promise<void> {
  const issue = await gh(`/repos/${repo()}/issues/${issueNumber}`) as { labels: { name: string }[] };
  const toRemove = issue.labels.filter(l => l.name.startsWith(removePrefix));
  for (const l of toRemove) {
    await gh(`/repos/${repo()}/issues/${issueNumber}/labels/${encodeURIComponent(l.name)}`, { method: "DELETE" });
  }
  await gh(`/repos/${repo()}/issues/${issueNumber}/labels`, {
    method: "POST",
    body: JSON.stringify({ labels: [addLabel] }),
  });
}

function extractFromIssue(issue: { number: number; title: string; body?: string; labels: { name: string }[] }) {
  const labels = issue.labels.map(l => l.name);
  const status = labels.find(l => l.startsWith("status:"))?.slice(7) || "unknown";
  const assignee = labels.find(l => l.startsWith("agent:"))?.slice(6) || null;
  const priority = labels.find(l => l.startsWith("priority:"))?.slice(9) || null;
  return { id: issue.number, number: issue.number, title: issue.title, status, assignee, priority, labels, body: issue.body || "" };
}

// ── Shared helpers ──────────────────────────────────────────────

async function postIssueComment(issueId: string, content: string): Promise<unknown> {
  return gh(`/repos/${repo()}/issues/${issueId}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: content }),
  });
}

// ── Route handler ───────────────────────────────────────────────

export async function lota(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
  const url = new URL(path, "http://localhost");
  const p = url.pathname;
  const params = url.searchParams;

  // GET /tasks or /tasks?status=X
  if (method === "GET" && p === "/tasks") {
    const status = params.get("status");
    const labels = status
      ? `task,status:${status}`
      : `task,agent:${agent()}`;
    const issues = await gh(`/repos/${repo()}/issues?labels=${encodeURIComponent(labels)}&state=open`) as Array<Record<string, unknown>>;
    return (issues as Array<{ number: number; title: string; body?: string; labels: { name: string }[] }>).map(extractFromIssue);
  }

  // GET /tasks/:id
  const taskMatch = method === "GET" && p.match(/^\/tasks\/(\d+)$/);
  if (taskMatch) {
    const id = taskMatch[1];
    const [issue, comments] = await Promise.all([
      gh(`/repos/${repo()}/issues/${id}`) as Promise<{ number: number; title: string; body?: string; labels: { name: string }[] }>,
      gh(`/repos/${repo()}/issues/${id}/comments`) as Promise<Array<{ body: string; created_at: string; user: { login: string } }>>,
    ]);
    const task = extractFromIssue(issue);
    const plan = comments.map(c => parseMetadata(c.body, "plan")).find(Boolean) || null;
    const report = comments.map(c => parseMetadata(c.body, "report")).find(Boolean) || null;
    return { ...task, plan, report, comments: comments.map(c => ({ body: c.body, created_at: c.created_at, user: c.user.login })) };
  }

  // POST /tasks
  if (method === "POST" && p === "/tasks") {
    const { title, assign, priority, body: taskBody } = body as { title: string; assign?: string; priority?: string; body?: string };
    const labels = ["task", `agent:${assign || agent()}`, "status:assigned"];
    if (priority) labels.push(`priority:${priority}`);
    return await gh(`/repos/${repo()}/issues`, {
      method: "POST",
      body: JSON.stringify({ title, body: taskBody || "", labels }),
    });
  }

  // POST /tasks/:id/plan
  const planMatch = method === "POST" && p.match(/^\/tasks\/(\d+)\/plan$/);
  if (planMatch) {
    const id = planMatch[1];
    const { goals, affected_files, effort, notes } = body as { goals: string[]; affected_files?: string[]; effort?: string; notes?: string };
    const humanText = `## Plan\n${goals.map(g => `- ${g}`).join("\n")}${effort ? `\nEstimated effort: ${effort}` : ""}${notes ? `\n\n${notes}` : ""}`;
    const comment = formatMetadata("plan", { goals, affected_files: affected_files || [], effort: effort || "medium", notes }, humanText);
    return await gh(`/repos/${repo()}/issues/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: comment }),
    });
  }

  // POST /tasks/:id/status
  const statusMatch = method === "POST" && p.match(/^\/tasks\/(\d+)\/status$/);
  if (statusMatch) {
    const id = Number(statusMatch[1]);
    const { status } = body as { status: string };
    await swapLabels(id, "status:", `status:${status}`);
    if (status === "completed") {
      await gh(`/repos/${repo()}/issues/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed" }),
      });
    }
    return { ok: true, status };
  }

  // POST /tasks/:id/complete
  const completeMatch = method === "POST" && p.match(/^\/tasks\/(\d+)\/complete$/);
  if (completeMatch) {
    const id = completeMatch[1];
    const { summary, modified_files, new_files } = body as { summary: string; modified_files?: string[]; new_files?: string[] };
    const humanText = `## Completion Report\n${summary}${modified_files?.length ? `\n\nModified: ${modified_files.join(", ")}` : ""}${new_files?.length ? `\nNew: ${new_files.join(", ")}` : ""}`;
    const comment = formatMetadata("report", { summary, modified_files, new_files }, humanText);
    await gh(`/repos/${repo()}/issues/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: comment }),
    });
    await swapLabels(Number(id), "status:", "status:completed");
    await gh(`/repos/${repo()}/issues/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
    return { ok: true, completed: true };
  }

  // POST /tasks/:id/comment
  const commentMatch = method === "POST" && p.match(/^\/tasks\/(\d+)\/comment$/);
  if (commentMatch) {
    const id = commentMatch[1];
    const { content } = body as { content: string };
    return await postIssueComment(id, content);
  }

  // GET /messages
  if (method === "GET" && p === "/messages") {
    const issues = await gh(`/repos/${repo()}/issues?labels=${encodeURIComponent(`dm,to:${agent()}`)}&state=open`) as Array<Record<string, unknown>>;
    return issues;
  }

  // POST /messages
  if (method === "POST" && p === "/messages") {
    const { to, content } = body as { to: string; content: string };
    return await gh(`/repos/${repo()}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: `DM: ${agent()} -> ${to}`,
        body: content,
        labels: ["dm", `to:${to}`, `from:${agent()}`],
      }),
    });
  }

  // POST /messages/:id/reply
  const replyMatch = method === "POST" && p.match(/^\/messages\/(\d+)\/reply$/);
  if (replyMatch) {
    const id = replyMatch[1];
    const { content } = body as { content: string };
    const result = await postIssueComment(id, content);
    await gh(`/repos/${repo()}/issues/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
    return result;
  }

  // GET /sync
  if (method === "GET" && p === "/sync") {
    const [tasks, messages] = await Promise.all([
      lota("GET", "/tasks"),
      lota("GET", "/messages"),
    ]);
    return { tasks, messages };
  }

  throw new Error(`Unknown route: ${method} ${path}`);
}
