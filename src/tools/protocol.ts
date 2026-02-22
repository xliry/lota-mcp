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

export function registerProtocolTools(server: McpServer) {
  // ── whoami ───────────────────────────────────────────────────────
  server.tool(
    "whoami",
    "Agent identity + org + role",
    {},
    async () => {
      const agentId = api.getAgentId();
      if (!agentId) {
        return {
          content: [{ type: "text" as const, text: "Not logged in. Use `lota_login` to authenticate." }],
          isError: true,
        };
      }
      try {
        const members = await api.get<Member[]>("/api/members");
        const member = members.find((m) => m.agent_id === agentId);
        if (!member) {
          return {
            content: [{ type: "text" as const, text: `Agent ID: \`${agentId}\` (not found in members)` }],
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: [
              `**${member.name}**`,
              `Agent ID: \`${member.agent_id}\``,
              `Role: ${member.role}`,
              `Org: ${member.organizations?.name || member.org_id}`,
            ].join("\n"),
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

  // ── tasks ───────────────────────────────────────────────────────
  server.tool(
    "tasks",
    "List my tasks, auto-filtered by agent_id",
    {
      status: z.enum(["draft", "planned", "assigned", "in_progress", "completed"]).optional().describe("Filter by status"),
    },
    async ({ status }) => {
      const agentId = api.getAgentId();
      if (!agentId) {
        return {
          content: [{ type: "text" as const, text: "Not logged in. Use `lota_login` to authenticate." }],
          isError: true,
        };
      }
      try {
        const params: Record<string, string> = { agentId };
        if (status) params.status = status;
        const result = await api.get("/api/tasks", params);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── task ────────────────────────────────────────────────────────
  server.tool(
    "task",
    "Full task details + plan + comments thread",
    {
      id: z.string().describe("Task ID"),
    },
    async ({ id }) => {
      try {
        const [task, comments] = await Promise.all([
          api.get<Record<string, unknown>>(`/api/tasks/${id}`),
          api.get(`/api/tasks/${id}/comments`),
        ]);

        // Resolve dependency status
        const dependsOn = (task.depends_on as string[] | undefined) || [];
        let dependencies: { id: string; title: string; status: string }[] | undefined;
        if (dependsOn.length > 0) {
          dependencies = await Promise.all(
            dependsOn.map(async (depId) => {
              try {
                const dep = await api.get<{ id: string; title: string; status: string }>(`/api/tasks/${depId}`);
                return { id: dep.id, title: dep.title, status: dep.status };
              } catch {
                return { id: depId, title: "(unknown)", status: "unknown" };
              }
            })
          );
        }

        const result: Record<string, unknown> = { ...task, comments };
        if (dependencies) result.dependencies = dependencies;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── plan ────────────────────────────────────────────────────────
  server.tool(
    "plan",
    "Save a technical plan for a task (sets status to planned)",
    {
      id: z.string().describe("Task ID"),
      goals: z.array(z.object({ title: z.string(), completed: z.boolean() })).describe("Plan goals"),
      affected_files: z.array(z.string()).describe("Files that will be affected"),
      estimated_effort: z.enum(["low", "medium", "high"]).describe("Estimated effort level"),
      notes: z.string().describe("Additional notes"),
    },
    async ({ id, goals, affected_files, estimated_effort, notes }) => {
      try {
        const result = await api.put(`/api/tasks/${id}/plan`, {
          goals,
          affected_files,
          estimated_effort,
          notes,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── complete ───────────────────────────────────────────────────
  server.tool(
    "complete",
    "Submit a completion report for a task (auto-completes the task)",
    {
      id: z.string().describe("Task ID"),
      summary: z.string().describe("Summary of work done"),
      files_modified: z.array(z.string()).optional().describe("Files modified"),
      files_created: z.array(z.string()).optional().describe("New files created"),
    },
    async ({ id, summary, files_modified, files_created }) => {
      try {
        const body: Record<string, unknown> = {
          task_id: id,
          agent_id: api.getAgentId(),
          summary,
        };
        if (files_modified) body.modified_files = files_modified;
        if (files_created) body.new_files = files_created;
        const result = await api.post("/api/reports", body);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── status ─────────────────────────────────────────────────────
  server.tool(
    "status",
    "Update task status",
    {
      id: z.string().describe("Task ID"),
      status: z.enum(["draft", "planned", "assigned", "in_progress", "completed"]).describe("New status"),
    },
    async ({ id, status }) => {
      try {
        const result = await api.patch(`/api/tasks/${id}/status`, { status });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── message ────────────────────────────────────────────────────
  server.tool(
    "message",
    "Send a message: DM (to agent) or task comment (to task). Provide `to` for DM, `task` for comment, or both.",
    {
      content: z.string().describe("Message content"),
      to: z.string().optional().describe("Agent ID to DM"),
      task: z.string().optional().describe("Task ID to comment on"),
    },
    async ({ content, to, task }) => {
      if (!to && !task) {
        return {
          content: [{ type: "text" as const, text: "Error: provide `to` (agent ID) for DM or `task` (task ID) for comment." }],
          isError: true,
        };
      }
      try {
        const results: unknown[] = [];

        if (task) {
          const body = { content, agent_id: api.getAgentId() };
          results.push(await api.post(`/api/tasks/${task}/comments`, body));
        }

        if (to) {
          const body = {
            sender_agent_id: api.getAgentId(),
            receiver_agent_id: to,
            content,
          };
          results.push(await api.post("/api/messages", body));
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(results.length === 1 ? results[0] : results, null, 2) }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  // ── messages ───────────────────────────────────────────────────
  server.tool(
    "messages",
    "Read messages: task comments (if `task` provided) or DMs (otherwise)",
    {
      task: z.string().optional().describe("Task ID to get comments for"),
      from: z.string().optional().describe("Filter DMs to conversation with this agent ID"),
      since: z.string().optional().describe("ISO timestamp - only return messages after this time"),
    },
    async ({ task, from, since }) => {
      try {
        if (task) {
          const params: Record<string, string> = {};
          if (since) params.since = since;
          const result = await api.get(`/api/tasks/${task}/comments`, params);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        }

        // DMs
        const params: Record<string, string> = {};
        params.agentId = api.getAgentId() || "";
        if (from) params.withAgent = from;
        if (since) params.since = since;
        const result = await api.get("/api/messages", params);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
