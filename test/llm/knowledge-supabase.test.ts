import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createSupabaseKnowledgeBase,
  KnowledgeIndexError,
  type LlmEmbedder,
} from "../../src/llm/index.js";
import { openTestRedis } from "../helpers/test-redis.js";

const KEY = "sb-secret-key-sentinel";
const QUERY_SENTINEL = "zebrafishquerysentinel";

interface Seen {
  method?: string;
  path?: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

function counting(): LlmEmbedder & { calls: number } {
  const self = {
    id: "openai" as const,
    calls: 0,
    async embed(req: { inputs: string[]; dimensions?: number }) {
      self.calls++;
      const dims = req.dimensions ?? 4;
      return {
        vectors: req.inputs.map(() => new Array<number>(dims).fill(0.5)),
        model: "fake",
        dims,
      };
    },
  };
  return self;
}

let server: Server;
let base: string;
let seen: Seen[] = [];
let plan: Array<{ status: number; body?: unknown; hang?: boolean }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString() || "{}"),
      });
      const step = plan.shift() ?? { status: 200, body: [] };
      if (step.hang) return;
      res.writeHead(step.status, { "content-type": "application/json" });
      res.end(JSON.stringify(step.body ?? []));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
afterEach(() => {
  seen = [];
  plan = [];
});

function make(over: Record<string, unknown> = {}) {
  const embedder = counting();
  const kb = createSupabaseKnowledgeBase({
    url: base,
    key: KEY,
    embedder,
    model: "text-embedding-3-small",
    dims: 4,
    allowInsecureLocal: true,
    ...over,
  });
  return { kb, embedder };
}

describe("createSupabaseKnowledgeBase", () => {
  it("posts the documented RPC request and maps id/content/similarity", async () => {
    plan = [
      {
        status: 200,
        body: [
          { id: 7, content: "Plans start at ten dollars.", similarity: 0.91 },
          { id: 9, content: "Invoices are monthly.", similarity: 0.62 },
        ],
      },
    ];
    const { kb } = make();
    const hits = await kb.search("pricing", 2);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].path).toBe("/rest/v1/rpc/match_documents");
    expect(seen[0].headers.apikey).toBe(KEY);
    expect(seen[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0].body).toEqual({
      query_embedding: [0.5, 0.5, 0.5, 0.5],
      match_threshold: 0.5,
      match_count: 2,
    });
    expect(hits).toEqual([
      {
        text: "Plans start at ten dollars.",
        title: "7",
        source: "supabase",
        score: 0.91,
      },
      {
        text: "Invoices are monthly.",
        title: "9",
        source: "supabase",
        score: 0.62,
      },
    ]);
  });

  it("retries once on a 500, then succeeds (2 calls)", async () => {
    plan = [
      { status: 500 },
      { status: 200, body: [{ id: 1, content: "ok", similarity: 0.9 }] },
    ];
    const { kb } = make();
    const hits = await kb.search("q");
    expect(seen).toHaveLength(2);
    expect(hits).toHaveLength(1);
  });

  it("a 401 fails with the status only, no key, body or query in the message", async () => {
    plan = [{ status: 401, body: { message: `bad key ${KEY}` } }];
    const { kb } = make();
    const err = await kb.search(QUERY_SENTINEL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KnowledgeIndexError);
    expect((err as KnowledgeIndexError).code).toBe("KB_SUPABASE_ERROR");
    const message = (err as Error).message;
    expect(message).toBe("supabase rpc match_documents 401");
    expect(message).not.toContain(KEY);
    expect(message).not.toContain(QUERY_SENTINEL);
    expect(seen).toHaveLength(1);
  });

  it("a hung server fails after the bound", async () => {
    plan = [
      { status: 200, hang: true },
      { status: 200, hang: true },
    ];
    const { kb } = make({ timeoutMs: 100 });
    const started = Date.now();
    await expect(kb.search("q")).rejects.toMatchObject({
      code: "KB_SUPABASE_ERROR",
    });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("rejects a bad rpc name before any request", () => {
    expect(() => make({ rpc: "match_documents/../admin" })).toThrow(/rpc name/);
    expect(() => make({ rpc: "Match-Docs" })).toThrow(/rpc name/);
    expect(seen).toHaveLength(0);
  });

  it("rejects non-https urls unless local and allowed", () => {
    expect(() => make({ url: "http://example.com" })).toThrow(/https/);
    expect(() =>
      make({ url: "http://127.0.0.1:1", allowInsecureLocal: false }),
    ).toThrow(/https/);
    expect(() =>
      make({ url: "https://abc.supabase.co", allowInsecureLocal: false }),
    ).not.toThrow();
  });

  it("ensureIndexed reports fresh with 0 chunks and gc returns nothing", async () => {
    const { kb } = make();
    expect(await kb.ensureIndexed()).toMatchObject({
      status: "fresh",
      chunks: 0,
    });
    expect(await kb.gc()).toEqual([]);
  });
});

const harness = await openTestRedis();
const cacheUrl = harness ? new URL("/0", harness.url).toString() : "";
const redisClient = harness
  ? new (await import("ioredis")).Redis(cacheUrl, { maxRetriesPerRequest: 1 })
  : undefined;

afterAll(async () => {
  const keys = (await redisClient?.keys("kb:supa-test*:cache:*")) ?? [];
  if (keys.length > 0) await redisClient?.del(...keys);
  redisClient?.disconnect();
  await harness?.close();
});

describe.skipIf(!harness)("supabase knowledge cache (real Redis)", () => {
  it("an identical second search hits the cache: no embed, no RPC, key has a TTL", async () => {
    plan = [
      { status: 200, body: [{ id: 1, content: "cached", similarity: 0.8 }] },
    ];
    const namespace = `supa-test-${process.pid}`;
    const { kb, embedder } = make({
      cache: { redisUrl: cacheUrl, ttlSeconds: 600, namespace },
    });
    const first = await kb.search("cache me", 3);
    const second = await kb.search("cache me", 3);
    expect(second).toEqual(first);
    expect(embedder.calls).toBe(1);
    expect(seen).toHaveLength(1);
    const keys = await redisClient!.keys(`kb:${namespace}:cache:*`);
    expect(keys).toHaveLength(1);
    const ttl = await redisClient!.ttl(keys[0]!);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);
    await kb.close();
  });

  it("search still works when Redis is down", async () => {
    plan = [
      { status: 200, body: [{ id: 2, content: "live", similarity: 0.7 }] },
    ];
    const { kb } = make({
      cache: { redisUrl: "redis://127.0.0.1:1/0", namespace: "supa-test-down" },
    });
    const hits = await kb.search("anything");
    expect(hits[0]?.text).toBe("live");
    await kb.close();
  });
});
