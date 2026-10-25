import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildAgentBundle } from "../src/build-bundle.js";
import { validateLlmAgentConfig } from "../src/llm/agent/config.js";
import { listTemplates } from "../src/templates/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = join(root, "templates", "llm-agent");

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

  it("template config passes validateLlmAgentConfig", () => {
    const config = JSON.parse(
      readFileSync(join(templateDir, "voicethere.llm.json"), "utf8"),
    );
    const result = validateLlmAgentConfig(config);
    expect(result.ok, JSON.stringify(result)).toBe(true);
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
});
