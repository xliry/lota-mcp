import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";

interface Member {
  id: string;
  name: string;
  agent_id: string;
  role: string;
  org_id: string;
  organizations?: { name: string };
}

function formatAgentList(members: Member[]): string {
  if (members.length === 0) {
    return "No agents found.";
  }
  return members.map((m) =>
    `- **${m.name}** (agent_id: \`${m.agent_id}\`, role: ${m.role}, org: ${m.organizations?.name || m.org_id})`
  ).join("\n");
}

export function registerAdminTools(server: McpServer) {
  // ── lota_login ─────────────────────────────────────────────────
  server.tool(
    "lota_login",
    "Login to LOTA platform. Step 1: Call without params to get login URL. Step 2: Open URL in browser and authorize, copy the token. Step 3: Call with token to authenticate and see available agents. Step 4: Call with agent_id to select your agent.",
    {
      token: z.string().optional().describe("Auth token obtained from the browser after authorizing at the login URL."),
      agent_id: z.string().optional().describe("Agent ID to login as (after authentication with token)."),
    },
    async ({ token, agent_id }) => {
      try {
        // Step 1: No params → return login URL
        if (!token && !agent_id) {
          if (api.isAuthenticated()) {
            const members = await api.get<Member[]>("/api/members");
            const list = formatAgentList(members);
            return {
              content: [{
                type: "text" as const,
                text: `Already authenticated.\n\nAvailable agents:\n\n${list}\n\nCall \`lota_login\` with \`agent_id\` to select an agent.`,
              }],
            };
          }

          const loginUrl = `${api.getBaseUrl()}/cli`;
          return {
            content: [{
              type: "text" as const,
              text: `**LOTA Login**\n\nAuthorize by opening this link:\n\n[${loginUrl}](${loginUrl})\n\nAfter authorizing, copy the token and call \`lota_login\` with the \`token\` parameter.`,
            }],
          };
        }

        // Step 2: Token provided → validate and list agents
        if (token) {
          api.setAuthToken(token);

          try {
            const members = await api.get<Member[]>("/api/members");
            const list = formatAgentList(members);
            return {
              content: [{
                type: "text" as const,
                text: `**Authentication successful!**\n\nAvailable agents:\n\n${list}\n\nCall \`lota_login\` with \`agent_id\` to select your agent.`,
              }],
            };
          } catch {
            api.setAuthToken("");
            return {
              content: [{
                type: "text" as const,
                text: `**Authentication failed.** The token is invalid or expired.\n\nPlease get a new token from: [${api.getBaseUrl()}/cli](${api.getBaseUrl()}/cli)`,
              }],
              isError: true,
            };
          }
        }

        // Step 3: Agent ID provided → select agent
        if (agent_id) {
          if (!api.isAuthenticated()) {
            const loginUrl = `${api.getBaseUrl()}/cli`;
            return {
              content: [{
                type: "text" as const,
                text: `Not authenticated yet. First get a token:\n\n[${loginUrl}](${loginUrl})\n\nThen call \`lota_login\` with the \`token\` parameter.`,
              }],
              isError: true,
            };
          }

          const members = await api.get<Member[]>("/api/members");
          const member = members.find((m) => m.agent_id === agent_id);
          if (!member) {
            const list = formatAgentList(members);
            return {
              content: [{
                type: "text" as const,
                text: `Agent \`${agent_id}\` not found.\n\nAvailable agents:\n\n${list}`,
              }],
              isError: true,
            };
          }

          api.setAgentId(agent_id);
          return {
            content: [{
              type: "text" as const,
              text: `Logged in as **${member.name}** (${member.role})\nAgent ID: \`${member.agent_id}\`\nOrg: ${member.organizations?.name || member.org_id}\n\nYou're ready to work!`,
            }],
          };
        }

        return {
          content: [{ type: "text" as const, text: "Invalid parameters." }],
          isError: true,
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ── create_task ────────────────────────────────────────────────
  server.tool(
    "create_task",
    "Create a new task in draft status",
    {
      title: z.string().describe("Task title"),
      org_id: z.string().describe("Organization ID"),
      brief: z.string().optional().describe("Task brief/description"),
      priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("Task priority (default: medium)"),
      depends_on: z.array(z.string()).optional().describe("List of task IDs this task depends on (must complete before this task can start)"),
    },
    async ({ title, org_id, brief, priority, depends_on }) => {
      try {
        const body: Record<string, unknown> = { title, org_id };
        if (brief !== undefined) body.brief = brief;
        if (priority !== undefined) body.priority = priority;
        if (depends_on !== undefined) body.depends_on = depends_on;
        const result = await api.post("/api/tasks", body);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── update_task ────────────────────────────────────────────────
  server.tool(
    "update_task",
    "Update task title, brief, priority, or dependencies",
    {
      id: z.string().describe("Task ID"),
      title: z.string().optional().describe("New title"),
      brief: z.string().optional().describe("New brief"),
      priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("New priority"),
      depends_on: z.array(z.string()).optional().describe("List of task IDs this task depends on"),
    },
    async ({ id, title, brief, priority, depends_on }) => {
      try {
        const body: Record<string, unknown> = {};
        if (title !== undefined) body.title = title;
        if (brief !== undefined) body.brief = brief;
        if (priority !== undefined) body.priority = priority;
        if (depends_on !== undefined) body.depends_on = depends_on;
        const result = await api.patch(`/api/tasks/${id}`, body);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── assign_task ────────────────────────────────────────────────
  server.tool(
    "assign_task",
    "Assign a task to an agent by agent_id",
    {
      id: z.string().describe("Task ID"),
      agent_id: z.string().describe("Agent ID to assign"),
    },
    async ({ id, agent_id }) => {
      try {
        const result = await api.post(`/api/tasks/${id}/assign`, { agent_id });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── list_tasks ─────────────────────────────────────────────────
  server.tool(
    "list_tasks",
    "List tasks with optional filters (agentId, orgId, status)",
    {
      agentId: z.string().optional().describe("Filter by agent ID"),
      orgId: z.string().optional().describe("Filter by organization ID"),
      status: z.enum(["draft", "planned", "assigned", "in_progress", "completed"]).optional().describe("Filter by status"),
    },
    async ({ agentId, orgId, status }) => {
      try {
        const params: Record<string, string> = {};
        if (agentId) params.agentId = agentId;
        if (orgId) params.orgId = orgId;
        if (status) params.status = status;
        const result = await api.get("/api/tasks", params);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── list_organizations ─────────────────────────────────────────
  server.tool(
    "list_organizations",
    "List all organizations",
    {},
    async () => {
      try {
        const result = await api.get("/api/organizations");
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── get_organization ───────────────────────────────────────────
  server.tool(
    "get_organization",
    "Get details of a specific organization",
    {
      id: z.string().describe("Organization ID"),
    },
    async ({ id }) => {
      try {
        const result = await api.get(`/api/organizations/${id}`);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── create_organization ────────────────────────────────────────
  server.tool(
    "create_organization",
    "Create a new organization",
    {
      name: z.string().describe("Organization name"),
      github_repo_url: z.string().optional().describe("GitHub repository URL"),
    },
    async ({ name, github_repo_url }) => {
      try {
        const body: Record<string, unknown> = { name };
        if (github_repo_url !== undefined) body.github_repo_url = github_repo_url;
        const result = await api.post("/api/organizations", body);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── list_members ───────────────────────────────────────────────
  server.tool(
    "list_members",
    "List team members, optionally filtered by organization",
    {
      orgId: z.string().optional().describe("Filter by organization ID"),
    },
    async ({ orgId }) => {
      try {
        const params: Record<string, string> = {};
        if (orgId) params.orgId = orgId;
        const result = await api.get("/api/members", params);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── list_reports ───────────────────────────────────────────────
  server.tool(
    "list_reports",
    "List reports, optionally filtered by task ID",
    {
      taskId: z.string().optional().describe("Filter by task ID"),
    },
    async ({ taskId }) => {
      try {
        const params: Record<string, string> = {};
        if (taskId) params.taskId = taskId;
        const result = await api.get("/api/reports", params);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
