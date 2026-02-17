import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerReportTools } from "./tools/reports.js";
import { registerOrganizationTools } from "./tools/organizations.js";
import { registerMessagingTools } from "./tools/messaging.js";

const server = new McpServer({
  name: "lota-mcp",
  version: "1.0.0",
});

registerAuthTools(server);
registerTaskTools(server);
registerReportTools(server);
registerOrganizationTools(server);
registerMessagingTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
