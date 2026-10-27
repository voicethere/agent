import { describe, expect, it } from "vitest";

import {
  KnowledgeIndexError,
  searchKnowledgeTool,
  type KnowledgeBase,
  type KnowledgeHit,
} from "../../src/llm/index.js";

function fakeKb(search: KnowledgeBase["search"]): KnowledgeBase {
  return {
    ensureIndexed: async () => ({
      status: "fresh",
      chunks: 0,
      waitedMs: 0,
      contentHash: "",
    }),
    gc: async () => [],
    search,
    close: async () => undefined,
  };
}

const ctx = { signal: new AbortController().signal } as never;

describe("searchKnowledgeTool", () => {
  it("formats numbered hits and cuts at maxChars", async () => {
    const hits: KnowledgeHit[] = [
      { text: "A".repeat(100), title: "Billing", source: "b.md", score: 0.83 },
      { text: "second", title: "Voices", source: "v.md", score: 0.5 },
    ];
    const tool = searchKnowledgeTool(
      fakeKb(async () => hits),
      {
        maxChars: 60,
      },
    );
    expect(tool.name).toBe("search_knowledge");
    const out = await tool.handler({ query: "pricing" }, ctx);
    expect(out.startsWith("[1] Billing (score 0.83)\nAAAA")).toBe(true);
    expect(out).toHaveLength(60);
    const full = await searchKnowledgeTool(fakeKb(async () => hits)).handler(
      { query: "pricing" },
      ctx,
    );
    expect(full).toContain("[2] Voices (score 0.50)\nsecond");
  });

  it("passes k, clamps it and defaults to topK", async () => {
    const ks: number[] = [];
    const tool = searchKnowledgeTool(
      fakeKb(async (_q, k) => {
        ks.push(k ?? -1);
        return [];
      }),
      { topK: 3 },
    );
    await tool.handler({ query: "a" }, ctx);
    await tool.handler({ query: "a", k: 50 }, ctx);
    await tool.handler({ query: "a", k: 2 }, ctx);
    expect(ks).toEqual([3, 10, 2]);
  });

  it("no hits -> 'No matching knowledge found.'", async () => {
    const tool = searchKnowledgeTool(fakeKb(async () => []));
    expect(await tool.handler({ query: "x" }, ctx)).toBe(
      "No matching knowledge found.",
    );
  });

  it("a knowledge error returns the unavailable text and logs the code only", async () => {
    const logs: Array<{ message: string; fields?: Record<string, unknown> }> =
      [];
    const tool = searchKnowledgeTool(
      fakeKb(async () => {
        throw new KnowledgeIndexError(
          "KB_SUPABASE_ERROR",
          "supabase rpc match_documents 401",
        );
      }),
      { log: (message, fields) => logs.push({ message, fields }) },
    );
    expect(await tool.handler({ query: "zebrasentinel" }, ctx)).toBe(
      "Knowledge search is unavailable right now.",
    );
    expect(logs).toEqual([
      {
        message: "knowledge search failed",
        fields: { code: "KB_SUPABASE_ERROR" },
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain("zebrasentinel");
  });

  it("rejects an empty query without calling the store", async () => {
    let called = false;
    const tool = searchKnowledgeTool(
      fakeKb(async () => {
        called = true;
        return [];
      }),
    );
    expect(await tool.handler({ query: "  " }, ctx)).toMatch(/query/);
    expect(called).toBe(false);
  });
});
