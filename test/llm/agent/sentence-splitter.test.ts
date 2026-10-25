import { describe, expect, it } from "vitest";

import { SentenceSplitter } from "../../../src/llm/agent/sentence-splitter.js";

describe("SentenceSplitter", () => {
  it("splits on sentence ends", () => {
    const s = new SentenceSplitter();
    expect(s.push("Hello there. How are")).toEqual(["Hello there."]);
    expect(s.push(" you? Fine! Ok")).toEqual(["How are you?", "Fine!"]);
    expect(s.push("…\nNext")).toEqual(["Ok…"]);
    expect(s.end()).toEqual(["Next"]);
  });

  it("keeps abbreviations and decimals together", () => {
    const s = new SentenceSplitter();
    const out = [
      ...s.push("Dr. Smith paid 3.5 dollars, e.g. for tea, etc. today. "),
      ...s.push("See No. 5 and vs. that. Done. "),
      ...s.end(),
    ];
    expect(out).toEqual([
      "Dr. Smith paid 3.5 dollars, e.g. for tea, etc. today.",
      "See No. 5 and vs. that.",
      "Done.",
    ]);
  });

  it("splits after No. when no number follows", () => {
    const s = new SentenceSplitter();
    expect([...s.push("I said no. Then left. "), ...s.end()]).toEqual([
      "I said no.",
      "Then left.",
    ]);
  });

  it("breaks long text at a space before 200 chars", () => {
    const s = new SentenceSplitter();
    const text = Array.from({ length: 60 }, () => "word").join(" ");
    const out = s.push(text);
    expect(out).toHaveLength(1);
    expect(out[0].length).toBeLessThanOrEqual(200);
    expect(text.startsWith(out[0])).toBe(true);
    expect(`${out[0]} ${s.end()[0]}`).toBe(text);
  });

  it("end flushes the rest", () => {
    const s = new SentenceSplitter();
    expect(s.push("No boundary here")).toEqual([]);
    expect(s.end()).toEqual(["No boundary here"]);
    expect(s.end()).toEqual([]);
  });
});
