import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { createHttpServer, type WeatherHttpServer } from "../src/httpServer";

const MCP_PATH = "/mcp";
const ACCEPT = "application/json, text/event-stream";
const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
});

let clock = 0;
let instance: WeatherHttpServer;
let baseUrl: string;

async function start(overrides: Partial<Parameters<typeof createHttpServer>[0]> = {}): Promise<void> {
  instance = createHttpServer({
    mcpPath: MCP_PATH,
    maxBodyBytes: 4 * 1024,
    maxSessions: 2,
    sessionIdleTimeoutMs: 60_000,
    now: () => clock,
    ...overrides,
  });
  await new Promise<void>((resolve) => instance.server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = instance.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}${MCP_PATH}`;
}

async function initialize(): Promise<Response> {
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: ACCEPT },
    body: initializeBody,
  });
  await res.text();
  return res;
}

// Sends a chunked body with no Content-Length, so only the streaming check can stop it.
function postChunked(totalBytes: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(baseUrl, { method: "POST", headers: { "content-type": "application/json", accept: ACCEPT } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    const chunk = "x".repeat(1024);
    for (let sent = 0; sent < totalBytes; sent += chunk.length) {
      req.write(chunk);
    }
    req.end();
  });
}

beforeEach(async () => {
  clock = 1_000;
  delete process.env.API_KEY;
  await start();
});

afterEach(async () => {
  await instance.close();
});

describe("request body limit", () => {
  it("returns 413 for a declared body over the limit", async () => {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT },
      body: JSON.stringify({ padding: "x".repeat(8 * 1024) }),
    });

    expect(res.status).toBe(413);
    expect(instance.sessions.size).toBe(0);
  });

  it("returns 413 for a chunked body that grows past the limit", async () => {
    await expect(postChunked(64 * 1024)).resolves.toBe(413);
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT },
      body: "{not json",
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });
});

describe("session cap and cleanup", () => {
  it("refuses new sessions with 503 at the cap", async () => {
    expect((await initialize()).status).toBe(200);
    expect((await initialize()).status).toBe(200);

    const refused = await initialize();

    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("30");
    expect(instance.sessions.size).toBe(2);
  });

  it("frees the slot when a client deletes its session", async () => {
    const first = await initialize();
    await initialize();
    const sessionId = first.headers.get("mcp-session-id")!;

    const deleted = await fetch(baseUrl, { method: "DELETE", headers: { "mcp-session-id": sessionId } });
    await deleted.text();

    expect(deleted.status).toBe(200);
    expect(instance.sessions.size).toBe(1);
    expect((await initialize()).status).toBe(200);
  });

  it("expires idle sessions so new clients can connect", async () => {
    const first = await initialize();
    await initialize();
    const staleId = first.headers.get("mcp-session-id")!;

    clock += 60_000;

    expect((await initialize()).status).toBe(200);
    const stale = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT, "mcp-session-id": staleId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(stale.status).toBe(400);
  });

  it("does not leak a slot when initialization is rejected", async () => {
    const badAccept = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: initializeBody,
    });
    await badAccept.text();

    expect(badAccept.status).toBeGreaterThanOrEqual(400);
    expect((await initialize()).status).toBe(200);
    expect((await initialize()).status).toBe(200);
  });
});

describe("authentication", () => {
  it("still requires the API key before reading the body", async () => {
    process.env.API_KEY = "expected-key";

    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT, "x-api-key": "wrong" },
      body: initializeBody,
    });

    expect(res.status).toBe(403);
    expect(instance.sessions.size).toBe(0);
  });
});
