import { describe, expect, it } from "vitest";
import { ftsQuery, rrf } from "../src/search.ts";

describe("ftsQuery", () => {
  it("quotes every token so FTS5 syntax is inert", () => {
    expect(ftsQuery('what "is" NEAR(a b) -x col:y a* (p)')).toBe(
      '"what" OR """is""" OR "NEAR(a" OR "b)" OR "-x" OR "col:y" OR "a*" OR "(p)"',
    );
  });
  it("empty and quote-only input gives an empty query", () => {
    expect(ftsQuery("   ")).toBe("");
    expect(ftsQuery('""')).toBe("");
  });
});

describe("rrf", () => {
  it("orders by summed reciprocal rank and dedupes within a list", () => {
    const out = rrf([
      [1, 2, 3],
      [3, 1, 4],
    ]);
    expect(out.map(([id]) => id)).toEqual([1, 3, 2, 4]);
    expect(out[0]![1]).toBeCloseTo(1 / 61 + 1 / 62, 10);
    const dup = rrf([[7, 7, 8]]);
    expect(dup.map(([id]) => id)).toEqual([7, 8]);
    expect(dup[0]![1]).toBeCloseTo(1 / 61, 10);
  });
});
