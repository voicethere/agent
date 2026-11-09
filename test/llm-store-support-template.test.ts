import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildAgentBundle } from "../src/build-bundle.js";
import { validateLlmAgentConfig } from "../src/llm/agent/config.js";
import { getTemplate, listTemplates } from "../src/templates/index.js";
import { SAMPLE_PRODUCTS } from "../services/mcp-example/server.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const templatesDir = join(root, "templates");
const templateDir = join(templatesDir, "llm-store-support");
const read = (f: string) => readFileSync(join(templateDir, f), "utf8");
const knowledgeFiles = () =>
  readdirSync(join(templateDir, "knowledge")).filter((f) => f.endsWith(".md"));

describe("llm-store-support template", () => {
  it("is a creatable product template and ships every listed file", () => {
    const template = listTemplates({ kind: "product" }).find(
      (t) => t.id === "llm-store-support",
    );
    expect(template).toBeDefined();
    expect(template?.seedOnCreate).toBe(true);
    expect(template?.entry).toBe("llm-store-support/agent.ts");
    for (const f of getTemplate("llm-store-support").sourceFiles) {
      expect(existsSync(join(templatesDir, f)), f).toBe(true);
    }
  });

  it("lists every knowledge file in sourceFiles and agent.ts", () => {
    const files = knowledgeFiles();
    expect(files.sort()).toEqual([
      "products.md",
      "returns.md",
      "shipping.md",
      "sizing.md",
      "store.md",
      "warranty.md",
    ]);
    const sources = getTemplate("llm-store-support").sourceFiles;
    const agent = read("agent.ts");
    for (const f of files) {
      expect(sources).toContain(`llm-store-support/knowledge/${f}`);
      expect(agent).toContain(`./knowledge/${f}`);
    }
  });

  it("config validates with Redis knowledge, the two price tools and a forced first tool call", () => {
    const config = JSON.parse(read("voicethere.llm.json"));
    const result = validateLlmAgentConfig(config);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(config.model).toBe("amazon/nova-micro-v1");
    expect(config.toolChoice).toBe("required-first-round");
    expect(config.toolSources).toEqual([
      {
        kind: "service",
        path: "/mcp",
        allow: ["list_products", "get_product_price"],
      },
    ]);
    expect(config.knowledge.store).toBe("redis");
    expect(config.knowledge.embeddings.provider).toBe("openrouter");
    expect(config.knowledge.redis.namespace).toBe("store-support");
  });

  it("knowledge files hold no prices and no product price from the catalog", () => {
    for (const f of knowledgeFiles()) {
      const text = readFileSync(join(templateDir, "knowledge", f), "utf8");
      expect(text, f).not.toMatch(/\$\s?\d/);
      expect(text.toLowerCase(), f).not.toMatch(/\bdollars?\b/);
      expect(text, f).not.toMatch(/\bUSD\b/);
      for (const row of Object.values(SAMPLE_PRODUCTS)) {
        expect(text, f).not.toMatch(
          new RegExp(`\\b${row.priceUsd}\\b\\s*(usd|dollars)`, "i"),
        );
      }
    }
  });

  it("knowledge names every catalog product", () => {
    const products = read("knowledge/products.md");
    for (const row of Object.values(SAMPLE_PRODUCTS)) {
      const shortName = row.name.split(" ").slice(0, 2).join(" ");
      expect(products, row.name).toContain(shortName);
    }
  });

  it("prompt searches first, gets prices from the tool and never guesses", () => {
    const prompt = read("prompt.md");
    expect(prompt).toContain("search_knowledge");
    expect(prompt).toContain("get_product_price");
    expect(prompt).toContain("list_products");
    expect(prompt).toContain(
      "Never state a price that did not come from get_product_price",
    );
    expect(prompt).toContain("one to three short sentences");
  });

  it("README names the image, the tools and the health check", () => {
    const readme = read("README.md");
    for (const s of [
      "ghcr.io/voicethere/mcp-example-service",
      "get_product_price",
      "list_products",
      "/healthz",
      "8080",
    ]) {
      expect(readme).toContain(s);
    }
  });

  it("bundles with the prompt, greeting and knowledge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voicethere-store-bundle-"));
    const outfile = join(dir, "agent.js");
    try {
      await buildAgentBundle({
        cwd: root,
        entry: "templates/llm-store-support/agent.ts",
        outfile,
      });
      const source = readFileSync(outfile, "utf8");
      expect(source).toContain("Kestrel Outdoor support");
      expect(source).toContain("phone support assistant for Kestrel Outdoor");
      expect(source).toContain("Returns and exchanges");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
