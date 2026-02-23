---
name: lota-agent
description: >
  Trigger the LOTA agent via GitHub Actions. Use when the user says "lota-agent",
  "start agent", "otonom mod", "agent başlat", "run agent", or wants to trigger
  the autonomous agent workflow.
allowed-tools: Bash(gh *), Bash(curl *)
---

# LOTA Agent Skill

## What to do

Trigger the GitHub Actions agent workflow for this repository.

### Step 1: Trigger the workflow

```bash
gh workflow run agent.yml --repo xliry/lota-mcp
```

### Step 2: Check status

```bash
gh run list --workflow=agent.yml --repo xliry/lota-mcp --limit 1
```

### Step 3: Report to user

Tell the user:
- Workflow triggered successfully
- They can watch progress: `gh run watch --repo xliry/lota-mcp`
- Or view in browser: `gh run view --web --repo xliry/lota-mcp`
