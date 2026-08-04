#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { handler as hourlyHandler } from "./tools/WeatherTool.js";
import { handler as dailyHandler } from "./tools/WeatherDailyTool.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

const SERVER_NAME = "mcp-weather";
const SERVER_VERSION = "0.4.2";

// Define the hourly forecast tool
const hourlyWeatherTool: Tool = {
  name: "weather-get_hourly",
  description: "Get hourly weather forecast for the next 12 hours",
  inputSchema: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "The city or location for which to retrieve the weather forecast."
      },
      units: {
        type: "string",
        description: "Temperature unit system (metric for Celsius, imperial for Fahrenheit). Default is metric.",
        enum: ["metric", "imperial"]
      }
    },
    required: ["location"]
  }
};

// Define the daily forecast tool
const dailyWeatherTool: Tool = {
  name: "weather-get_daily",
  description: "Get daily weather forecast for up to 15 days",
  inputSchema: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "The city or location for which to retrieve the weather forecast."
      },
      days: {
        type: "number",
        description: "Number of days to forecast (1, 5, 10, or 15). Default is 5.",
        enum: [1, 5, 10, 15]
      },
      units: {
        type: "string",
        description: "Temperature unit system (metric for Celsius, imperial for Fahrenheit). Default is metric.",
        enum: ["metric", "imperial"]
      }
    },
    required: ["location"]
  }
};

function buildMcpServer(): Server {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Set up request handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [hourlyWeatherTool, dailyWeatherTool],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = request.params.arguments;
      if (args === undefined) {
        return {
          content: [{ type: "text", text: "Error: No arguments provided for the tool." }],
          isError: true
        };
      }

      if (request.params.name === "weather-get_hourly") {
        return await hourlyHandler(args, {} as RequestHandlerExtra<any, any>);
      } else if (request.params.name === "weather-get_daily") {
        return await dailyHandler(args, {} as RequestHandlerExtra<any, any>);
      } else {
        return {
          content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
          isError: true
        };
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true
      };
    }
  });

  return server;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function verifyApiKey(req: IncomingMessage): boolean {
  const expected = process.env.API_KEY;
  if (!expected) {
    return true;
  }

  const actual = headerValue(req.headers["x-api-key"]);
  if (!actual) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const rawBody = Buffer.concat(chunks).toString("utf8");
  return rawBody ? JSON.parse(rawBody) : undefined;
}

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
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const httpServer = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(res, 200, { status: "healthy" });
      return;
    }

    if (requestUrl.pathname !== mcpPath) {
      sendJson(res, 404, { detail: "Not found" });
      return;
    }

    if (!verifyApiKey(req)) {
      sendJson(res, 403, { detail: "Invalid or missing API key" });
      return;
    }

    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const sessionId = headerValue(req.headers["mcp-session-id"]);
        let transport: StreamableHTTPServerTransport | undefined = sessionId ? transports[sessionId] : undefined;

        if (!transport && !sessionId && isInitializeRequest(body)) {
          const mcpServer = buildMcpServer();
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              if (transport) {
                transports[newSessionId] = transport;
              }
            },
          });
          transport.onclose = () => {
            if (transport?.sessionId) {
              delete transports[transport.sessionId];
            }
            void mcpServer.close();
          };
          await mcpServer.connect(transport);
        }

        if (!transport) {
          sendJson(res, 400, {
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: No valid session ID provided",
            },
            id: null,
          });
          return;
        }

        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        const sessionId = headerValue(req.headers["mcp-session-id"]);
        const transport = sessionId ? transports[sessionId] : undefined;
        if (!transport) {
          sendJson(res, 400, { detail: "Invalid or missing session ID" });
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }

      res.writeHead(405, { allow: "GET, POST, DELETE" });
      res.end();
    } catch (error) {
      console.error("Server error:", error);
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  httpServer.listen(port, host, () => {
    console.error(`Weather MCP Server listening on http://${host}:${port}${mcpPath}`);
  });
}

const transport = process.env.MCP_TRANSPORT;
const shouldRunHttp = transport === "streamable-http" || transport === "http" || Boolean(process.env.PORT);

(shouldRunHttp ? runHttpServer() : runStdioServer()).catch((err) => {
  console.error("Server error:", err);
  process.exit(1);
});
