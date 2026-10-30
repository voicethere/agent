import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Returns "phrase: token" for the first token without a vowel, else null. */
function unpronounceable(phrase: string): string | null {
  for (const token of phrase.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) ?? []) {
    if (!/[aeiouyAEIOUY]/.test(token)) {
      return `"${phrase}" has token "${token}" without a vowel`;
    }
  }
  return null;
}

function phrasesOf(fillers: Record<string, { phrases?: string[] }>): string[] {
  return Object.values(fillers).flatMap((f) => f.phrases ?? []);
}

describe("filler phrases are pronounceable", () => {
  it("the llm-agent template passes", () => {
    const cfg = JSON.parse(
      readFileSync(
        join(HERE, "../../templates/llm-agent/voicethere.llm.json"),
        "utf8",
      ),
    ) as { fillers: Record<string, { phrases?: string[] }> };
    const phrases = phrasesOf(cfg.fillers);
    expect(phrases.length).toBeGreaterThan(0);
    const bad = phrases.map(unpronounceable).filter(Boolean);
    expect(bad).toEqual([]);
  });

  it("flags spelled-out sounds", () => {
    expect(unpronounceable("Mm-hm.")).toContain('token "Mm"');
    expect(unpronounceable("Hmm.")).toContain('token "Hmm"');
    expect(unpronounceable("Shh.")).toContain('token "Shh"');
    expect(unpronounceable("Okay.")).toBeNull();
  });
});
