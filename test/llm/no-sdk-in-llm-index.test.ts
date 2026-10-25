import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SDKS = {
  openai: "node_modules/openai/",
  anthropic: "node_modules/@anthropic-ai/sdk/",
  gemini: "node_modules/@google/genai/",
} as const;

async function inputs(entry: string): Promise<string[]> {
  const result = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  return Object.keys(result.metafile.inputs);
}

const has = (list: string[], needle: string) =>
  list.some((p) => p.includes(needle));

describe("llm entry points carry only their own provider SDK", () => {
  it("src/llm/index.ts bundles no provider SDK", async () => {
    const list = await inputs("src/llm/index.ts");
    for (const needle of Object.values(SDKS)) {
      expect(has(list, needle), needle).toBe(false);
    }
  });

  it.each([
    ["openai", "src/llm/openai.ts"],
    ["anthropic", "src/llm/anthropic.ts"],
    ["gemini", "src/llm/gemini.ts"],
  ] as const)(
    "%s module bundles its SDK and not the others",
    async (name, entry) => {
      const list = await inputs(entry);
      for (const [other, needle] of Object.entries(SDKS)) {
        expect(has(list, needle), other).toBe(other === name);
      }
    },
    30_000,
  );
});
