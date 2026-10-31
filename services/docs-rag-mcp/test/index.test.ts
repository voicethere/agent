import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildIndex } from "../src/build-index.ts";
import { contentHash, readCorpusFile, readMarkdownDir } from "../src/corpus.ts";
import { type Embedder, createEmbedder } from "../src/embed.ts";
import { evaluate, readQuestions } from "../src/eval.ts";
import { openIndex, searchHybrid } from "../src/search.ts";

const here = resolve(import.meta.dirname, "..");
const modelDir = process.env.DOCS_RAG_MODEL_DIR ?? join(here, ".models");
const fixtures = join(here, "fixtures");

describe("inputs", () => {
  it("md directory: id is relative path, title is first heading, url from base", () => {
    const docs = readMarkdownDir(
      join(fixtures, "docs"),
      "https://x.test/docs/",
    );
    const p = docs.find((d) => d.id === "pricing.md")!;
    expect(p.title).toBe("Acme Cloud pricing");
    expect(p.url).toBe("https://x.test/docs/pricing");
    expect(readMarkdownDir(join(fixtures, "docs"))[0]!.url).toBeUndefined();
  });

  it("corpus JSON: documents array, extra keys ignored, bad shape rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "rag-"));
    const f = join(dir, "c.json");
    writeFileSync(
      f,
      JSON.stringify({
        contentHash: "x",
        documents: [{ id: "a", title: "A", url: "https://u/a", text: "hello" }],
      }),
    );
    expect(readCorpusFile(f)).toEqual([
      { id: "a", title: "A", url: "https://u/a", text: "hello" },
    ]);
    writeFileSync(f, JSON.stringify({ documents: [{ id: "a" }] }));
    expect(() => readCorpusFile(f)).toThrow(/string id and text/);
  });

  it("contentHash does not depend on document order", () => {
    const a = { id: "a", title: "A", text: "1" };
    const b = { id: "b", title: "B", text: "2" };
    expect(contentHash([a, b])).toBe(contentHash([b, a]));
  });
});

describe("end to end with the real model", () => {
  let embedder: Embedder;
  let out: string;
  beforeAll(async () => {
    embedder = await createEmbedder(modelDir);
    out = mkdtempSync(join(tmpdir(), "rag-idx-"));
    mkdirSync(out, { recursive: true });
    await buildIndex({
      docs: readMarkdownDir(join(fixtures, "docs")),
      embedder,
      outDir: out,
    });
  });
  afterAll(() => undefined);

  it("manifest records model, dims and chunk count", () => {
    const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(m.model).toBe("Xenova/bge-small-en-v1.5");
    expect(m.dims).toBe(384);
    expect(m.chunks).toBeGreaterThanOrEqual(6);
  });

  it.each([
    ["How much is the Starter plan per month?", "pricing.md"],
    ["How do I check a webhook signature?", "webhooks.md"],
    ["How long do you keep database snapshots?", "backups.md"],
  ])("top-1 doc for %s", async (q, docId) => {
    const index = openIndex(out, embedder);
    const hits = await searchHybrid(index, q, 3);
    index.close();
    expect(hits[0]!.docId).toBe(docId);
  });

  it("user text with FTS syntax does not throw", async () => {
    const index = openIndex(out, embedder);
    const hits = await searchHybrid(index, 'NEAR("a" b) AND -x col:y * (', 3);
    index.close();
    expect(Array.isArray(hits)).toBe(true);
  });

  it("an all-stop-word query: text list empty, hybrid equals vector", async () => {
    const index = openIndex(out, embedder);
    const q = "how do I?";
    expect(index.textIds(q)).toEqual([]);
    const vector = await index.vectorIds(q);
    const hybrid = (await index.hybridIds(q)).map(([id]) => id);
    index.close();
    expect(hybrid).toEqual(vector);
  });

  it("doc() returns the whole page text", () => {
    const index = openIndex(out, embedder);
    expect(index.doc("pricing.md")!.text).toContain("19 dollars");
    index.close();
  });

  it("eval on the sample questions reaches hybrid recall@4 >= 0.9", async () => {
    const index = openIndex(out, embedder);
    const r = await evaluate(
      index,
      readQuestions(join(fixtures, "questions.json")),
    );
    index.close();
    expect(r.hybrid.recallAt4).toBeGreaterThanOrEqual(0.9);
  });
});
