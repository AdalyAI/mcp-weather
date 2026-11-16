import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { BodyTooLargeError, InvalidJsonError, positiveIntFromEnv, readJsonBody, SessionStore } from "../src/http";

function fakeRequest(chunks: string[], headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from(chunks.map((c) => Buffer.from(c))) as unknown as IncomingMessage;
  (stream as { headers: Record<string, string> }).headers = headers;
  return stream;
}

describe("readJsonBody", () => {
  it("parses a body at exactly the limit", async () => {
    const body = JSON.stringify({ a: "x".repeat(10) });

    await expect(readJsonBody(fakeRequest([body]), body.length)).resolves.toEqual({ a: "x".repeat(10) });
  });

  it("rejects a declared Content-Length over the limit before reading the body", async () => {
    const read = jest.fn();
    const req = fakeRequest(["{}"], { "content-length": "101" });
    req.on("data", read);

    await expect(readJsonBody(req, 100)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects a chunked body once it grows past the limit", async () => {
    const req = fakeRequest(["x".repeat(60), "x".repeat(60), "x".repeat(60)]);

    await expect(readJsonBody(req, 100)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("returns undefined for an empty body", async () => {
    await expect(readJsonBody(fakeRequest([]), 100)).resolves.toBeUndefined();
  });

  it("reports malformed JSON as InvalidJsonError", async () => {
    await expect(readJsonBody(fakeRequest(["{not json"]), 100)).rejects.toBeInstanceOf(InvalidJsonError);
  });
});

describe("SessionStore", () => {
  let clock = 0;
  const now = () => clock;

  beforeEach(() => {
    clock = 1_000;
  });

  it("refuses reservations at the cap, counting pending initializations", () => {
    const store = new SessionStore<string>(2, 60_000, jest.fn(), now);

    expect(store.reserve()).toBe(true);
    store.commit("a", "A");
    expect(store.reserve()).toBe(true);
    expect(store.reserve()).toBe(false);
  });

  it("frees a slot when a reservation is released", () => {
    const store = new SessionStore<string>(1, 60_000, jest.fn(), now);

    expect(store.reserve()).toBe(true);
    store.release();
    expect(store.reserve()).toBe(true);
  });

  it("frees a slot when a session is deleted", () => {
    const store = new SessionStore<string>(1, 60_000, jest.fn(), now);
    store.reserve();
    store.commit("a", "A");

    store.delete("a");

    expect(store.get("a")).toBeUndefined();
    expect(store.reserve()).toBe(true);
  });

  it("evicts sessions idle for the timeout and keeps recently used ones", () => {
    const onEvict = jest.fn();
    const store = new SessionStore<string>(10, 1_000, onEvict, now);
    store.reserve();
    store.commit("idle", "IDLE");
    store.reserve();
    store.commit("busy", "BUSY");

    clock += 600;
    store.get("busy");
    clock += 500;
    store.sweep();

    expect(onEvict).toHaveBeenCalledWith("IDLE");
    expect(onEvict).not.toHaveBeenCalledWith("BUSY");
    expect(store.get("idle")).toBeUndefined();
    expect(store.get("busy")).toBe("BUSY");
  });

  it("sweeps idle sessions before refusing a reservation at the cap", () => {
    const onEvict = jest.fn();
    const store = new SessionStore<string>(1, 1_000, onEvict, now);
    store.reserve();
    store.commit("old", "OLD");

    clock += 1_000;

    expect(store.reserve()).toBe(true);
    expect(onEvict).toHaveBeenCalledWith("OLD");
  });
});

describe("positiveIntFromEnv", () => {
  afterEach(() => {
    delete process.env.TEST_LIMIT;
  });

  it("uses the fallback when unset", () => {
    expect(positiveIntFromEnv("TEST_LIMIT", 7)).toBe(7);
  });

  it.each(["0", "-1", "1.5", "abc", "10kb"])("rejects %p", (value) => {
    process.env.TEST_LIMIT = value;

    expect(() => positiveIntFromEnv("TEST_LIMIT", 7)).toThrow(/positive integer/);
  });
});
