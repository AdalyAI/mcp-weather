import type { IncomingMessage } from "node:http";

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Request body exceeds ${limit} bytes`);
  }
}

export class InvalidJsonError extends Error {
  constructor() {
    super("Request body is not valid JSON");
  }
}

// Reads and parses a JSON request body, refusing to buffer more than maxBytes.
// A declared Content-Length over the limit is rejected before any body is read.
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyTooLargeError(maxBytes);
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(buffer);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  if (!rawBody) {
    return undefined;
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    throw new InvalidJsonError();
  }
}

type Entry<T> = { value: T; lastSeen: number };

// Holds streamable-HTTP sessions with a hard cap and idle expiry. Slots are
// reserved before a session initializes so concurrent initializations can't
// overshoot the cap.
export class SessionStore<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private pending = 0;

  constructor(
    private readonly maxSessions: number,
    private readonly idleTimeoutMs: number,
    private readonly onEvict: (value: T) => void,
    private readonly now: () => number = Date.now
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(id: string): T | undefined {
    const entry = this.entries.get(id);
    if (!entry) {
      return undefined;
    }
    entry.lastSeen = this.now();
    return entry.value;
  }

  reserve(): boolean {
    this.sweep();
    if (this.entries.size + this.pending >= this.maxSessions) {
      return false;
    }
    this.pending += 1;
    return true;
  }

  release(): void {
    this.pending = Math.max(0, this.pending - 1);
  }

  commit(id: string, value: T): void {
    this.release();
    this.entries.set(id, { value, lastSeen: this.now() });
  }

  delete(id: string): void {
    this.entries.delete(id);
  }

  sweep(): void {
    const cutoff = this.now() - this.idleTimeoutMs;
    for (const [id, entry] of this.entries) {
      if (entry.lastSeen <= cutoff) {
        this.entries.delete(id);
        this.onEvict(entry.value);
      }
    }
  }

  evictAll(): void {
    for (const [id, entry] of this.entries) {
      this.entries.delete(id);
      this.onEvict(entry.value);
    }
  }
}

export function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || String(value) !== raw.trim()) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}
