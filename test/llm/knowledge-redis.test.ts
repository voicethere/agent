import { createHash } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  createRedisKnowledgeBase,
  KnowledgeIndexError,
  type KnowledgeBase,
  type KnowledgeDocument,
  type LlmEmbedder,
} from "../../src/llm/index.js";
import { openTestRedis } from "../helpers/test-redis.js";

const harness = await openTestRedis();

async function hasQueryEngine(): Promise<boolean> {
  if (!harness) return false;
  try {
    await harness.redis.call("FT._LIST");
    return true;
  } catch {
    return false;
  }
}
const supported = await hasQueryEngine();
// The Redis Query Engine only creates indexes in db 0 ("Cannot create index on
// db != 0"), so these tests use db 0 with namespaced keys and clean up only
// their own keys and indexes.
const kbUrl = harness ? new URL("/0", harness.url).toString() : "";
const kbRedis = harness
  ? new (await import("ioredis")).Redis(kbUrl, { maxRetriesPerRequest: 1 })
  : undefined;

const DIMS = 64;

function fakeEmbedder(): LlmEmbedder & {
  calls: number;
  gate?: Promise<void>;
  onEmbed?: () => void;
} {
  const self = {
    id: "openai" as const,
    calls: 0,
    gate: undefined as Promise<void> | undefined,
    onEmbed: undefined as (() => void) | undefined,
    async embed(req: { inputs: string[]; dimensions?: number }) {
      self.calls++;
      self.onEmbed?.();
      await self.gate;
      const dims = req.dimensions ?? DIMS;
      const vectors = req.inputs.map((text) => {
        const v = new Array<number>(dims).fill(0);
        for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
          const h = createHash("sha1").update(word).digest().readUInt32BE(0);
          v[h % dims]! += 1;
        }
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      });
      return { vectors, model: "fake", dims };
    },
  };
  return self;
}

const DOCS: KnowledgeDocument[] = [
  {
    id: "billing.md",
    text: "# Billing\n\nPlans cost money each month. The starter plan includes ten minutes. Invoices are emailed monthly.",
  },
  {
    id: "voices.md",
    text: "# Voices\n\nChoose a text to speech voice for your agent. Pitch speed and volume are settings.",
  },
  {
    id: "deploy.md",
    text: "# Deploy\n\nRun the deploy command to publish the bundle to production.",
  },
];

const EDITED: KnowledgeDocument[] = DOCS.map((d) =>
  d.id === "deploy.md"
    ? {
        ...d,
        text: "# Deploy\n\nPublish with the ship command and rollback with undo.",
      }
    : d,
);

let seq = 0;
const namespaces: string[] = [];
const open: KnowledgeBase[] = [];
const ns = () => {
  const name = `t${process.pid}x${seq++}`;
  namespaces.push(name);
  return name;
};

async function wipe(namespace: string): Promise<void> {
  const r = kbRedis!;
  const names = (await r.call("FT._LIST")) as string[];
  for (const name of names.filter((n) => n.startsWith(`kb:${namespace}:`))) {
    await r.call("FT.DROPINDEX", name, "DD");
  }
  const keys = await r.keys(`kb:${namespace}:*`);
  if (keys.length > 0) await r.del(...keys);
}

function kb(
  namespace: string,
  embedder: LlmEmbedder,
  extra: Partial<Parameters<typeof createRedisKnowledgeBase>[0]> = {},
): KnowledgeBase {
  const base = createRedisKnowledgeBase({
    redisUrl: kbUrl,
    namespace,
    documents: DOCS,
    embedder,
    model: "fake",
    dims: DIMS,
    limits: { pollMs: 10 },
    ...extra,
  });
  open.push(base);
  return base;
}

describe.skipIf(!supported)("createRedisKnowledgeBase (real Redis 8)", () => {
  afterEach(async () => {
    await Promise.all(open.splice(0).map((b) => b.close()));
    for (const name of namespaces.splice(0)) await wipe(name);
  });
  afterAll(async () => {
    kbRedis?.disconnect();
    await harness?.close();
  });

  it("indexes and finds the chunk that answers", async () => {
    const e = fakeEmbedder();
    const base = kb(ns(), e);
    const report = await base.ensureIndexed();
    expect(report.status).toBe("rebuilt");
    expect(report.chunks).toBe(3);
    const hits = await base.search("text to speech voice pitch", 3);
    expect(hits[0]).toMatchObject({ source: "voices.md", title: "Voices" });
    expect(hits[0]!.text).toContain("Choose a text to speech voice");
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("unchanged content is fresh and does not re-embed", async () => {
    const namespace = ns();
    const e = fakeEmbedder();
    await kb(namespace, e).ensureIndexed();
    expect(e.calls).toBe(1);
    const report = await kb(namespace, e).ensureIndexed();
    expect(report.status).toBe("fresh");
    expect(e.calls).toBe(1);
  });

  it("changed content builds its own version next to the old one", async () => {
    const namespace = ns();
    const e = fakeEmbedder();
    const old = kb(namespace, e);
    await old.ensureIndexed();
    const next = kb(namespace, e, { documents: EDITED });
    expect((await next.ensureIndexed()).status).toBe("rebuilt");
    const lists = (await kbRedis!.call("FT._LIST")) as string[];
    expect(
      lists.filter((n) => n.startsWith(`kb:${namespace}:idx:`)),
    ).toHaveLength(2);
    const [top] = await next.search("ship command rollback undo", 1);
    expect(top?.text).toContain("ship command");
  });

  it("two workers, one builds", async () => {
    const namespace = ns();
    let release!: () => void;
    const a = fakeEmbedder();
    a.gate = new Promise<void>((r) => (release = r));
    const b = fakeEmbedder();
    const waiting: string[] = [];
    const embeddingStarted = new Promise<void>((r) => (a.onEmbed = r));

    const first = kb(namespace, a).ensureIndexed();
    await embeddingStarted;
    const second = kb(namespace, b, {
      logger: { info: (m) => void waiting.push(m) },
    }).ensureIndexed();
    await expect
      .poll(() => waiting.includes("kb waiting for other worker"), {
        timeout: 5_000,
        interval: 50,
      })
      .toBe(true);
    release();

    expect((await first).status).toBe("rebuilt");
    expect((await second).status).toBe("built-by-other-worker");
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(0);
  });

  it("search re-indexes when its index was dropped", async () => {
    const namespace = ns();
    const base = kb(namespace, fakeEmbedder());
    const report = await base.ensureIndexed();
    await kbRedis!.call(
      "FT.DROPINDEX",
      `kb:${namespace}:idx:${report.contentHash.slice(0, 12)}`,
    );
    const hits = await base.search("deploy command publish bundle", 1);
    expect(hits[0]?.source).toBe("deploy.md");
  });

  it("ensureIndexed rebuilds when the index is missing but the ready marker remains", async () => {
    const namespace = ns();
    const base = kb(namespace, fakeEmbedder());
    const report = await base.ensureIndexed();
    const h12 = report.contentHash.slice(0, 12);
    await kbRedis!.call("FT.DROPINDEX", `kb:${namespace}:idx:${h12}`);
    expect(await kbRedis!.exists(`kb:${namespace}:ready:${h12}`)).toBe(1);
    expect((await base.ensureIndexed()).status).toBe("rebuilt");
  });

  it("residue from a dead builder is removed", async () => {
    const namespace = ns();
    const base = kb(namespace, fakeEmbedder());
    const h12 = (await base.ensureIndexed()).contentHash.slice(0, 12);
    await kbRedis!.call("FT.DROPINDEX", `kb:${namespace}:idx:${h12}`);
    await kbRedis!.del(`kb:${namespace}:ready:${h12}`);
    const stray = `kb:${namespace}:v:${h12}:chunk:999`;
    await kbRedis!.hset(stray, "text", "stray");
    expect((await base.ensureIndexed()).status).toBe("rebuilt");
    expect(await kbRedis!.exists(stray)).toBe(0);
  });

  it("the lock outlives its TTL during a slow build", async () => {
    const namespace = ns();
    let release!: () => void;
    const a = fakeEmbedder();
    a.gate = new Promise<void>((r) => (release = r));
    const b = fakeEmbedder();
    const embeddingStarted = new Promise<void>((r) => (a.onEmbed = r));
    const limits = { pollMs: 10, lockTtlMs: 200 };

    const first = kb(namespace, a, { limits }).ensureIndexed();
    await embeddingStarted;
    const h12 = (await kbRedis!.keys(`kb:${namespace}:lock:*`))[0]!;
    const startedAt = Date.now();
    await expect
      .poll(
        async () =>
          Date.now() - startedAt >= 600 && (await kbRedis!.pttl(h12)) > 0,
        { timeout: 5_000, interval: 50 },
      )
      .toBe(true);
    const waiting: string[] = [];
    const second = kb(namespace, b, {
      limits,
      logger: { info: (m) => void waiting.push(m) },
    }).ensureIndexed();
    await expect
      .poll(() => waiting.includes("kb waiting for other worker"), {
        timeout: 5_000,
        interval: 50,
      })
      .toBe(true);
    release();

    expect((await first).status).toBe("rebuilt");
    expect((await second).status).toBe("built-by-other-worker");
    expect(b.calls).toBe(0);
  });

  it("a builder that lost its lock does not mark ready or discard", async () => {
    const namespace = ns();
    let release!: () => void;
    const a = fakeEmbedder();
    a.gate = new Promise<void>((r) => (release = r));
    const embeddingStarted = new Promise<void>((r) => (a.onEmbed = r));

    const building = kb(namespace, a).ensureIndexed();
    const outcome = building.catch((x: unknown) => x);
    await embeddingStarted;
    const [lockKeyName] = await kbRedis!.keys(`kb:${namespace}:lock:*`);
    await kbRedis!.set(lockKeyName!, "another-builder");
    release();

    const err = await outcome;
    expect(err).toBeInstanceOf(KnowledgeIndexError);
    expect((err as KnowledgeIndexError).code).toBe("KB_INDEX_TIMEOUT");
    expect(await kbRedis!.keys(`kb:${namespace}:ready:*`)).toEqual([]);
    expect(await kbRedis!.get(lockKeyName!)).toBe("another-builder");
    expect((await kbRedis!.keys(`kb:${namespace}:v:*`)).length).toBeGreaterThan(
      0,
    );
  });

  it("two versions live side by side until the old one stops", async () => {
    const namespace = ns();
    const e = fakeEmbedder();
    const old = kb(namespace, e);
    const oldH = (await old.ensureIndexed()).contentHash.slice(0, 12);
    const next = kb(namespace, e, { documents: EDITED });
    await next.ensureIndexed();

    const [fromOld] = await old.search("deploy command publish bundle", 1);
    const [fromNew] = await next.search("ship command rollback undo", 1);
    expect(fromOld?.text).toContain("Run the deploy command");
    expect(fromNew?.text).toContain("ship command");
    const oldIndex = `kb:${namespace}:idx:${oldH}`;
    expect((await kbRedis!.call("FT._LIST")) as string[]).toContain(oldIndex);
    expect(await next.gc()).toEqual([]);

    await old.close();
    await kbRedis!.del(`kb:${namespace}:live:${oldH}`);
    expect(await next.gc()).toEqual([oldH]);
    expect((await kbRedis!.call("FT._LIST")) as string[]).not.toContain(
      oldIndex,
    );
    expect(await kbRedis!.keys(`kb:${namespace}:v:${oldH}:*`)).toEqual([]);
    expect(await kbRedis!.exists(`kb:${namespace}:ready:${oldH}`)).toBe(0);
  });

  it("the version is marked live before its build lock is released", async () => {
    const namespace = ns();
    let release!: () => void;
    const a = fakeEmbedder();
    a.gate = new Promise<void>((r) => (release = r));
    const embeddingStarted = new Promise<void>((r) => (a.onEmbed = r));

    const building = kb(namespace, a).ensureIndexed();
    await embeddingStarted;
    const [lockName] = await kbRedis!.keys(`kb:${namespace}:lock:*`);
    const h12 = lockName!.split(":").pop();
    expect(await kbRedis!.exists(`kb:${namespace}:live:${h12}`)).toBe(1);
    release();
    expect((await building).status).toBe("rebuilt");
  });

  it("gc removes chunk keys of an abandoned version that never got an index", async () => {
    const namespace = ns();
    const base = kb(namespace, fakeEmbedder());
    await base.ensureIndexed();
    const dead = `kb:${namespace}:v:deadbeef0000:chunk:0`;
    const alive = `kb:${namespace}:v:cafe00000000:chunk:0`;
    await kbRedis!.hset(dead, "text", "x");
    await kbRedis!.hset(alive, "text", "y");
    await kbRedis!.set(`kb:${namespace}:live:cafe00000000`, "1");
    const dropped = await base.gc();
    expect(dropped).toContain("deadbeef0000");
    expect(dropped).not.toContain("cafe00000000");
    expect(await kbRedis!.exists(dead)).toBe(0);
    expect(await kbRedis!.exists(alive)).toBe(1);
  });

  it("an index wiped between queries is rebuilt at query time", async () => {
    const namespace = ns();
    const e = fakeEmbedder();
    const base = kb(namespace, e);
    await base.ensureIndexed();
    await wipe(namespace);
    const hits = await base.search("deploy command publish bundle", 1);
    expect(hits[0]?.source).toBe("deploy.md");
  });

  it("refuses to write past the memory limit and writes nothing", async () => {
    const namespace = ns();
    const e = fakeEmbedder();
    const base = kb(namespace, e, {
      limits: { pollMs: 10, maxmemoryBytes: 1_000 },
    });
    const err = await base.ensureIndexed().catch((x: unknown) => x);
    expect(err).toBeInstanceOf(KnowledgeIndexError);
    expect((err as KnowledgeIndexError).code).toBe("KB_MEMORY_LIMIT");
    expect(e.calls).toBe(0);
    expect(await kbRedis!.keys(`kb:${namespace}:v:*`)).toEqual([]);
    expect(await kbRedis!.keys(`kb:${namespace}:ready:*`)).toEqual([]);
  });

  it("keeps namespaces apart", async () => {
    const e = fakeEmbedder();
    const one = kb(ns(), e, {
      documents: [{ id: "a.md", text: "# A\n\nalpha apples orchards" }],
    });
    const two = kb(ns(), e, {
      documents: [{ id: "b.md", text: "# B\n\nbeta bananas plantations" }],
    });
    await Promise.all([one.ensureIndexed(), two.ensureIndexed()]);
    const fromOne = await one.search("bananas plantations beta", 5);
    const fromTwo = await two.search("apples orchards alpha", 5);
    expect(fromOne.map((h) => h.source)).toEqual(["a.md"]);
    expect(fromTwo.map((h) => h.source)).toEqual(["b.md"]);
  });

  it("logs carry no document or query text", async () => {
    const lines: string[] = [];
    const base = kb(ns(), fakeEmbedder(), {
      documents: [{ id: "z.md", text: "# Z\n\nzebrafish secretword" }],
      logger: { info: (m, f) => void lines.push(JSON.stringify([m, f])) },
    });
    await base.ensureIndexed();
    await base.search("zebrafish secretword", 1);
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join("\n");
    expect(all).not.toContain("zebrafish");
    expect(all).not.toContain("secretword");
  });
});
