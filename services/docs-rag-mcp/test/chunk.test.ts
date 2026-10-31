import { describe, expect, it } from "vitest";
import { chunkMarkdown as agentChunk } from "../../../src/llm/knowledge/chunk-markdown.ts";
import { chunkMarkdown } from "../src/chunk.ts";

const words = (n: number, p: string) =>
  Array.from({ length: n }, (_, i) => `${p}${i}`).join(" ");

const FIXTURE = [
  "# Guide",
  "intro text",
  "## Setup",
  words(700, "w"),
  "```",
  "# not a heading",
  "```",
  "### Deep",
  "deep body",
  "## Other",
  "other body",
].join("\n");

describe("chunk", () => {
  it("titles are Page › Section path", () => {
    const c = chunkMarkdown({ id: "g.md", title: "Acme", text: FIXTURE });
    const titles = new Set(c.map((x) => x.title));
    expect(titles.has("Acme › Guide")).toBe(true);
    expect(titles.has("Acme › Guide › Setup")).toBe(true);
    expect(titles.has("Acme › Guide › Setup › Deep")).toBe(true);
    expect(titles.has("Acme › Guide › Other")).toBe(true);
    // the heading inside the fence stays text
    expect(c.some((x) => x.text.includes("# not a heading"))).toBe(true);
  });

  it("lockstep: identical output to the agent's chunkMarkdown", () => {
    for (const opts of [{}, { maxWords: 100, overlapWords: 10 }]) {
      const doc = { id: "g.md", title: "Acme", text: FIXTURE };
      expect(chunkMarkdown(doc, opts)).toEqual(agentChunk(doc, opts));
    }
    const noTitle = { id: "x.md", text: "plain words only" };
    expect(chunkMarkdown(noTitle)).toEqual(agentChunk(noTitle));
  });

  it("splits long sections with overlap", () => {
    const c = chunkMarkdown({ id: "a", text: words(700, "w") });
    expect(c.length).toBe(3);
    expect(c[1]!.text.split(" ")[0]).toBe("w250");
  });
});
