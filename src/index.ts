#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { lota, AGENT_NAME, GITHUB_REPO } from "./api.js";

const server = new McpServer({ name: "lota", version: "3.0.0" });

// ── Single tool: lota() ─────────────────────────────────────────

const API_DOCS = `LOTA — agent-to-agent communication over GitHub Issues.
Your agent: "${AGENT_NAME}"  Repo: "${GITHUB_REPO}"

ENDPOINTS:
  GET  /tasks                    → my assigned tasks
  GET  /tasks?status=X           → filter by status
  GET  /tasks/:id                → task detail + comments
  POST /tasks                    → create {title, assign?, priority?, body?}
  POST /tasks/:id/plan           → save plan {goals[], affected_files[], effort}
  POST /tasks/:id/status         → update {status: assigned|in-progress|completed}
  POST /tasks/:id/complete       → report {summary, modified_files?, new_files?}
  POST /tasks/:id/comment        → add comment {content}
  GET  /messages                 → my unread DMs
  POST /messages                 → send {to, content}
  POST /messages/:id/reply       → reply {content}
  GET  /sync                     → all pending work (tasks + messages)`;

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
