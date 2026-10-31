import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildIndex } from "../src/build-index.ts";
import { readMarkdownDir } from "../src/corpus.ts";
import { type Embedder, createEmbedder } from "../src/embed.ts";
import {
  DocsRagStartError,
  type DocsRagHandle,
  MAX_SEARCH_CHARS,
  formatHits,
  startDocsRagServer,
  toolNames,
} from "../src/server.ts";

const here = resolve(import.meta.dirname, "..");
const modelDir = process.env.DOCS_RAG_MODEL_DIR ?? join(here, ".models");

const textOf = (r: unknown): string =>
  ((r as { content?: Array<{ text?: string }> }).content ?? [])
    .map((c) => c.text ?? "")
    .join("\n");

async function connect(url: string, token?: string): Promise<Client> {
  const client = new Client({ name: "t", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: token
        ? { headers: { Authorization: `Bearer ${token}` } }
        : undefined,
    }),
  );
  return client;
}

describe("formatHits", () => {
  const hit = (n: number, len: number) => ({
    docId: `d${n}`,
    title: `Title ${n}`,
    url: `https://x.test/${n}`,
    text: "a".repeat(len),
  });
  it("numbers hits, shows title, url and id", () => {
    const out = formatHits([hit(1, 10), hit(2, 10)]);
    expect(out).toBe(
      "1. Title 1 — https://x.test/1 (id: d1)\naaaaaaaaaa\n\n2. Title 2 — https://x.test/2 (id: d2)\naaaaaaaaaa",
    );
  });
  it("never exceeds the cap, even for huge passages", () => {
    expect(
      formatHits([hit(1, 3000), hit(2, 3000), hit(3, 3000)]).length,
    ).toBeLessThanOrEqual(MAX_SEARCH_CHARS);
    expect(formatHits([hit(1, 99_999)]).length).toBeLessThanOrEqual(
      MAX_SEARCH_CHARS,
    );
  });
  it("omits the url separator when a page has no url", () => {
    expect(formatHits([{ ...hit(1, 3), url: "" }])).toBe(
      "1. Title 1 (id: d1)\naaa",
    );
  });
  it("says so when there is nothing", () => {
    expect(formatHits([])).toBe("No results.");
  });
});

describe("toolNames", () => {
  it("applies a valid prefix and rejects others", () => {
    expect(toolNames()).toEqual({ search: "search_docs", doc: "get_doc" });
    expect(toolNames("acme_")).toEqual({
      search: "acme_search_docs",
      doc: "acme_get_doc",
    });
    expect(() => toolNames("a b")).toThrow(DocsRagStartError);
    expect(() => toolNames("x".repeat(33))).toThrow(DocsRagStartError);
  });
});

describe("node entry point (type stripping, as in the image)", () => {
  it("exits 1 with a named error when the index is missing", () => {
    const r = spawnSync("node", [join(here, "src", "server.ts")], {
      env: {
        ...process.env,
        INDEX_DIR: mkdtempSync(join(tmpdir(), "rag-none-")),
        PORT: "0",
      },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("DOCS_RAG_INDEX_MISSING");
  });
});

describe("server with the real model", () => {
  let embedder: Embedder;
  let indexDir: string;
  let gate: Promise<void>;
  let release: () => void;
  let slowMs = 0;
  const logs: Array<Record<string, unknown>> = [];
  const handles: DocsRagHandle[] = [];

  // Wraps the real embedder: queries wait for `gate`, then `slowMs`.
  const gated = (): Embedder => ({
    model: embedder.model,
    dims: embedder.dims,
    embedPassages: (t) => embedder.embedPassages(t),
    embedQuery: async (t) => {
      await gate;
      if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
      return embedder.embedQuery(t);
    },
  });
  const start = async (extra: Record<string, unknown> = {}) => {
    const h = await startDocsRagServer({
      indexDir,
      embedder: gated(),
      log: (l) => logs.push(l),
      ...extra,
    });
    handles.push(h);
    return h;
  };

  beforeAll(async () => {
    embedder = await createEmbedder(modelDir);
    indexDir = mkdtempSync(join(tmpdir(), "rag-srv-"));
    await buildIndex({
      docs: readMarkdownDir(join(here, "fixtures", "docs")),
      embedder,
      outDir: indexDir,
    });
    gate = Promise.resolve();
    release = () => {};
  });
  afterAll(async () => {
    await Promise.all(handles.map((h) => h.stop()));
  });

  it("healthz is 503 until the model and databases are loaded, then 200", async () => {
    gate = new Promise<void>((r) => {
      release = r;
    });
    const h = await start();
    const base = h.url.replace("/mcp", "");
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
    release();
    await h.ready;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it("refuses to start without an index manifest, with a named error", async () => {
    const empty = mkdtempSync(join(tmpdir(), "rag-empty-"));
    const err = await startDocsRagServer({ indexDir: empty, embedder }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(DocsRagStartError);
    expect((err as DocsRagStartError).code).toBe("DOCS_RAG_INDEX_MISSING");
  });

  it("lists both tools and answers searches and get_doc", async () => {
    gate = Promise.resolve();
    const h = await start({ description: "Search the Acme docs" });
    await h.ready;
    const c = await connect(h.url);
    const tools = (await c.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["get_doc", "search_docs"]);
    expect(tools.find((t) => t.name === "search_docs")!.description).toBe(
      "Search the Acme docs",
    );
    const r = await c.callTool({
      name: "search_docs",
      arguments: { query: "How much is the Starter plan per month?", k: 3 },
    });
    const text = textOf(r);
    expect(text.length).toBeLessThanOrEqual(MAX_SEARCH_CHARS);
    expect(text).toMatch(/^1\. .* \(id: pricing\.md\)/);
    const doc = textOf(
      await c.callTool({ name: "get_doc", arguments: { id: "pricing.md" } }),
    );
    expect(doc).toContain("19 dollars");
    expect(doc.length).toBeLessThanOrEqual(12000);
    expect(
      textOf(
        await c.callTool({ name: "get_doc", arguments: { id: "nope.md" } }),
      ),
    ).toBe("not found");
    await c.close();
  });

  it("k outside 1..10 and an empty or 501-char query are rejected", async () => {
    const h = await start();
    await h.ready;
    const c = await connect(h.url);
    for (const args of [
      { query: "x", k: 0 },
      { query: "x", k: 11 },
      { query: "" },
      { query: "q".repeat(501) },
    ]) {
      const r = (await c
        .callTool({ name: "search_docs", arguments: args })
        .catch((e) => ({ isError: true, e }))) as { isError?: boolean };
      expect(r.isError, JSON.stringify(args).slice(0, 40)).toBe(true);
    }
    await c.close();
  });

  it("tool prefix renames both tools", async () => {
    const h = await start({ toolPrefix: "acme_" });
    await h.ready;
    const c = await connect(h.url);
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "acme_get_doc",
      "acme_search_docs",
    ]);
    await c.close();
  });

  it("MCP_TOKEN: missing or wrong bearer is 401, right bearer works", async () => {
    const h = await start({ token: "s3cret" });
    await h.ready;
    const post = (auth?: string) =>
      fetch(h.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(auth ? { authorization: auth } : {}),
        },
        body: "{}",
      });
    expect((await post()).status).toBe(401);
    expect((await post("Bearer wrong")).status).toBe(401);
    const c = await connect(h.url, "s3cret");
    expect((await c.listTools()).tools).toHaveLength(2);
    await c.close();
  });

  it("a search past the handler bound fails with a tool error, not a hang", async () => {
    slowMs = 400;
    try {
      const h = await start({ handlerTimeoutMs: 50 });
      await h.ready.catch(() => undefined);
      const c = await connect(h.url);
      const r = (await c.callTool({
        name: "search_docs",
        arguments: { query: "pricing" },
      })) as { isError?: boolean };
      expect(r.isError).toBe(true);
      await c.close();
    } finally {
      slowMs = 0;
    }
  });

  it("logs carry the tool, k, hit count and duration, never the query or passage text", async () => {
    logs.length = 0;
    const h = await start();
    await h.ready;
    const c = await connect(h.url);
    const query = "unique-canary-query starter plan";
    const r = await c.callTool({
      name: "search_docs",
      arguments: { query, k: 2 },
    });
    await c.close();
    const line = logs.find((l) => l.event === "tool")!;
    expect(line).toMatchObject({ tool: "search_docs", k: 2, ok: true });
    expect(typeof line.hits).toBe("number");
    expect(typeof line.ms).toBe("number");
    const all = JSON.stringify(logs);
    expect(all).not.toContain("canary");
    expect(all).not.toContain(textOf(r).slice(0, 40));
  });
});
