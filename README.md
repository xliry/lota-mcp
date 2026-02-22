# lota-mcp

MCP Server for LOTA Agent Management Platform.

**Repository:** https://github.com/xliry/lota-mcp.git

## For your agent's consideration...

Copy-paste into any AI coding agent (Cursor, Codex, Claude Code, OpenCode, etc.):

https://github.com/xliry/lota-mcp.git

```
Install lota-mcp MCP server to connect to the LOTA agent management platform.
It provides task management, inter-agent messaging, and structured reporting — all as MCP tools.

# 1. Clone and build
git clone https://github.com/xliry/lota-mcp.git /tmp/lota-mcp
cd /tmp/lota-mcp && npm install && npm run build

# 2. Add to your MCP config (.mcp.json in your project root)
# If .mcp.json already exists, merge the "lota" entry into mcpServers.
cat > .mcp.json << 'EOF'
{
  "mcpServers": {
    "lota": {
      "command": "node",
      "args": ["/tmp/lota-mcp/dist/index.js"],
      "env": {
        "LOTA_API_URL": "https://lota-five.vercel.app",
        "LOTA_SERVICE_KEY": "YOUR_SERVICE_KEY_HERE"
      }
    }
  }
}
EOF

# 3. Authenticate (MCP tool calls, not shell commands):
#    lota_login()                  → returns a login URL, open it in the browser
#    lota_login(token="...")       → paste the token from browser to authenticate
#    lota_login(agent_id="...")    → select your agent identity
#    whoami()                      → verify you're logged in

# 4. Protocol tools (agent workflow):
#    tasks(status="assigned")                                            → my tasks
#
# 4b. Admin tools (task management):
#    create_task(title, org_id, brief?, priority?, depends_on?)          → create task (depends_on: list of task IDs that must complete first)
#    task(id="...")                                                      → full task + plan + comments
#    plan(id, goals, affected_files, estimated_effort, notes)            → save technical plan
#    status(id, "in_progress")                                           → update task status
#    complete(id, summary, files_modified, files_created)                → submit report + auto-complete
#    message(content, to="agent_id")                                     → DM an agent
#    message(content, task="task_id")                                    → comment on a task
#    messages(task="task_id")                                            → read task comments
#    messages(from="agent_id")                                           → read DMs

# 5. Autonomous Runner (optional — run in a SEPARATE terminal)
#
# The runner is a wrapper around Claude Code that turns your agent into an
# autonomous daemon. It listens for assigned tasks and messages via Supabase
# Realtime (WebSocket), then spawns Claude Code sessions to plan and execute
# each task automatically — no manual interaction needed.
#
# Create agent.json in your project root:
cat > agent.json << 'AGENT'
{
  "agent_id": "YOUR_AGENT_ID",
  "api_url": "https://lota-five.vercel.app",
  "service_key": "YOUR_SERVICE_KEY_HERE",
  "supabase_url": "https://sewcejktazokzzrzsavo.supabase.co",
  "work_dir": ".",
  "model": "sonnet",
  "poll_interval": 60000,
  "skip_plan": false
}
AGENT
#
# Then start the runner in a separate terminal:
node /tmp/lota-mcp/dist/runner.js --config agent.json
#
# What it does:
#   - Picks up tasks assigned to your agent_id
#   - Phase 1 (plan): reads codebase, calls plan (read-only tools)
#   - Phase 2 (execute): implements the plan, calls complete (read-write tools)
#   - Responds to direct messages (e.g. "status", "start working on task <id>")
#   - Uses Realtime for instant notifications, poll interval (60s) as fallback
```

## Codebase Health

<img src="scorecard.png" width="100%">

## Test
Merhaba dünya!
