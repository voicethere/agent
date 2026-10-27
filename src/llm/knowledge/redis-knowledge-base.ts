import { createHash, randomUUID } from "node:crypto";

import { DEFAULT_EMBEDDING_DIMS } from "../bounded-embedder.js";
import {
  chunkMarkdown,
  DEFAULT_CHUNK_OVERLAP_WORDS,
  DEFAULT_CHUNK_WORDS,
  type MarkdownChunk,
} from "./chunk-markdown.js";
import {
  KnowledgeIndexError,
  type IndexReport,
  type KnowledgeBase,
  type KnowledgeHit,
  type KnowledgeRedisClient,
  type RedisKnowledgeBaseOptions,
} from "./types.js";

/*
 * Redis commands follow the Redis Query Engine docs:
 * - FT.CREATE ... VECTOR HNSW: https://redis.io/docs/latest/commands/ft.create/
 * - KNN query, PARAMS, DIALECT 2: https://redis.io/docs/latest/develop/ai/search-and-query/vectors/
 * - FT.INFO (indexing, percent_indexed): https://redis.io/docs/latest/commands/ft.info/
 * - FT.DROPINDEX ... DD: https://redis.io/docs/latest/commands/ft.dropindex/
 */

const NAMESPACE = /^[A-Za-z0-9._-]+$/;
const OVERHEAD_BYTES_PER_CHUNK = 512;
const WRITE_BATCH = 200;
const COMPARE_AND_DELETE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const COMPARE_AND_RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const COMPARE = `if redis.call('get', KEYS[1]) == ARGV[1] then return 1 else return 0 end`;
const COMPARE_AND_SET_READY = `if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('set', KEYS[2], '1') return 1 else return 0 end`;
const GC_SCAN_MAX_KEYS = 20_000;
const GC_SCAN_MAX_MS = 2_000;
const LIVE_TTL_MS = 90_000;
const HEARTBEAT_MS = 30_000;
const GC_MIN_INTERVAL_MS = 600_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function toFloat32Buffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

function isUnknownIndex(err: unknown): boolean {
  return (
    err instanceof Error &&
    /unknown index|index not found|SEARCH_INDEX_NOT_FOUND/i.test(err.message)
  );
}

function pairs(flat: unknown): Map<string, unknown> {
  const map = new Map<string, unknown>();
  if (!Array.isArray(flat)) return map;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    map.set(String(flat[i]), flat[i + 1]);
  }
  return map;
}

function infoNumber(info: string, field: string): number {
  const m = new RegExp(`^${field}:(\\d+)`, "m").exec(info);
  return m ? Number(m[1]) : 0;
}

export function createRedisKnowledgeBase(
  opts: RedisKnowledgeBaseOptions,
): KnowledgeBase {
  const namespace = opts.namespace ?? "default";
  if (!NAMESPACE.test(namespace)) {
    throw new RangeError("namespace must match [A-Za-z0-9._-]+");
  }
  if (!opts.redis && !opts.redisUrl) {
    throw new RangeError("createRedisKnowledgeBase needs redis or redisUrl");
  }
  const dims = opts.dims ?? DEFAULT_EMBEDDING_DIMS;
  const chunkOpts = {
    maxWords: opts.maxWords ?? DEFAULT_CHUNK_WORDS,
    overlapWords: opts.overlapWords ?? DEFAULT_CHUNK_OVERLAP_WORDS,
  };
  const lim = {
    redisTimeoutMs: opts.limits?.redisTimeoutMs ?? 5_000,
    buildTimeoutMs: opts.limits?.buildTimeoutMs ?? 30_000,
    indexReadyTimeoutMs: opts.limits?.indexReadyTimeoutMs ?? 30_000,
    lockTtlMs: opts.limits?.lockTtlMs ?? 120_000,
    waitForOtherMs: opts.limits?.waitForOtherMs ?? 120_000,
    pollMs: opts.limits?.pollMs ?? 250,
    memoryFraction: opts.limits?.memoryFraction ?? 0.8,
  };
  const log = (message: string, fields: Record<string, unknown> = {}) =>
    opts.logger?.info(message, { namespace, ...fields });

  const chunks: MarkdownChunk[] = [...opts.documents]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .flatMap((doc) => chunkMarkdown(doc, chunkOpts));
  const contentHash = createHash("sha256")
    .update(
      JSON.stringify({
        model: opts.model,
        dims,
        chunker: chunkOpts,
        chunks: chunks.map((c) => [c.id, c.title, c.text]),
      }),
    )
    .digest("hex");
  const h12 = contentHash.slice(0, 12);

  const lockKeyOf = (hash12: string) => `kb:${namespace}:lock:${hash12}`;
  const readyKey = (hash12: string) => `kb:${namespace}:ready:${hash12}`;
  const liveKey = (hash12: string) => `kb:${namespace}:live:${hash12}`;
  const lockKey = lockKeyOf(h12);
  const indexName = (hash12: string) => `kb:${namespace}:idx:${hash12}`;
  const chunkPrefix = (hash12: string) => `kb:${namespace}:v:${hash12}:chunk:`;
  const workerId = randomUUID();

  let client: KnowledgeRedisClient | undefined = opts.redis;
  let owned: KnowledgeRedisClient | undefined;

  async function redis(): Promise<KnowledgeRedisClient> {
    if (client) return client;
    type RedisCtor = new (url: string, options: object) => KnowledgeRedisClient;
    let mod: { Redis?: RedisCtor; default?: RedisCtor };
    try {
      mod = (await import("ioredis")) as unknown as typeof mod;
    } catch {
      throw new KnowledgeIndexError(
        "KB_REDIS_ERROR",
        "ioredis is not installed; add it or pass a redis client",
      );
    }
    const Ctor = mod.Redis ?? mod.default;
    if (!Ctor) {
      throw new KnowledgeIndexError(
        "KB_REDIS_ERROR",
        "ioredis has no Redis export",
      );
    }
    const created = new Ctor(opts.redisUrl!, {
      connectTimeout: lim.redisTimeoutMs,
      maxRetriesPerRequest: 1,
    });
    created.on?.("error", () => undefined);
    client = created;
    owned = created;
    return created;
  }

  async function bounded<T>(
    label: string,
    ms: number,
    work: () => Promise<T>,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new KnowledgeIndexError(
              "KB_REDIS_ERROR",
              `redis ${label} timed out after ${ms} ms`,
            ),
          ),
        ms,
      );
    });
    try {
      return await Promise.race([work(), timeout]);
    } catch (err) {
      if (err instanceof KnowledgeIndexError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (/^OOM\b/.test(message)) {
        throw new KnowledgeIndexError(
          "KB_MEMORY_LIMIT",
          `redis rejected a write: out of memory (${label})`,
        );
      }
      throw new KnowledgeIndexError(
        "KB_REDIS_ERROR",
        `redis ${label} failed: ${message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  const cmd = async (
    ms: number,
    command: string,
    ...args: Array<string | number | Buffer>
  ): Promise<unknown> => {
    const r = await redis();
    return bounded(command, ms, () => r.call(command, ...args));
  };
  const quick = (command: string, ...args: Array<string | number | Buffer>) =>
    cmd(lim.redisTimeoutMs, command, ...args);

  async function indexExists(hash12: string): Promise<boolean> {
    try {
      await quick("FT.INFO", indexName(hash12));
      return true;
    } catch (err) {
      if (isUnknownIndex(err)) return false;
      throw err;
    }
  }

  async function isFresh(): Promise<boolean> {
    const ready = await quick("GET", readyKey(h12));
    return ready !== null && (await indexExists(h12));
  }

  async function dropIndex(hash12: string): Promise<void> {
    try {
      await cmd(lim.buildTimeoutMs, "FT.DROPINDEX", indexName(hash12), "DD");
    } catch (err) {
      if (!isUnknownIndex(err)) throw err;
    }
  }

  async function deleteKeys(hash12: string): Promise<void> {
    let cursor = "0";
    do {
      const reply = (await quick(
        "SCAN",
        cursor,
        "MATCH",
        `${chunkPrefix(hash12)}*`,
        "COUNT",
        500,
      )) as [string, string[]];
      cursor = reply[0];
      if (reply[1].length > 0) await quick("UNLINK", ...reply[1]);
    } while (cursor !== "0");
  }

  async function discard(hash12: string): Promise<void> {
    try {
      await dropIndex(hash12);
    } catch {
      /* best effort; the next build for this hash cleans up again */
    }
    try {
      await deleteKeys(hash12);
    } catch {
      /* best effort */
    }
  }

  async function checkMemory(): Promise<void> {
    const info = String(await quick("INFO", "memory"));
    const used = infoNumber(info, "used_memory");
    const max = opts.limits?.maxmemoryBytes ?? infoNumber(info, "maxmemory");
    if (max <= 0) return;
    const textBytes = chunks.reduce(
      (n, c) => n + Buffer.byteLength(c.text) + Buffer.byteLength(c.title),
      0,
    );
    const estimate =
      chunks.length * (dims * 4 * 2 + OVERHEAD_BYTES_PER_CHUNK) + textBytes;
    if (used + estimate > lim.memoryFraction * max) {
      throw new KnowledgeIndexError(
        "KB_MEMORY_LIMIT",
        `knowledge base needs about ${estimate} bytes for ${chunks.length} chunks; Redis uses ${used} of ${max} bytes (limit ${Math.round(lim.memoryFraction * 100)}%)`,
      );
    }
  }

  async function waitIndexed(hash12: string): Promise<void> {
    const deadline = Date.now() + lim.indexReadyTimeoutMs;
    for (;;) {
      const info = pairs(await quick("FT.INFO", indexName(hash12)));
      const indexing = Number(info.get("indexing") ?? 0);
      const percent = Number(info.get("percent_indexed") ?? 1);
      if (indexing === 0 && percent >= 1) return;
      if (Date.now() >= deadline) {
        throw new KnowledgeIndexError(
          "KB_INDEX_TIMEOUT",
          `index ${indexName(hash12)} not ready after ${lim.indexReadyTimeoutMs} ms`,
        );
      }
      await sleep(50);
    }
  }

  const ownsLock = async (): Promise<boolean> =>
    (await quick("EVAL", COMPARE, 1, lockKey, workerId)) === 1;

  async function build(): Promise<void> {
    // Residue of an earlier attempt at this version must not count against
    // the memory budget.
    await quick("DEL", readyKey(h12));
    await discard(h12);
    await checkMemory();
    const vectors: number[][] = [];
    if (chunks.length > 0) {
      const result = await opts.embedder.embed({
        model: opts.model,
        inputs: chunks.map((c) => `${c.title}\n${c.text}`),
        dimensions: dims,
      });
      if (
        result.vectors.length !== chunks.length ||
        result.vectors.some((v) => v.length !== dims)
      ) {
        throw new KnowledgeIndexError(
          "KB_REDIS_ERROR",
          "embedder returned the wrong number or size of vectors",
        );
      }
      vectors.push(...result.vectors);
    }
    const r = await redis();
    for (let from = 0; from < chunks.length; from += WRITE_BATCH) {
      const pipe = r.pipeline();
      chunks.slice(from, from + WRITE_BATCH).forEach((c, i) => {
        pipe.call(
          "HSET",
          `${chunkPrefix(h12)}${from + i}`,
          "text",
          c.text,
          "title",
          c.title,
          "source",
          c.source,
          "embedding",
          toFloat32Buffer(vectors[from + i]!),
        );
      });
      const replies = await bounded("write", lim.buildTimeoutMs, () =>
        pipe.exec(),
      );
      const failed = replies?.find(([err]) => err);
      if (failed?.[0]) {
        const message = failed[0].message;
        throw new KnowledgeIndexError(
          /^OOM\b/.test(message) ? "KB_MEMORY_LIMIT" : "KB_REDIS_ERROR",
          `redis write failed: ${message}`,
        );
      }
    }
    await cmd(
      lim.buildTimeoutMs,
      "FT.CREATE",
      indexName(h12),
      "ON",
      "HASH",
      "PREFIX",
      1,
      chunkPrefix(h12),
      "SCHEMA",
      "embedding",
      "VECTOR",
      "HNSW",
      6,
      "TYPE",
      "FLOAT32",
      "DIM",
      dims,
      "DISTANCE_METRIC",
      "COSINE",
      "title",
      "TEXT",
      "source",
      "TAG",
    );
    await waitIndexed(h12);
    // Still the lock holder and mark ready, in one step.
    const marked = await quick(
      "EVAL",
      COMPARE_AND_SET_READY,
      2,
      lockKey,
      readyKey(h12),
      workerId,
    );
    if (marked !== 1) {
      throw new KnowledgeIndexError(
        "KB_INDEX_TIMEOUT",
        "lost the knowledge index lock",
      );
    }
  }

  let lastGc = 0;
  /** Chunk keys of versions that never got an index (builder died before FT.CREATE). */
  async function gcAbandonedKeys(
    indexNames: Set<string>,
    dropped: string[],
  ): Promise<void> {
    const versions = new Set<string>();
    const prefix = `kb:${namespace}:v:`;
    const started = Date.now();
    let scanned = 0;
    let cursor = "0";
    let truncated = false;
    do {
      const reply = (await quick(
        "SCAN",
        cursor,
        "MATCH",
        `${prefix}*`,
        "COUNT",
        500,
      )) as [string, string[]];
      cursor = reply[0];
      scanned += reply[1].length;
      for (const key of reply[1]) {
        const hash = key.slice(prefix.length).split(":")[0];
        if (hash) versions.add(hash);
      }
      if (
        cursor !== "0" &&
        (scanned >= GC_SCAN_MAX_KEYS || Date.now() - started >= GC_SCAN_MAX_MS)
      ) {
        truncated = true;
        break;
      }
    } while (cursor !== "0");
    if (truncated) log("kb gc scan truncated", { scanned });
    for (const other of versions) {
      if (other === h12 || indexNames.has(indexName(other))) continue;
      const live = Number(await quick("EXISTS", liveKey(other)));
      const locked = Number(await quick("EXISTS", lockKeyOf(other)));
      if (live > 0 || locked > 0) continue;
      await deleteKeys(other);
      await quick("DEL", readyKey(other));
      dropped.push(other);
    }
  }

  /**
   * Drops indexes of other versions whose workers are gone (no live key, no
   * build lock). Returns the dropped version ids.
   */
  async function gc(): Promise<string[]> {
    lastGc = Date.now();
    const dropped: string[] = [];
    try {
      const names = (await quick("FT._LIST")) as string[];
      const prefix = `kb:${namespace}:idx:`;
      for (const name of names) {
        if (!name.startsWith(prefix)) continue;
        const other = name.slice(prefix.length);
        if (other === h12) continue;
        const live = Number(await quick("EXISTS", liveKey(other)));
        const locked = Number(await quick("EXISTS", lockKeyOf(other)));
        if (live > 0 || locked > 0) continue;
        await discard(other);
        await quick("DEL", readyKey(other));
        dropped.push(other);
      }
      await gcAbandonedKeys(new Set(names), dropped);
      if (dropped.length > 0)
        log("kb dropped old versions", { dropped: dropped.length });
    } catch (err) {
      log("kb gc failed", {
        error: err instanceof KnowledgeIndexError ? err.code : "unknown",
      });
    }
    return dropped;
  }
  const maybeGc = async (): Promise<void> => {
    if (Date.now() - lastGc >= GC_MIN_INTERVAL_MS) await gc();
  };

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  async function beat(): Promise<void> {
    try {
      await quick("SET", liveKey(h12), "1", "PX", LIVE_TTL_MS);
    } catch (err) {
      log("kb heartbeat failed", {
        error: err instanceof KnowledgeIndexError ? err.code : "unknown",
      });
    }
  }
  async function startHeartbeat(): Promise<void> {
    if (heartbeat || closed) return;
    heartbeat = setInterval(() => {
      void beat().then(maybeGc);
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    await beat();
  }

  async function ensure(): Promise<IndexReport> {
    const started = Date.now();
    // Live before the build lock is released, so another version's gc never
    // sees this version with neither a lock nor a live key.
    await startHeartbeat();
    const report = (status: IndexReport["status"]): IndexReport => {
      const done = {
        status,
        chunks: chunks.length,
        waitedMs: Date.now() - started,
        contentHash,
      };
      log("kb index ready", {
        status,
        chunks: done.chunks,
        waitedMs: done.waitedMs,
        contentHash: h12,
      });
      return done;
    };
    const finish = async (
      status: IndexReport["status"],
    ): Promise<IndexReport> => {
      await startHeartbeat();
      if (status === "rebuilt") await gc();
      else await maybeGc();
      return report(status);
    };
    if (await isFresh()) return finish("fresh");

    const waitDeadline = started + lim.waitForOtherMs;
    let announced = false;
    for (;;) {
      const got = await quick(
        "SET",
        lockKey,
        workerId,
        "NX",
        "PX",
        lim.lockTtlMs,
      );
      if (got === "OK") {
        const renew = setInterval(
          () => {
            void quick(
              "EVAL",
              COMPARE_AND_RENEW,
              1,
              lockKey,
              workerId,
              lim.lockTtlMs,
            ).catch(() => undefined);
          },
          Math.max(10, Math.floor(lim.lockTtlMs / 3)),
        );
        let status: IndexReport["status"];
        try {
          if (await isFresh()) {
            status = "built-by-other-worker";
          } else {
            await build();
            status = "rebuilt";
          }
        } catch (err) {
          // Only the lock holder may clean up; a builder that lost the lock
          // leaves the partial version to whoever owns it now.
          if (await ownsLock().catch(() => false)) await discard(h12);
          throw err;
        } finally {
          clearInterval(renew);
          await quick("EVAL", COMPARE_AND_DELETE, 1, lockKey, workerId).catch(
            () => undefined,
          );
        }
        return finish(status);
      }
      if (!announced) {
        announced = true;
        log("kb waiting for other worker");
      }
      if (Date.now() >= waitDeadline) {
        throw new KnowledgeIndexError(
          "KB_INDEX_TIMEOUT",
          `another worker did not finish the knowledge index within ${lim.waitForOtherMs} ms`,
        );
      }
      await sleep(lim.pollMs);
      if (await isFresh()) return finish("built-by-other-worker");
    }
  }

  let inflight: Promise<IndexReport> | undefined;
  const ensureIndexed = (): Promise<IndexReport> => {
    inflight ??= ensure().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };

  async function searchOnce(
    vec: Buffer,
    k: number,
  ): Promise<KnowledgeHit[] | "missing"> {
    let reply: unknown;
    try {
      reply = await quick(
        "FT.SEARCH",
        indexName(h12),
        `*=>[KNN ${k} @embedding $vec AS score]`,
        "PARAMS",
        2,
        "vec",
        vec,
        "SORTBY",
        "score",
        "RETURN",
        4,
        "text",
        "title",
        "source",
        "score",
        "DIALECT",
        2,
        "LIMIT",
        0,
        k,
      );
    } catch (err) {
      if (isUnknownIndex(err)) return "missing";
      throw err;
    }
    const rows = Array.isArray(reply) ? reply.slice(1) : [];
    const hits: KnowledgeHit[] = [];
    for (let i = 0; i + 1 < rows.length; i += 2) {
      const f = pairs(rows[i + 1]);
      hits.push({
        text: String(f.get("text") ?? ""),
        title: String(f.get("title") ?? ""),
        source: String(f.get("source") ?? ""),
        score: 1 - Number(f.get("score") ?? 1),
      });
    }
    return hits;
  }

  return {
    ensureIndexed,
    gc,
    async search(query: string, k = 4): Promise<KnowledgeHit[]> {
      const limit = Math.max(1, Math.floor(k));
      const embedded = await opts.embedder.embed({
        model: opts.model,
        inputs: [query],
        dimensions: dims,
      });
      const vec = toFloat32Buffer(embedded.vectors[0] ?? []);
      let hits = await searchOnce(vec, limit);
      if (hits === "missing") {
        const report = await ensureIndexed();
        log("kb reindexed at query time", {
          status: report.status,
          chunks: report.chunks,
          waitedMs: report.waitedMs,
        });
        hits = await searchOnce(vec, limit);
        if (hits === "missing") {
          throw new KnowledgeIndexError(
            "KB_REDIS_ERROR",
            "knowledge index is missing after re-indexing",
          );
        }
      }
      return hits;
    },
    async close(): Promise<void> {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      if (!owned) return;
      const c = owned;
      owned = undefined;
      client = undefined;
      try {
        await Promise.race([c.quit(), sleep(lim.redisTimeoutMs)]);
      } finally {
        c.disconnect();
      }
    },
  };
}
