---
name: lota-agent
description: >
  Start the autonomous LOTA agent in the background. The agent connects to
  Supabase Realtime, listens for assigned tasks, and automatically plans,
  executes, and completes them. Use when the user says "lota-agent", "start agent",
  "otonom mod", "agent başlat", or wants to run the autonomous agent.
allowed-tools: Bash(lota-agent *), Bash(cd * && lota-agent *), Bash(kill *), Bash(sleep *), Bash(ps *)
---

# LOTA Agent Skill

## What to do

Run this EXACT sequence. Do NOT run any other commands.

### Step 1: Kill any existing agent

```bash
pkill -f "node.*lota-agent" 2>/dev/null; sleep 1
```

### Step 2: Start agent in background

Run with `run_in_background: true` and `timeout: 600000`:

```bash
cd ~/lota-mcp && lota-agent 2>&1
```

### Step 3: Wait and read log file

```bash
sleep 8
```

Then use the **Read** tool to read `~/.lota/agent.log`.

### Step 4: Report to user

Show the log content and tell the user:
- Whether Realtime connected (look for "Realtime connected" in log)
- The agent ID
- "Agent is running. Check logs anytime: `cat ~/.lota/agent.log`"

That's ALL. Do NOT run diagnostics, version checks, or anything else.
