import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildAgentBundle } from "../src/build-bundle.js";
import { LLM_PROVIDERS } from "../src/llm/catalog.js";
import { validateLlmAgentConfig } from "../src/llm/agent/config.js";
import { listTemplates } from "../src/templates/index.js";
import {
  createRedisKnowledgeBase,
  searchKnowledgeTool,
  type LlmEmbedder,
} from "../src/llm/index.js";
import { openTestRedis } from "./helpers/test-redis.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = join(root, "templates", "llm-agent");

/** verify-start through the CLI, as users run it. Throws with the output when it fails. */
function verifyStartCli(bundle: string): void {
  const result = spawnSync(
    process.execPath,
    [
      join(root, "dist", "cli.js"),
      "verify-start",
      "--no-build",
      "--bundle",
      bundle,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_OPENAI_API_KEY: "unused",
        AGENT_OPENROUTER_API_KEY: "unused",
      },
    },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain("All checks passed");
}

describe("llm-agent template", () => {
  it("llm-agent template bundles with its json and md imports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voicethere-llm-template-"));
    const outfile = join(dir, "agent.js");
    try {
      await buildAgentBundle({
        cwd: root,
        entry: "templates/llm-agent/agent.ts",
        outfile,
      });
      const source = readFileSync(outfile, "utf8");
      expect(source).toContain("Hi! How can I help you today?");
      expect(source).toContain("Answer in short, spoken sentences.");
      expect(source).toContain("get_current_time");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("template bundle carries only the OpenAI SDK", async () => {
    const { build } = await import("esbuild");
    const result = await build({
      entryPoints: [join(templateDir, "agent.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
      loader: { ".md": "text" },
    });
    const list = Object.keys(result.metafile.inputs);
    expect(list.some((p) => p.includes("node_modules/openai/"))).toBe(true);
    expect(list.some((p) => p.includes("@anthropic-ai/sdk"))).toBe(false);
    expect(list.some((p) => p.includes("@google/genai"))).toBe(false);
    const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
    console.log(`llm-agent template bundle (openai only): ${bytes} bytes`);
  }, 30_000);

  it("template config passes validateLlmAgentConfig", () => {
    const config = JSON.parse(
      readFileSync(join(templateDir, "voicethere.llm.json"), "utf8"),
    );
    const result = validateLlmAgentConfig(config);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it("template model is its provider's catalog default", () => {
    const config = JSON.parse(
      readFileSync(join(templateDir, "voicethere.llm.json"), "utf8"),
    ) as {
      provider: keyof typeof LLM_PROVIDERS;
      model: string;
      apiKeySecret: string;
    };
    const entry = LLM_PROVIDERS[config.provider];
    expect(config.model).toBe(entry.defaultModel);
    expect(config.apiKeySecret).toBe(entry.apiKeyEnv);
  });

  it("registry lists llm-agent as a creatable product template", () => {
    const template = listTemplates({ kind: "product" }).find(
      (t) => t.id === "llm-agent",
    );
    expect(template).toBeDefined();
    expect(template?.seedOnCreate).toBe(true);
    expect(template?.entry).toBe("llm-agent/agent.ts");
    expect(template?.sourceFiles).toContain("llm-agent/voicethere.llm.json");
    expect(template?.sourceFiles).toContain("llm-agent/prompt.md");
  });

  it("a bundle with the LLM agent loads and passes verify-start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voicethere-llm-verify-start-"));
    const outfile = join(dir, "agent.js");
    try {
      await buildAgentBundle({
        cwd: root,
        entry: "test/fixtures/llm-create-require-agent.ts",
        outfile,
      });
      verifyStartCli(outfile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("the llm-agent template itself passes verify-start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voicethere-llm-template-start-"));
    const outfile = join(dir, "agent.js");
    try {
      await buildAgentBundle({
        cwd: root,
        entry: "templates/llm-agent/agent.ts",
        outfile,
      });
      verifyStartCli(outfile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("ships the knowledge sample and a config with knowledge off", () => {
    const template = listTemplates({ kind: "product" }).find(
      (t) => t.id === "llm-agent",
    );
    expect(template?.sourceFiles).toContain("llm-agent/knowledge/about.md");
    expect(
      readFileSync(join(templateDir, "knowledge", "about.md"), "utf8"),
    ).toContain("# About this agent");
    const config = JSON.parse(
      readFileSync(join(templateDir, "voicethere.llm.json"), "utf8"),
    );
    expect(config.knowledge.store).toBe("off");
    expect(config.knowledge.embeddings.provider).toBe("openai");
    expect(validateLlmAgentConfig(config).ok).toBe(true);
    // store "redis" with the shipped embeddings block is also valid.
    const on = {
      ...config,
      knowledge: { ...config.knowledge, store: "redis" },
    };
    expect(validateLlmAgentConfig(on).ok).toBe(true);
  });

  it("the bundle imports knowledge/about.md", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voicethere-llm-kb-bundle-"));
    const outfile = join(dir, "agent.js");
    try {
      await buildAgentBundle({
        cwd: root,
        entry: "templates/llm-agent/agent.ts",
        outfile,
      });
      expect(readFileSync(outfile, "utf8")).toContain("# About this agent");
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
  "llm-agent template knowledge on (real Redis 8)",
  () => {
    it("search_knowledge answers from the shipped about.md", async () => {
      const about = readFileSync(
        join(templateDir, "knowledge", "about.md"),
        "utf8",
      );
      const config = JSON.parse(
        readFileSync(join(templateDir, "voicethere.llm.json"), "utf8"),
      );
      const dims = config.knowledge.embeddings.dimensions as number;
      const embedder: LlmEmbedder = {
        id: "openai",
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
      const namespace = `tpl${process.pid}x${Date.now()}`;
      const base = createRedisKnowledgeBase({
        redisUrl: kbUrl,
        namespace,
        documents: [{ id: "about", title: "About", text: about }],
        embedder,
        model: "fake",
        dims,
        limits: { pollMs: 10 },
      });
      const cleaner = new Redis(kbUrl, { maxRetriesPerRequest: 1 });
      try {
        expect((await base.ensureIndexed()).chunks).toBeGreaterThan(1);
        const tool = searchKnowledgeTool(base, {
          topK: config.knowledge.topK,
        });
        const out = await tool.handler(
          { query: "how do I replace this file" },
          { signal: new AbortController().signal } as never,
        );
        expect(out).toContain("How to replace this file");
        expect(out).toContain("Delete this text and write what your agent");
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
