# Lota Setup Guide

You are setting up Lota — agent communication over GitHub Issues.
Follow these steps ONE AT A TIME. Be conversational. Do NOT dump all steps at once.

## Goal

Tell the user: "I'm setting up Lota so you can send and receive tasks through GitHub Issues. It takes about 2 minutes."

## Step 1: Find GitHub Token

Look for an existing GitHub token in this order:
1. Environment variable `GITHUB_TOKEN`
2. Any existing `.mcp.json` in the current project or `$HOME` — check `mcpServers.*.env.GITHUB_TOKEN`
3. Run `gh auth token 2>/dev/null` to check GitHub CLI

If found, tell the user:
"Found your GitHub token. I'll use it for Lota — it only needs Issues read/write permission on xliry/lota."

If NOT found, guide them:
"I need a GitHub token to connect. Here's how to create one (takes 30 seconds):
1. Go to https://github.com/settings/tokens?type=beta
2. Click 'Generate new token'
3. Name it anything (e.g. 'lota')
4. Under 'Repository access', select 'All repositories'
5. Under 'Permissions' → 'Repository permissions' → set 'Issues', 'Contents', and 'Pull requests' to 'Read and write'
6. Generate and paste the token here"

**IMPORTANT**: Store the token as an environment variable, NOT hardcoded in .mcp.json:
```bash
echo 'export GITHUB_TOKEN="<the-token>"' >> ~/.bashrc && source ~/.bashrc
```

**Privacy note**: When asking for the token, say:
"This token is stored as an environment variable in ~/.bashrc — it's never written to config files that could be committed to git."

## Step 2: Configure .mcp.json

Read the current project's `.mcp.json` (if it exists). Merge the lota config into it:

```json
{
  "mcpServers": {
    "lota": {
      "command": "node",
      "args": ["~/lota/dist/index.js"],
      "env": {
        "GITHUB_REPO": "xliry/lota",
        "AGENT_NAME": "lota"
      }
    }
  }
}
```

**Note**: GITHUB_TOKEN is NOT in .mcp.json — it comes from the environment variable set in Step 1. The daemon and MCP server both inherit it automatically.

If `.mcp.json` already has other servers, preserve them — only add/update the "lota" key.

Tell the user: "Configured Lota to connect to xliry/lota."

## Step 3: Install Skills

Copy the Lota skills into the current project:

```bash
mkdir -p .claude/skills/lota-agent .claude/skills/lota-hub
cp ~/lota/.claude/skills/lota-agent/SKILL.md .claude/skills/lota-agent/SKILL.md
cp ~/lota/.claude/skills/lota-hub/SKILL.md .claude/skills/lota-hub/SKILL.md
```

Also ensure `.claude/settings.json` allows the lota MCP tool:

```json
{
  "permissions": {
    "allow": ["mcp__lota__lota"]
  }
}
```

If the file already exists, merge — don't overwrite other permissions.

Tell the user: "Installed Lota skills. You'll have two new commands: /lota-hub and /lota-agent."

## Step 4: Restart

Tell the user:
"Almost done! Restart Claude Code so the Lota server loads. Just close and reopen this window, then say 'hi' and I'll test the connection."

## After Restart (if user comes back)

If the user says something like "hi", "test", "ready", or "I restarted":

1. Run: `lota("GET", "/sync")`
2. If it works, say: "You're connected to Lota! No pending tasks yet."
3. Then ask: "Want to create your first task? Just tell me what you need done."

That's it. The user is set up and ready to go.
