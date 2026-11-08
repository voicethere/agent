#!/usr/bin/env node
/**
 * Memory cost of the Redis knowledge base (createRedisKnowledgeBase).
 *
 * Needs a Redis 8 started like Project Redis:
 *   docker run --rm -p 16380:6379 redis:8.10.3-alpine \
 *     redis-server --maxmemory 256mb --maxmemory-policy volatile-lru
 * and AGENT_TEST_REDIS_URL=redis://127.0.0.1:16380/0 (the Query Engine only
 * creates indexes in db 0). Run `npm run build` first; this reads dist/.
 *
 * It indexes synthetic chunks of about 300 words with a seeded fake embedder
 * (random unit vectors), reads INFO memory used_memory before and after
 * ensureIndexed(), runs FLUSHDB between runs, and prints a table.
 * It calls FLUSHDB: use a throwaway Redis.
 */
import { Redis } from "ioredis";

import { createRedisKnowledgeBase } from "../dist/llm/index.js";

const url = process.env.AGENT_TEST_REDIS_URL;
if (!url) {
  console.error("Set AGENT_TEST_REDIS_URL (see the header of this script).");
  process.exit(2);
}

const BUDGET_BYTES = Math.floor(256 * 1024 * 1024 * 0.8);
const WORDS_PER_CHUNK = 300;
const COUNTS = [1000, 5000];
const DIMS = [512, 1536];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(42);
const vocab = Array.from({ length: 4000 }, (_, i) => `w${i.toString(36)}x`);

function chunkText(i) {
  const words = [];
  for (let k = 0; k < WORDS_PER_CHUNK; k++) {
    words.push(vocab[Math.floor(rand() * vocab.length)]);
  }
  return `## Chunk ${i}\n\n${words.join(" ")}`;
}

function makeEmbedder(dims) {
  const r = mulberry32(7);
  return {
    id: "openai",
    async embed(req) {
      const vectors = req.inputs.map(() => {
        const v = Array.from({ length: dims }, () => r() * 2 - 1);
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      });
      return { vectors, model: "fake", dims };
    },
  };
}

async function usedMemory(redis) {
  const info = await redis.info("memory");
  const m = /^used_memory:(\d+)/m.exec(info);
  if (!m) throw new Error("used_memory missing from INFO memory");
  return Number(m[1]);
}

const redis = new Redis(url, { maxRetriesPerRequest: 1 });
const rows = [];
try {
  await redis.call("FT._LIST");
  const version = /^redis_version:(\S+)/m.exec(await redis.info("server"))?.[1];
  console.log(`redis_version=${version}`);
  for (const dims of DIMS) {
    for (const count of COUNTS) {
      await redis.flushdb();
      const documents = Array.from({ length: count }, (_, i) => ({
        id: `d${i}`,
        title: `Doc ${i}`,
        text: chunkText(i),
      }));
      const before = await usedMemory(redis);
      const base = createRedisKnowledgeBase({
        redisUrl: url,
        namespace: "measure",
        documents,
        embedder: makeEmbedder(dims),
        model: "fake",
        dims,
        limits: {
          pollMs: 50,
          buildTimeoutMs: 300_000,
          indexReadyTimeoutMs: 120_000,
          redisTimeoutMs: 60_000,
        },
      });
      try {
        const report = await base.ensureIndexed();
        const after = await usedMemory(redis);
        const chunks = report.chunks;
        const bytesPerChunk = Math.round((after - before) / chunks);
        rows.push({
          dims,
          chunks,
          bytesPerChunk,
          projected: Math.floor(BUDGET_BYTES / bytesPerChunk),
        });
      } finally {
        await base.close();
      }
    }
  }
  await redis.flushdb();
} finally {
  redis.disconnect();
}

console.log(
  "| dims | chunks | bytes/chunk | chunks in 205 MB (80 % of 256 MB) |",
);
console.log(
  "| ---- | ------ | ----------- | --------------------------------- |",
);
for (const r of rows) {
  console.log(
    `| ${r.dims} | ${r.chunks} | ${r.bytesPerChunk} | ${r.projected} |`,
  );
}
