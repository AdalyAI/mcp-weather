import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer } from "./mcpServer.js";
import { BodyTooLargeError, InvalidJsonError, readJsonBody, SessionStore } from "./http.js";

export type HttpServerOptions = {
  mcpPath: string;
  maxBodyBytes: number;
  maxSessions: number;
  sessionIdleTimeoutMs: number;
  now?: () => number;
};

export type WeatherHttpServer = {
  server: HttpServer;
  sessions: SessionStore<StreamableHTTPServerTransport>;
  close: () => Promise<void>;
};

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
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

export function createHttpServer(options: HttpServerOptions): WeatherHttpServer {
  const sessions = new SessionStore<StreamableHTTPServerTransport>(
    options.maxSessions,
    options.sessionIdleTimeoutMs,
    (transport) => void transport.close(),
    options.now
  );
  const sweepTimer = setInterval(() => sessions.sweep(), Math.min(options.sessionIdleTimeoutMs, 60_000));
  sweepTimer.unref();

  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(res, 200, { status: "healthy" });
      return;
    }

    if (requestUrl.pathname !== options.mcpPath) {
      sendJson(res, 404, { detail: "Not found" });
      return;
    }

    if (!verifyApiKey(req)) {
      sendJson(res, 403, { detail: "Invalid or missing API key" });
      return;
    }

    try {
      if (req.method === "POST") {
        let body: unknown;
        try {
          body = await readJsonBody(req, options.maxBodyBytes);
        } catch (error) {
          if (error instanceof BodyTooLargeError) {
            // The rest of the body is never read, so close the connection
            // rather than leave it in an unknown state.
            res.on("finish", () => req.destroy());
            sendJson(res, 413, jsonRpcError(-32600, error.message), { connection: "close" });
            return;
          }
          if (error instanceof InvalidJsonError) {
            sendJson(res, 400, jsonRpcError(-32700, "Parse error"));
            return;
          }
          throw error;
        }

        const sessionId = headerValue(req.headers["mcp-session-id"]);
        let transport = sessionId ? sessions.get(sessionId) : undefined;

        if (!transport && !sessionId && isInitializeRequest(body)) {
          if (!sessions.reserve()) {
            sendJson(res, 503, jsonRpcError(-32000, "Too many active sessions"), { "retry-after": "30" });
            return;
          }
          let committed = false;
          try {
            const mcpServer = buildMcpServer();
            const newTransport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (newSessionId) => {
                committed = true;
                sessions.commit(newSessionId, newTransport);
              },
            });
            // connect() replaces transport.onclose, so cleanup hangs off the
            // server's onclose, which runs once the transport has closed.
            mcpServer.onclose = () => {
              if (newTransport.sessionId) {
                sessions.delete(newTransport.sessionId);
              }
            };
            transport = newTransport;
            await mcpServer.connect(newTransport);
            await newTransport.handleRequest(req, res, body);
          } finally {
            if (!committed) {
              sessions.release();
            }
          }
          return;
        }

        if (!transport) {
          sendJson(res, 400, jsonRpcError(-32000, "Bad Request: No valid session ID provided"));
          return;
        }

        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        const sessionId = headerValue(req.headers["mcp-session-id"]);
        const transport = sessionId ? sessions.get(sessionId) : undefined;
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
      console.error("Server error:", error instanceof Error ? error.message : String(error));
      if (!res.headersSent) {
        sendJson(res, 500, jsonRpcError(-32603, "Internal server error"));
      }
    }
  });

  return {
    server,
    sessions,
    close: async () => {
      clearInterval(sweepTimer);
      sessions.evictAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
