import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(HERE, "../../templates");

/** Returns a message for the first token without a vowel, else null. */
function unpronounceable(phrase: string): string | null {
  for (const token of phrase.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) ?? []) {
    if (!/[aeiouyAEIOUY]/.test(token)) {
      return `"${phrase}" has token "${token}" without a vowel`;
    }
  }
  return null;
}

function phrasesOf(cfg: Record<string, unknown>): string[] {
  const out: string[] = [];
  const fillers = (cfg.fillers ?? {}) as Record<string, unknown>;
  for (const v of Object.values(fillers)) {
    const phrases = (v as { phrases?: unknown } | null)?.phrases;
    if (Array.isArray(phrases)) out.push(...phrases.map(String));
  }
  const tools = (cfg.tools ?? {}) as { filler?: unknown };
  if (typeof tools.filler === "string") out.push(tools.filler);
  const legacy = cfg.filler;
  if (typeof legacy === "string") out.push(legacy);
  else if (legacy && typeof legacy === "object") {
    const p = (legacy as { phrases?: unknown }).phrases;
    if (Array.isArray(p)) out.push(...p.map(String));
  }
  return out;
}

const templates = readdirSync(TEMPLATES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({
    name: d.name,
    file: join(TEMPLATES, d.name, "voicethere.llm.json"),
  }))
  .filter((t) => {
    try {
      readFileSync(t.file);
      return true;
    } catch {
      return false;
    }
  });

describe("filler phrases are pronounceable", () => {
  it("scans at least 2 templates", () => {
    expect(templates.length).toBeGreaterThanOrEqual(2);
  });

  it("every template filler phrase passes", () => {
    const bad: string[] = [];
    for (const t of templates) {
      const cfg = JSON.parse(readFileSync(t.file, "utf8")) as Record<
        string,
        unknown
      >;
      for (const phrase of phrasesOf(cfg)) {
        const msg = unpronounceable(phrase);
        if (msg) bad.push(`${t.name}: ${msg}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("flags spelled-out sounds", () => {
    expect(unpronounceable("Mm-hm.")).toContain('token "Mm"');
    expect(unpronounceable("Hmm.")).toContain('token "Hmm"');
    expect(unpronounceable("Shh.")).toContain('token "Shh"');
    expect(unpronounceable("Okay.")).toBeNull();
  });
});
