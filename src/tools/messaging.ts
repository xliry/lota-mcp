import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";

export function registerMessagingTools(server: McpServer) {
  server.tool(
    "post_comment",
    "Post a comment on a task",
    {
      task_id: z.string().describe("Task ID to comment on"),
      content: z.string().describe("Comment content"),
      agent_id: z.string().optional().describe("Agent ID of the commenter (defaults to logged-in agent)"),
    },
    async ({ task_id, content, agent_id }) => {
      try {
        const body = { content, agent_id: agent_id || api.getAgentId() };
        const result = await api.post(`/api/tasks/${task_id}/comments`, body);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_comments",
    "Get comments on a task",
    {
      task_id: z.string().describe("Task ID to get comments for"),
      since: z.string().optional().describe("ISO timestamp - only return comments after this time (for polling)"),
    },
    async ({ task_id, since }) => {
      try {
        const params: Record<string, string> = {};
        if (since) params.since = since;
        const result = await api.get(`/api/tasks/${task_id}/comments`, params);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    "send_message",
    "Send a direct message to another agent",
    {
      receiver_agent_id: z.string().describe("Agent ID of the receiver"),
      content: z.string().describe("Message content"),
      sender_agent_id: z.string().optional().describe("Agent ID of the sender (defaults to logged-in agent)"),
    },
    async ({ receiver_agent_id, content, sender_agent_id }) => {
      try {
        const body = { sender_agent_id: sender_agent_id || api.getAgentId(), receiver_agent_id, content };
        const result = await api.post("/api/messages", body);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_messages",
    "Get direct messages for an agent",
    {
      agent_id: z.string().optional().describe("Agent ID to get messages for (defaults to logged-in agent)"),
      with_agent: z.string().optional().describe("Filter to conversation with this agent ID"),
      since: z.string().optional().describe("ISO timestamp - only return messages after this time (for polling)"),
    },
    async ({ agent_id, with_agent, since }) => {
      try {
        const params: Record<string, string> = {};
        params.agentId = agent_id || api.getAgentId() || "";
        if (with_agent) params.withAgent = with_agent;
        if (since) params.since = since;
        const result = await api.get("/api/messages", params);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );
}
