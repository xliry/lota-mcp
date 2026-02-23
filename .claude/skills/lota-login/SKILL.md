---
name: lota-login
description: >
  Interactive LOTA setup wizard. Sets up GitHub Issues-backed agent communication.
  Creates .mcp.json with credentials, tests the connection, and optionally creates
  the agent repo. Use when the user says "lota login", "lota setup", "lota kurulum",
  "connect to lota", or wants to configure agent communication.
allowed-tools: Bash(git clone *), Bash(cd * && npm *), Bash(npm *), Bash(node *), Bash(mkdir *)
---

# LOTA Login — Setup Wizard

## What to do

Guide the user through LOTA setup interactively. Ask questions one at a time.

### Step 1: Check prerequisites

Verify Node.js is installed:
```bash
node --version
```

If not installed, tell the user to install Node.js 18+ first.

### Step 2: Clone and build lota-mcp

```bash
git clone https://github.com/xliry/lota-mcp.git /tmp/lota-mcp && cd /tmp/lota-mcp && npm install && npm run build
```

If `/tmp/lota-mcp` already exists, skip clone and just rebuild:
```bash
cd /tmp/lota-mcp && git pull && npm install && npm run build
```

### Step 3: Ask for credentials

Ask the user these 3 things using AskUserQuestion or direct questions:

1. **GitHub Token**: "Paste your GitHub Personal Access Token (needs Issues read/write permission)"
   - Guide: Settings → Developer settings → Fine-grained tokens → Issues (Read & Write)

2. **GitHub Repo**: "Which repo for agent communication? (format: owner/repo-name)"
   - If they don't have one yet, suggest: "Create a private repo called `my-agents` on GitHub"

3. **Agent Name**: "Pick an agent name (e.g. dev-1, alice, bot-1)"
   - Default suggestion: `dev-1`

### Step 4: Write .mcp.json

Write the config to the **current project's** `.mcp.json`:

```json
{
  "mcpServers": {
    "lota": {
      "command": "node",
      "args": ["/tmp/lota-mcp/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "<user's token>",
        "GITHUB_REPO": "<user's repo>",
        "AGENT_NAME": "<user's agent name>"
      }
    }
  }
}
```

If `.mcp.json` already exists, merge the `lota` key into the existing `mcpServers`.

### Step 5: Test connection

Tell the user to **restart Claude Code** so the MCP server loads. Then they can test with:

```
lota("GET", "/sync")
```

### Step 6: Report success

Show the user:

```
LOTA Setup Complete!

  MCP Server: /tmp/lota-mcp/dist/index.js
  Agent:      <agent-name>
  Repo:       <repo>
  Config:     .mcp.json

Next steps:
  • Admin:  Create tasks with lota("POST", "/tasks", {"title": "...", "assign": "dev-1"})
  • Agent:  Run /lota-agent to start autonomous mode
  • Sync:   lota("GET", "/sync") to check pending work
```

That's ALL. Do NOT run extra diagnostics.
