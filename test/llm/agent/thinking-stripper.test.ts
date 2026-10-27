import { describe, expect, it } from "vitest";

import {
  ThinkingStripper,
  stripThinking,
} from "../../../src/llm/agent/thinking-stripper.js";
import { SentenceSplitter } from "../../../src/llm/agent/sentence-splitter.js";

function run(deltas: string[]): { out: string; stripped: number } {
  const s = new ThinkingStripper();
  let out = "";
  for (const d of deltas) out += s.push(d);
  out += s.end();
  return { out, stripped: s.strippedChars };
}

describe("ThinkingStripper", () => {
  it("removes a whole block in one delta", () => {
    const r = run(["<thinking>secret plan</thinking>Hello."]);
    expect(r.out).toBe("Hello.");
    expect(r.stripped).toBe("<thinking>secret plan</thinking>".length);
  });

  it("removes a tag split over three deltas", () => {
    const r = run(["<thi", "nking>x</thin", "king> Hi"]);
    expect(r.out).toBe(" Hi");
  });

  it("drops an unclosed block to the end of the stream", () => {
    const r = run(["Sure. <thinking>I should not", " say this"]);
    expect(r.out).toBe("Sure. ");
    expect(r.stripped).toBeGreaterThan(0);
  });

  it("keeps text before and after", () => {
    expect(run(["Before <thinking>x</thinking>after."]).out).toBe(
      "Before after.",
    );
  });

  it("handles uppercase and nested blocks", () => {
    expect(run(["A<THINKING>a<thinking>b</thinking>c</Thinking>B"]).out).toBe(
      "AB",
    );
  });

  it("drops a stray closing tag", () => {
    expect(run(["a</thinking>b"]).out).toBe("ab");
  });

  it("keeps a lone '<' that is not a tag", () => {
    expect(run(["1 <", " 2"]).out).toBe("1 < 2");
    expect(run(["x <thin"]).out).toBe("x <thin");
  });

  it("never lets the sentence splitter see a fragment of a tag", () => {
    const stripper = new ThinkingStripper();
    const splitter = new SentenceSplitter();
    const sentences: string[] = [];
    for (const d of [
      "<thi",
      "nking>Ok. Not",
      " this.</think",
      "ing>Hi. Th",
      "ere.",
    ]) {
      sentences.push(...splitter.push(stripper.push(d)));
    }
    sentences.push(...splitter.push(stripper.end()), ...splitter.end());
    expect(sentences).toEqual(["Hi.", "There."]);
    expect(sentences.join(" ")).not.toMatch(/<|thinking/i);
  });

  it("stripThinking cleans a complete text", () => {
    expect(stripThinking("<thinking>x</thinking> Sorry.")).toEqual({
      text: " Sorry.",
      strippedChars: "<thinking>x</thinking>".length,
    });
  });
});
