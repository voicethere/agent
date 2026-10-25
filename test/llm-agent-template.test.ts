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
