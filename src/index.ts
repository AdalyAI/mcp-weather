#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./mcpServer.js";
import { createHttpServer } from "./httpServer.js";
import { positiveIntFromEnv } from "./http.js";

async function runStdioServer(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Weather MCP Server running on stdio");
}

async function runHttpServer(): Promise<void> {
  const host = process.env.HOST ?? "0.0.0.0";
  const port = Number.parseInt(process.env.PORT ?? "8000", 10);
  const mcpPath = process.env.MCP_PATH ?? "/mcp";

  const { server } = createHttpServer({
    mcpPath,
    maxBodyBytes: positiveIntFromEnv("MAX_BODY_BYTES", 64 * 1024),
    maxSessions: positiveIntFromEnv("MAX_SESSIONS", 100),
    sessionIdleTimeoutMs: positiveIntFromEnv("SESSION_IDLE_TIMEOUT_MS", 15 * 60 * 1000),
  });

  server.listen(port, host, () => {
    console.error(`Weather MCP Server listening on http://${host}:${port}${mcpPath}`);
  });
}

const transport = process.env.MCP_TRANSPORT;
const shouldRunHttp = transport === "streamable-http" || transport === "http" || Boolean(process.env.PORT);

(shouldRunHttp ? runHttpServer() : runStdioServer()).catch((err) => {
  console.error("Server error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
