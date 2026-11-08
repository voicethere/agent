import { createHash, randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildAgentBundle } from "../src/build-bundle.js";
import { validateLlmAgentConfig } from "../src/llm/agent/config.js";
import { listTemplates } from "../src/templates/index.js";
import {
  createRedisKnowledgeBase,
  searchKnowledgeTool,
  type LlmEmbedder,
} from "../src/llm/index.js";
import { openTestRedis } from "./helpers/test-redis.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const templatesDir = join(root, "templates");
const templateDir = join(templatesDir, "llm-language-tutor");

function readConfig() {
  return JSON.parse(
    readFileSync(join(templateDir, "voicethere.llm.json"), "utf8"),
  );
}

describe("llm-language-tutor template", () => {
  it("is a creatable product template and ships every listed file", () => {
    const template = listTemplates({ kind: "product" }).find(
      (t) => t.id === "llm-language-tutor",
    );
    expect(template).toBeDefined();
    expect(template?.seedOnCreate).toBe(true);
    expect(template?.entry).toBe("llm-language-tutor/agent.ts");
    expect(template?.sourceFiles).toContain(
      "llm-language-tutor/knowledge/lessons.md",
    );
    for (const f of template?.sourceFiles ?? []) {
      expect(existsSync(join(templatesDir, f)), f).toBe(true);
    }
  });

  it("config validates with Redis knowledge on and openrouter embeddings", () => {
    const config = readConfig();
    const result = validateLlmAgentConfig(config);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(config.knowledge.store).toBe("redis");
    expect(config.knowledge.embeddings.provider).toBe("openrouter");
    expect(config.knowledge.embeddings.model).toBe(
      "openai/text-embedding-3-small",
    );
    expect(config.knowledge.embeddings.dimensions).toBeUndefined();
    expect(config.knowledge.redis.namespace).toBe("tutor");
  });

  it("bundles with the prompt, greeting and lessons", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voicethere-tutor-bundle-"));
    const outfile = join(dir, "agent.js");
    try {
      await buildAgentBundle({
        cwd: root,
        entry: "templates/llm-language-tutor/agent.ts",
        outfile,
      });
      const source = readFileSync(outfile, "utf8");
      expect(source).toContain("I'm your English practice partner");
      expect(source).toContain("English conversation tutor");
      expect(source).toContain("Break the ice");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

const harness = await openTestRedis();
let queryEngine = false;
if (harness) {
  try {
    await harness.redis.call("FT._LIST");
    queryEngine = true;
  } catch {
    queryEngine = false;
  }
}
// The Query Engine only creates indexes in db 0.
const kbUrl = harness ? new URL("/0", harness.url).toString() : "";

describe.skipIf(!queryEngine)(
  "llm-language-tutor template knowledge (real Redis 8)",
  () => {
    it("search_knowledge for 'break the ice' returns the small talk lesson", async () => {
      const lessons = readFileSync(
        join(templateDir, "knowledge", "lessons.md"),
        "utf8",
      );
      const dims = 512;
      const embedder: LlmEmbedder = {
        id: "openrouter",
        async embed(req) {
          const d = req.dimensions ?? dims;
          const vectors = req.inputs.map((text) => {
            const v = new Array<number>(d).fill(0);
            for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
              const h = createHash("sha1").update(w).digest().readUInt32BE(0);
              v[h % d]! += 1;
            }
            const norm = Math.hypot(...v) || 1;
            return v.map((x) => x / norm);
          });
          return { vectors, model: "fake", dims: d };
        },
      };
      const namespace = `tpl${randomUUID().replaceAll("-", "")}`;
      const base = createRedisKnowledgeBase({
        redisUrl: kbUrl,
        namespace,
        documents: [{ id: "lessons", title: "Lessons", text: lessons }],
        embedder,
        model: "fake",
        dims,
        limits: { pollMs: 10 },
      });
      const cleaner = new Redis(kbUrl, { maxRetriesPerRequest: 1 });
      try {
        expect((await base.ensureIndexed()).chunks).toBeGreaterThan(1);
        const tool = searchKnowledgeTool(base, {
          topK: readConfig().knowledge.topK,
        });
        const out = await tool.handler(
          { query: "what does break the ice mean" },
          { signal: new AbortController().signal } as never,
        );
        expect(out).toContain("Small talk at work");
        expect(out).toContain(
          "start a conversation with people who don't know",
        );
      } finally {
        await base.close();
        const names = (await cleaner.call("FT._LIST")) as string[];
        for (const n of names.filter((x) => x.startsWith(`kb:${namespace}:`))) {
          await cleaner.call("FT.DROPINDEX", n, "DD");
        }
        const keys = await cleaner.keys(`kb:${namespace}:*`);
        if (keys.length > 0) await cleaner.del(...keys);
        cleaner.disconnect();
        await harness?.close();
      }
    }, 30_000);
  },
);
