---
name: lota-agent
description: >
  Start the autonomous LOTA agent in the background. The agent polls GitHub Issues
  for assigned tasks, then spawns Claude Code to plan, execute, and complete them.
  Use when the user says "lota-agent", "start agent", "autonomous mode", "launch agent",
  or wants to run the autonomous agent.
allowed-tools: Bash(node *), Bash(cd * && node *), Bash(kill *), Bash(sleep *), Bash(ps *), Bash(pkill *), Bash(git clone *), Bash(npm *), Bash(curl *), Bash(mkdir *)
---

# LOTA Agent Skill

## What to do

Run this EXACT sequence. Do NOT run any other commands.

### Step 1: Ensure lota-mcp is built

Check if the build exists. If not, clone and build automatically:

```bash
if [ ! -f /tmp/lota-mcp/dist/daemon.js ]; then
  git clone https://github.com/xliry/lota-mcp.git /tmp/lota-mcp && cd /tmp/lota-mcp && npm install && npm run build
fi
```

If npm is not found, install Node.js first:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
```

### Step 2: Ensure .mcp.json exists

If `.mcp.json` does not exist in the current project directory, ask the user for:
1. GitHub Token (fine-grained PAT with Issues read/write)
2. GitHub Repo (owner/repo format)
3. Agent Name (default: dev-1)

Then write `.mcp.json` with those values. If it already exists, skip this step.

### Step 3: Kill any existing agent

```bash
pkill -f "node.*daemon" 2>/dev/null; true
```

Note: This may show "exit code 144" — that's normal (process was killed). Ignore it.

### Step 4: Start agent in background

Run with `run_in_background: true` and `timeout: 600000`:

```bash
cd /tmp/lota-mcp && node dist/daemon.js --interval 15 2>&1
```

### Step 5: Wait and read log file

```bash
sleep 5
```

Then use the **Read** tool to read `~/.lota/agent.log`.

### Step 6: Report to user

Show the log content and tell the user:
- The agent name (from banner)
- The poll interval
- "Agent is running. Check logs anytime: `cat ~/.lota/agent.log`"

That's ALL. Do NOT run diagnostics, version checks, or anything else.
