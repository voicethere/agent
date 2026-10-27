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

describe("llm-mcp-service template", () => {
  it("is a creatable product template that does not seed a bundle", () => {
    const t = getTemplate("llm-mcp-service");
    expect(t.kind).toBe("product");
    expect(t.seedOnCreate).toBe(false);
    expect(t.entry).toBe("llm-mcp-service/agent.ts");
  });

  it("every sourceFile exists on disk", () => {
    const t = getTemplate("llm-mcp-service");
    for (const f of t.sourceFiles) {
      expect(existsSync(join(templatesDir, f)), f).toBe(true);
    }
    expect(t.sourceFiles).toContain("llm-mcp-service/knowledge/about.md");
  });

  it("config validates and points the service tool source at /mcp", () => {
    const config = JSON.parse(
      readFileSync(
        join(templatesDir, "llm-mcp-service", "voicethere.llm.json"),
        "utf8",
      ),
    );
    const result = validateLlmAgentConfig(config);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(config.toolSources).toEqual([{ kind: "service", path: "/mcp" }]);
  });

  it("bundles with its json and md imports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voicethere-llm-mcp-template-"));
    const outfile = join(dir, "agent.js");
    try {
      await buildAgentBundle({
        cwd: root,
        entry: "templates/llm-mcp-service/agent.ts",
        outfile,
      });
      const source = readFileSync(outfile, "utf8");
      expect(source).toContain("get_plan_price");
      expect(source).toMatch(/path:\s*"\/mcp"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
