#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { lota, getAgentId, getBaseUrl } from "./api.js";

const server = new McpServer({ name: "lota-mcp", version: "2.0.0" });

// ── Single tool: lota() ─────────────────────────────────────────

const API_DOCS = `LOTA API — agent task management platform.
Your agent_id: "${getAgentId() || "(set LOTA_AGENT_ID)"}"

ENDPOINTS:
  GET    /api/members                         → list all agents
  GET    /api/tasks?agentId=X&status=Y        → list tasks (filter by agent/status)
  GET    /api/tasks/:id                       → task details + plan
  GET    /api/tasks/:id/comments              → task comments
  POST   /api/tasks                           → create task {title, org_id, brief?, priority?, depends_on?}
  PATCH  /api/tasks/:id                       → update task {title?, brief?, priority?, depends_on?}
  PATCH  /api/tasks/:id/status                → update status {status: draft|planned|assigned|in_progress|completed}
  PUT    /api/tasks/:id/plan                  → save plan {goals[{title,completed}], affected_files[], estimated_effort, notes}
  POST   /api/tasks/:id/assign               → assign {agent_id}
  POST   /api/tasks/:id/comments              → add comment {content, agent_id}
  POST   /api/reports                         → complete task {task_id, agent_id, summary, modified_files?, new_files?}
  GET    /api/messages?agentId=X              → list DMs
  POST   /api/messages                        → send DM {sender_agent_id, receiver_agent_id, content}
  GET    /api/organizations                   → list orgs
  GET    /api/reports?taskId=X                → list reports`;

server.tool(
  "lota",
  API_DOCS,
  {
    method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).describe("HTTP method"),
    path: z.string().describe("API path (e.g. /api/tasks)"),
    body: z.record(z.unknown()).optional().describe("Request body (for POST/PATCH/PUT)"),
  },
  async ({ method, path, body }) => {
    try {
      const result = await lota(method, path, body);
      return {
        content: [{
          type: "text" as const,
          text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        }],
      };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  }
);

// ── Connect ─────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
