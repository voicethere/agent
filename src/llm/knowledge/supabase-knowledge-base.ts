import { createHash } from "node:crypto";

import { DEFAULT_EMBEDDING_DIMS } from "../bounded-embedder.js";
import type { LlmEmbedder } from "../types.js";
import {
  KnowledgeIndexError,
  type IndexReport,
  type KnowledgeBase,
  type KnowledgeHit,
  type KnowledgeLogger,
  type KnowledgeRedisClient,
} from "./types.js";

/**
 * Searches the customer's own Supabase project through a Postgres function.
 *
 * `match_documents` is a customer-created function adapted from the Supabase
 * guides (semantic-search: a `documents` table with id/content;
 * vector-columns: similarity = 1 - (embedding <=> query_embedding)):
 * https://supabase.com/docs/guides/ai/semantic-search
 * https://supabase.com/docs/guides/ai/vector-columns
 * VoiceThere requires the returns clause
 * `table (id bigint, content text, similarity float)` shown in the README.
 *
 * Supabase serves Postgres functions over REST (PostgREST RPC):
 * POST {SUPABASE_URL}/rest/v1/rpc/{function}, headers `apikey` and
 * `Authorization: Bearer <key>`, JSON body = the named arguments
 * `query_embedding`, `match_threshold`, `match_count`.
 * https://supabase.com/docs/guides/api
 * Only the three columns of the returns clause are read.
 */

const RPC_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const NAMESPACE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const DEFAULT_TIMEOUT_MS = 8_000;
const CACHE_TIMEOUT_MS = 2_000;

export interface SupabaseKnowledgeCacheOptions {
  /** Open (and own) a connection with ioredis. */
  redisUrl?: string;
  /** An ioredis client you manage. */
  redis?: KnowledgeRedisClient;
  /** Entry lifetime. Default 600. The TTL lets `volatile-lru` evict entries. */
  ttlSeconds?: number;
  /** Key scope. Default "default". */
  namespace?: string;
}

export interface SupabaseKnowledgeBaseOptions {
  /** Project URL, `https://<ref>.supabase.co`. */
  url: string;
  /** API key sent as `apikey` and bearer token. */
  key: string;
  /** Postgres function name. Default "match_documents". */
  rpc?: string;
  /** Default 0.5. */
  matchThreshold?: number;
  embedder: LlmEmbedder;
  model: string;
  /** Default `DEFAULT_EMBEDDING_DIMS` (512). Must match the table's vector size. */
  dims?: number;
  cache?: SupabaseKnowledgeCacheOptions;
  fetch?: typeof fetch;
  /** Per request. Default 8000. */
  timeoutMs?: number;
  /** Tests only: allow http://127.0.0.1 and http://localhost. */
  allowInsecureLocal?: boolean;
  logger?: KnowledgeLogger;
}

interface RpcRow {
  id?: unknown;
  content?: unknown;
  similarity?: unknown;
}

function fail(message: string): KnowledgeIndexError {
  return new KnowledgeIndexError("KB_SUPABASE_ERROR", message);
}

function checkUrl(raw: string, allowLocal: boolean): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw fail("supabase url is not a valid URL");
  }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (
    u.protocol !== "https:" &&
    !(allowLocal && local && u.protocol === "http:")
  ) {
    throw fail("supabase url must use https");
  }
  let end = raw.length;
  while (end > 0 && raw[end - 1] === "/") end--;
  return raw.slice(0, end);
}

function withTimeout<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("cache timeout")), ms);
  });
  return Promise.race([work, t]).finally(() => clearTimeout(timer));
}

export function createSupabaseKnowledgeBase(
  opts: SupabaseKnowledgeBaseOptions,
): KnowledgeBase {
  const rpc = opts.rpc ?? "match_documents";
  if (!RPC_NAME_RE.test(rpc)) {
    throw fail("supabase rpc name must match [a-z_][a-z0-9_]{0,62}");
  }
  const base = checkUrl(opts.url, opts.allowInsecureLocal === true);
  if (!opts.key) throw fail("supabase key is empty");
  const urlHash = createHash("sha256").update(base).digest("hex");
  const threshold = opts.matchThreshold ?? 0.5;
  const dims = opts.dims ?? DEFAULT_EMBEDDING_DIMS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetch ?? fetch;
  const cacheNs = opts.cache?.namespace ?? "default";
  if (opts.cache && !NAMESPACE_RE.test(cacheNs)) {
    throw fail("cache namespace must match [A-Za-z0-9._-]{1,64}");
  }
  const ttl = opts.cache?.ttlSeconds ?? 600;
  const log = opts.logger?.info.bind(opts.logger) ?? (() => {});

  let client: KnowledgeRedisClient | undefined = opts.cache?.redis;
  let owned: KnowledgeRedisClient | undefined;
  let cacheBroken = false;

  async function cacheClient(): Promise<KnowledgeRedisClient | undefined> {
    if (!opts.cache || cacheBroken) return undefined;
    if (client) return client;
    if (!opts.cache.redisUrl) return undefined;
    try {
      type Ctor = new (url: string, options: object) => KnowledgeRedisClient;
      const mod = (await import("ioredis")) as unknown as {
        Redis?: Ctor;
        default?: Ctor;
      };
      const C = mod.Redis ?? mod.default;
      if (!C) return undefined;
      const created = new C(opts.cache.redisUrl, {
        connectTimeout: CACHE_TIMEOUT_MS,
        maxRetriesPerRequest: 1,
      });
      created.on?.("error", () => undefined);
      client = created;
      owned = created;
      return created;
    } catch {
      cacheBroken = true;
      return undefined;
    }
  }

  function cacheKey(query: string, k: number): string {
    const digest = createHash("sha256")
      .update([urlHash, opts.model, dims, rpc, threshold, k, query].join("|"))
      .digest("hex");
    return `kb:${cacheNs}:cache:${digest}`;
  }

  async function cacheGet(key: string): Promise<KnowledgeHit[] | undefined> {
    try {
      const c = await cacheClient();
      if (!c) return undefined;
      const raw = await withTimeout(CACHE_TIMEOUT_MS, c.call("GET", key));
      if (typeof raw !== "string") return undefined;
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as KnowledgeHit[]) : undefined;
    } catch {
      log("kb cache read failed");
      return undefined;
    }
  }

  async function cacheSet(key: string, hits: KnowledgeHit[]): Promise<void> {
    try {
      const c = await cacheClient();
      if (!c) return;
      await withTimeout(
        CACHE_TIMEOUT_MS,
        c.call("SET", key, JSON.stringify(hits), "EX", ttl),
      );
    } catch {
      log("kb cache write failed");
    }
  }

  async function callRpc(embedding: number[], k: number): Promise<RpcRow[]> {
    const url = `${base}/rest/v1/rpc/${rpc}`;
    const body = JSON.stringify({
      query_embedding: embedding,
      match_threshold: threshold,
      match_count: k,
    });
    let lastStatus = "network error";
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: {
            apikey: opts.key,
            Authorization: `Bearer ${opts.key}`,
            "Content-Type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        lastStatus = "network error or timeout";
        continue;
      }
      if (res.status >= 500) {
        lastStatus = String(res.status);
        continue;
      }
      if (!res.ok) throw fail(`supabase rpc ${rpc} ${res.status}`);
      try {
        const json = (await res.json()) as unknown;
        return Array.isArray(json) ? (json as RpcRow[]) : [];
      } catch {
        throw fail(`supabase rpc ${rpc} returned an unreadable body`);
      }
    }
    throw fail(`supabase rpc ${rpc} ${lastStatus}`);
  }

  return {
    async ensureIndexed(): Promise<IndexReport> {
      return { status: "fresh", chunks: 0, waitedMs: 0, contentHash: "" };
    },
    async gc(): Promise<string[]> {
      return [];
    },
    async search(query: string, k = 4): Promise<KnowledgeHit[]> {
      const key = cacheKey(query, k);
      const cached = await cacheGet(key);
      if (cached) return cached;
      const started = Date.now();
      const res = await opts.embedder.embed({
        model: opts.model,
        inputs: [query],
        dimensions: dims,
      });
      const vector = res.vectors[0];
      if (!vector) throw fail("embedder returned no vector");
      const rows = await callRpc(vector, k);
      const hits: KnowledgeHit[] = rows.map((r) => ({
        text: typeof r.content === "string" ? r.content : "",
        title: String(r.id ?? ""),
        source: "supabase",
        score: typeof r.similarity === "number" ? r.similarity : 0,
      }));
      log("kb supabase search", {
        hits: hits.length,
        waitedMs: Date.now() - started,
      });
      await cacheSet(key, hits);
      return hits;
    },
    async close(): Promise<void> {
      if (!owned) return;
      const c = owned;
      owned = undefined;
      client = undefined;
      try {
        await withTimeout(CACHE_TIMEOUT_MS, c.quit());
      } catch {
        c.disconnect();
      }
    },
  };
}
