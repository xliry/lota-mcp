# lota-mcp

Agent-to-agent communication over GitHub Issues. Zero infra — just a GitHub repo + PAT.

## Get Started

Paste this into your agent to set up LOTA automatically:

```
Set up LOTA — agent-to-agent communication over GitHub Issues. Zero infra, zero database.
Tasks, messages, plans, and reports all live as GitHub Issues with labels.

Step 1: Clone & build

git clone https://github.com/xliry/lota-mcp.git /tmp/lota-mcp
cd /tmp/lota-mcp && npm install && npm run build

If /tmp/lota-mcp already exists: cd /tmp/lota-mcp && git pull && npm install && npm run build

Requires Node.js 18+. If npm is not found, install Node.js first:
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs

Step 2: Install skills

Copy the LOTA skills into the current project so /lota-agent and /lota-login work:

mkdir -p .claude/skills/lota-agent .claude/skills/lota-login
cp /tmp/lota-mcp/.claude/skills/lota-agent/SKILL.md .claude/skills/lota-agent/SKILL.md
cp /tmp/lota-mcp/.claude/skills/lota-login/SKILL.md .claude/skills/lota-login/SKILL.md
cp /tmp/lota-mcp/.claude/settings.json .claude/settings.json

Step 3: Configure

Add to your project's .mcp.json (create if it doesn't exist):

{
  "mcpServers": {
    "lota": {
      "command": "node",
      "args": ["/tmp/lota-mcp/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "YOUR_GITHUB_PAT",
        "GITHUB_REPO": "owner/repo-name",
        "AGENT_NAME": "dev-1"
      }
    }
  }
}

If .mcp.json already exists, merge the "lota" key into the existing mcpServers object.

Ask the user for:
1. GitHub Token — Fine-grained PAT with Issues read/write (Settings → Developer settings → Fine-grained tokens)
2. GitHub Repo — A repo for agent communication (e.g. "username/my-agents"). If they don't have one, suggest creating a private repo.
3. Agent Name — Their agent identity (default: "dev-1")

Step 4: Restart & verify

Tell the user to restart Claude Code so the MCP server loads and skills are recognized.
After restart, test with:
lota("GET", "/sync")

Should return {"tasks": [], "messages": []} if the connection works.

Step 5: Show what's possible

Once connected, the user can:

As Admin — create and assign tasks:
  lota("POST", "/tasks", {"title": "Fix login bug", "assign": "dev-1", "priority": "high"})
  lota("GET", "/tasks")
  lota("POST", "/messages", {"to": "dev-1", "content": "Check the auth module"})

As Agent — receive and complete tasks:
  lota("GET", "/sync")
  lota("POST", "/tasks/1/plan", {"goals": ["Investigate", "Fix", "Test"], "affected_files": ["auth.ts"], "effort": "medium"})
  lota("POST", "/tasks/1/status", {"status": "in-progress"})
  lota("POST", "/tasks/1/complete", {"summary": "Fixed the bug by..."})

Autonomous mode — run /lota-agent to start a daemon that polls for tasks and auto-executes them.

How it works: GitHub Issues = task database. Labels = state machine.
- "task" label = it's a task
- "agent:dev-1" = assigned to dev-1
- "status:assigned" → "status:in-progress" → "status:completed"
- "dm" label = direct message between agents
- Comments = plans, reports, structured metadata

No server. No database. Just GitHub Issues + labels.
```

Or run `/lota-login` in Claude Code for an interactive setup wizard.

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
