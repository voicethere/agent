import { describe, expect, it } from "vitest";
import { searchConfig } from "../src/config.ts";
import {
  type Hit,
  type Index,
  diversify,
  ftsQuery,
  rrf,
  searchHybrid,
} from "../src/search.ts";

describe("ftsQuery", () => {
  it("quotes every token so FTS5 syntax is inert", () => {
    expect(ftsQuery('foo "bar" NEAR(x y) -x col:y z* (p)')).toBe(
      '"foo" OR """bar""" OR "NEAR(x" OR "y)" OR "-x" OR "col:y" OR "z*" OR "(p)"',
    );
  });
  it("empty and quote-only input gives an empty query", () => {
    expect(ftsQuery("   ")).toBe("");
    expect(ftsQuery('""')).toBe("");
  });
  it("drops stop words, keeps 'up' (set up is meaningful)", () => {
    expect(ftsQuery("how do I set up webhooks")).toBe(
      '"set" OR "up" OR "webhooks"',
    );
    expect(ftsQuery("What is the price of the Team plan?")).toBe(
      '"price" OR "Team" OR "plan?"',
    );
  });
  it("an all-stop-word query is empty", () => {
    expect(ftsQuery("how do I?")).toBe("");
    expect(ftsQuery("What are the")).toBe("");
  });
});

describe("rrf", () => {
  it("orders by summed weighted reciprocal rank and dedupes within a list", () => {
    const out = rrf([
      { ids: [1, 2, 3], weight: 1 },
      { ids: [3, 1, 4], weight: 1 },
    ]);
    expect(out.map(([id]) => id)).toEqual([1, 3, 2, 4]);
    expect(out[0]![1]).toBeCloseTo(1 / 61 + 1 / 62, 10);
    const dup = rrf([{ ids: [7, 7, 8], weight: 1 }]);
    expect(dup.map(([id]) => id)).toEqual([7, 8]);
    expect(dup[0]![1]).toBeCloseTo(1 / 61, 10);
  });
  it("with text weight 0.5 a vector-only rank-1 hit beats a text-only rank-1 hit", () => {
    const out = rrf([
      { ids: [10, 11], weight: 1.0 },
      { ids: [20, 21], weight: 0.5 },
    ]);
    expect(out[0]![0]).toBe(10);
    expect(out[1]![0]).toBe(11); // vector rank 2 (1/62) still beats text rank 1 (0.5/61)
    expect(out[2]![0]).toBe(20);
  });
});

describe("searchConfig", () => {
  it("defaults, env, then explicit overrides", () => {
    expect(searchConfig({}, {})).toEqual({
      vectorWeight: 1,
      textWeight: 0.5,
      maxPerDoc: 2,
    });
    const env = { DOCS_RAG_TEXT_WEIGHT: "0.3", DOCS_RAG_MAX_PER_DOC: "3" };
    expect(searchConfig({}, env).textWeight).toBe(0.3);
    expect(searchConfig({ textWeight: "0.1" }, env).textWeight).toBe(0.1);
    expect(searchConfig({}, env).maxPerDoc).toBe(3);
    expect(() => searchConfig({ textWeight: "x" }, {})).toThrow(RangeError);
    expect(() => searchConfig({ maxPerDoc: "0" }, {})).toThrow(RangeError);
  });
});

function fakeIndex(docs: string[]): Index {
  const chunk = (id: number): Omit<Hit, "score"> => ({
    chunkId: id,
    docId: docs[id - 1]!,
    title: "",
    url: "",
    text: "",
  });
  return {
    hybridIds: async () =>
      docs.map((_, i): [number, number] => [i + 1, 1 / (i + 1)]),
    chunk,
  } as unknown as Index;
}

describe("per-doc diversity", () => {
  it("5 chunks from A then 1 from B, k=3, max 2 per doc → A, A, B", async () => {
    const index = fakeIndex(["A", "A", "A", "A", "A", "B"]);
    const hits = await searchHybrid(index, "q", 3, searchConfig({}, {}));
    expect(hits.map((h) => h.docId)).toEqual(["A", "A", "B"]);
    expect(hits.map((h) => h.chunkId)).toEqual([1, 2, 6]);
  });
  it("fills from the skipped chunks when there are not enough other docs", () => {
    const docOf = (id: number) => (id <= 4 ? "A" : "B");
    expect(diversify([1, 2, 3, 4], docOf, 3, 2)).toEqual([1, 2, 3]);
  });
});
