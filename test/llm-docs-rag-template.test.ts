import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildAgentBundle } from "../src/build-bundle.js";
import { validateLlmAgentConfig } from "../src/llm/agent/config.js";
import { getTemplate } from "../src/templates/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const templatesDir = join(root, "templates");
const read = (f: string) =>
  readFileSync(join(templatesDir, "llm-docs-rag", f), "utf8");

describe("llm-docs-rag template", () => {
  it("is a creatable product template that seeds a bundle", () => {
    const t = getTemplate("llm-docs-rag");
    expect(t.kind).toBe("product");
    expect(t.seedOnCreate).toBe(true);
    expect(t.entry).toBe("llm-docs-rag/agent.ts");
  });

  it("every sourceFile exists on disk", () => {
    for (const f of getTemplate("llm-docs-rag").sourceFiles) {
      expect(existsSync(join(templatesDir, f)), f).toBe(true);
    }
    expect(existsSync(join(templatesDir, "llm-docs-rag", "README.md"))).toBe(
      true,
    );
  });

  it("config validates, allows only the two docs tools and keeps in-agent knowledge off", () => {
    const config = JSON.parse(read("voicethere.llm.json"));
    const result = validateLlmAgentConfig(config);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(config.toolSources).toEqual([
      { kind: "service", path: "/mcp", allow: ["search_docs", "get_doc"] },
    ]);
    expect(config.knowledge.store).toBe("off");
  });

  it("prompt searches before stating a fact and cites the URL", () => {
    const prompt = read("prompt.md");
    expect(prompt).toContain("search_docs before you state any fact");
    expect(prompt).toContain("URL");
    expect(prompt).toContain("get_doc");
  });

  it("README names the tools, the image and the health check", () => {
    const readme = read("README.md");
    for (const s of [
      "ghcr.io/voicethere/docs-rag-mcp",
      "search_docs",
      "/healthz",
      "8080",
    ]) {
      expect(readme).toContain(s);
    }
  });

  it("bundles with its json and md imports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voicethere-llm-docs-rag-"));
    const outfile = join(dir, "agent.js");
    try {
      await buildAgentBundle({
        cwd: root,
        entry: "templates/llm-docs-rag/agent.ts",
        outfile,
      });
      const source = readFileSync(outfile, "utf8");
      expect(source).toContain("search_docs");
      expect(source).toMatch(/path:\s*"\/mcp"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
