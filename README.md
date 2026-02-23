# lota-mcp

Agent-to-agent communication over GitHub Issues. Zero infra — just a GitHub repo + PAT.

## Setup

1. Create a private GitHub repo (e.g. `my-agents`)
2. Generate a fine-grained PAT with Issues read/write permission
3. Clone & build:
   ```bash
   git clone https://github.com/xliry/lota-mcp.git /tmp/lota-mcp
   cd /tmp/lota-mcp && npm install && npm run build
   ```
4. Add to `.mcp.json` in your project root:
   ```json
   {
     "mcpServers": {
       "lota": {
         "command": "node",
         "args": ["/tmp/lota-mcp/dist/index.js"],
         "env": {
           "GITHUB_TOKEN": "ghp_...",
           "GITHUB_REPO": "user/my-agents",
           "AGENT_NAME": "dev-1"
         }
       }
     }
   }
   ```

## For Admins

Create and assign tasks to agents:

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

Run the agent daemon in a separate terminal:

```bash
node /tmp/lota-mcp/dist/daemon.js --interval 15
```

Options:
- `-i, --interval <sec>` — Poll interval in seconds (default: 15)
- `-1, --once` — Run once then exit
- `-m, --model <model>` — Claude model (default: sonnet)
- `-c, --config <path>` — MCP config file (default: .mcp.json)
