# Lota Agent

Lota is an autonomous agent that picks up tasks from GitHub Issues, plans them, and executes them — all without you having to babysit it.

Think of it like a developer on your team who checks their inbox every 15 seconds, plans the work, waits for your sign-off, then gets it done.

## How It Works

Lota runs as a background daemon and polls GitHub Issues for work:

1. **Polls** — every 15 seconds, Lota checks for new or updated tasks
2. **Plans** — for each new task, it explores the codebase and drafts an execution plan
3. **Waits** — it posts the plan and pauses until you approve
4. **Executes** — once approved, it dives in: edits files, runs commands, reports back
5. **Responds** — if you leave a comment, Lota reads it on the next poll and adjusts

All communication happens through GitHub Issue comments and labels — no webhooks, no special infrastructure.

## Task Lifecycle

```
assigned → planned → approved → in-progress → completed
```

| Stage | Who acts | What happens |
|---|---|---|
| `assigned` | You | Create a task and assign it to Lota |
| `planned` | Lota | Explores the codebase, posts a plan, waits for approval |
| `approved` | You | Review the plan and approve it |
| `in-progress` | Lota | Executes the plan (code edits, tests, etc.) |
| `completed` | Lota | Posts a summary and closes the issue |

## Creating a Task

The easiest way is through the `/lota-hub` skill in Claude Code:

```
/lota-hub
```

This opens an interactive dashboard where you can describe what you need in plain language — Lota handles the rest.

You can also create tasks directly via the API:

```
lota("POST", "/tasks", {
  "title": "Add login endpoint",
  "assign": "lota",
  "priority": "high",
  "body": "Implement POST /auth/login with JWT response",
  "workspace": "~/my-project"
})
```

Or just open a GitHub Issue in your repo, add the labels `task`, `agent:lota`, and `status:assigned`, and Lota will pick it up automatically.

## Running the Agent

The easiest way to start Lota is with the `/lota-agent` skill:

```
/lota-agent
```

It walks you through setup (GitHub token, repo config) and starts the daemon. If you prefer to run it manually:

```bash
# Install
git clone https://github.com/xliry/lota-agents.git ~/.lota/lota
cd ~/.lota/lota
npm install && npm run build

# Start
node dist/daemon.js --interval 15 --mode auto
```

**Daemon options:**

| Flag | Default | Description |
|---|---|---|
| `--interval 15` | 15s | How often to poll GitHub |
| `--mode auto` | auto | `auto` runs immediately; `supervised` waits for Telegram approval |
| `--once` | — | Run one poll cycle and exit |
| `--model sonnet` | sonnet | Claude model to use |

**Required config** (in `.mcp.json` or environment):

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | Personal access token with repo access |
| `GITHUB_REPO` | Target repo (`owner/repo`) |
| `AGENT_NAME` | Lota's name (default: `lota`) |

## Watching Lota Work

```bash
tail -f ~/.lota/lota/agent.log
```

You'll see it polling, picking up tasks, spawning Claude, and reporting back in real time.

## License

MIT
