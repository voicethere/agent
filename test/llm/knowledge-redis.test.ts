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

  it("changed content rebuilds and swaps the index", async () => {
    const namespace = ns();
    const e = fakeEmbedder();
    await kb(namespace, e).ensureIndexed();
    const edited = DOCS.map((d) =>
      d.id === "deploy.md"
        ? {
            ...d,
            text: "# Deploy\n\nPublish with the ship command and rollback with undo.",
          }
        : d,
    );
    const next = kb(namespace, e, { documents: edited });
    expect((await next.ensureIndexed()).status).toBe("rebuilt");
    const lists = (await kbRedis!.call("FT._LIST")) as string[];
    expect(
      lists.filter((n) => n.startsWith(`kb:${namespace}:idx:`)),
    ).toHaveLength(1);
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
      .poll(() => waiting.includes("kb waiting for other worker"))
      .toBe(true);
    release();

    expect((await first).status).toBe("rebuilt");
    expect((await second).status).toBe("built-by-other-worker");
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(0);
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
    expect(await kbRedis!.keys(`kb:${namespace}:*`)).toEqual([]);
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
