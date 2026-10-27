import { describe, expect, it } from "vitest";

import { chunkMarkdown } from "../../src/llm/knowledge/index.js";

const words = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");

describe("chunkMarkdown", () => {
  it("uses the heading path as the title and drops empty sections", () => {
    const chunks = chunkMarkdown({
      id: "guide.md",
      title: "Guide",
      text: [
        "intro text",
        "# Billing",
        "## Plans",
        "Starter costs money.",
        "### Annual",
        "Pay yearly.",
        "## Empty",
        "## Refunds",
        "Ask support.",
      ].join("\n"),
    });
    expect(chunks.map((c) => [c.id, c.title, c.text])).toEqual([
      ["guide.md#0", "Guide", "intro text"],
      ["guide.md#1", "Guide › Billing › Plans", "Starter costs money."],
      ["guide.md#2", "Guide › Billing › Plans › Annual", "Pay yearly."],
      ["guide.md#3", "Guide › Billing › Refunds", "Ask support."],
    ]);
    expect(chunks.every((c) => c.source === "guide.md")).toBe(true);
  });

  it("falls back to the document id when there is no title or heading", () => {
    const [chunk] = chunkMarkdown({ id: "notes.md", text: "just text" });
    expect(chunk?.title).toBe("notes.md");
  });

  it("splits a 700 word section into 3 chunks that overlap by 50 words", () => {
    const chunks = chunkMarkdown({
      id: "long.md",
      text: `# Long\n\n${words(700, "w")}`,
    });
    expect(chunks).toHaveLength(3);
    const parts = chunks.map((c) => c.text.split(" "));
    expect(parts.map((p) => p.length)).toEqual([300, 300, 200]);
    expect(parts[1]!.slice(0, 50)).toEqual(parts[0]!.slice(-50));
    expect(parts[2]!.slice(0, 50)).toEqual(parts[1]!.slice(-50));
    expect(chunks.map((c) => c.id)).toEqual([
      "long.md#0",
      "long.md#1",
      "long.md#2",
    ]);
  });

  it("is stable and ignores headings inside code fences", () => {
    const doc = {
      id: "code.md",
      text: "# A\n\n```\n# not a heading\n```\n\nafter",
    };
    const a = chunkMarkdown(doc);
    expect(a).toEqual(chunkMarkdown(doc));
    expect(a).toHaveLength(1);
    expect(a[0]!.text).toContain("# not a heading");
  });

  it("rejects an overlap that is not smaller than the window", () => {
    expect(() =>
      chunkMarkdown({ id: "x", text: "a" }, { maxWords: 10, overlapWords: 10 }),
    ).toThrow(RangeError);
  });
});
