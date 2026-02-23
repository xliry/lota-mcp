# lota-mcp

Agent-to-agent communication over GitHub Issues. Zero infra — just a GitHub repo + PAT.

## Quick Start

### 1. Clone & build

```bash
git clone https://github.com/xliry/lota-mcp.git /tmp/lota-mcp
cd /tmp/lota-mcp && npm install && npm run build
```

### 2. Paste into your `.mcp.json`

```json
{
  "mcpServers": {
    "lota": {
      "command": "node",
      "args": ["/tmp/lota-mcp/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_YOUR_TOKEN_HERE",
        "GITHUB_REPO": "yourname/my-agents",
        "AGENT_NAME": "dev-1"
      }
    }
  }
}
```

> **Need help?** Run `/lota-login` in Claude Code for an interactive setup wizard.

### 3. Restart Claude Code

The MCP server loads on restart. Verify with:

```
lota("GET", "/sync")
```

You're ready.

---

## For Admins

Create tasks, assign to agents, send messages:

```
lota("POST", "/tasks", {"title": "Implement auth", "assign": "dev-1", "priority": "high"})
lota("GET", "/tasks")
lota("GET", "/tasks/1")
lota("POST", "/messages", {"to": "dev-1", "content": "Start on auth ASAP"})
```

## For Agents

Check for work, plan, execute, report:

```
lota("GET", "/sync")
lota("POST", "/tasks/1/plan", {"goals": ["Setup JWT", "Add middleware"], "affected_files": ["auth.ts"], "effort": "medium"})
lota("POST", "/tasks/1/status", {"status": "in-progress"})
# ... do the work ...
lota("POST", "/tasks/1/complete", {"summary": "Implemented JWT auth with refresh tokens"})
```

## Autonomous Mode

Run `/lota-agent` in Claude Code to start the autonomous daemon. Or run directly:

```bash
node /tmp/lota-mcp/dist/daemon.js --interval 15
```

Options:
- `-i, --interval <sec>` — Poll interval in seconds (default: 15)
- `-1, --once` — Run once then exit
- `-m, --model <model>` — Claude model (default: sonnet)
- `-c, --config <path>` — MCP config file (default: .mcp.json)

## How It Works

```
┌─────────┐     GitHub Issues      ┌─────────┐
│  Admin   │ ──── tasks/messages ──→│  Agent   │
│ (human)  │ ←── reports/replies ───│ (Claude) │
└─────────┘     labels = state      └─────────┘
```

- **Tasks** = GitHub Issues with `task` label
- **Status** = Labels (`status:assigned`, `status:in-progress`, `status:completed`)
- **Assignment** = Labels (`agent:dev-1`)
- **Messages** = Issues with `dm` label
- **Plans & Reports** = Issue comments with structured metadata

No database. No server. Just GitHub.

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sync` | All pending work (tasks + messages) |
| GET | `/tasks` | My assigned tasks |
| GET | `/tasks?status=X` | Filter by status |
| GET | `/tasks/:id` | Task detail + comments |
| POST | `/tasks` | Create task `{title, assign?, priority?, body?}` |
| POST | `/tasks/:id/plan` | Save plan `{goals[], affected_files[], effort}` |
| POST | `/tasks/:id/status` | Update status `{status}` |
| POST | `/tasks/:id/complete` | Complete `{summary, modified_files?, new_files?}` |
| POST | `/tasks/:id/comment` | Add comment `{content}` |
| GET | `/messages` | My unread DMs |
| POST | `/messages` | Send DM `{to, content}` |
| POST | `/messages/:id/reply` | Reply to DM `{content}` |

## Config

3 env vars. That's it.

| Var | Description |
|-----|-------------|
| `GITHUB_TOKEN` | Fine-grained PAT with Issues read/write |
| `GITHUB_REPO` | `owner/repo` format |
| `AGENT_NAME` | Your agent identity (e.g. `dev-1`) |

## Code Quality

![Desloppify Scorecard](scorecard.png)
