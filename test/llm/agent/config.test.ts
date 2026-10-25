import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  LLM_AGENT_CONFIG_JSON_SCHEMA,
  validateLlmAgentConfig,
} from "../../../src/llm/agent/config.js";

const base = { version: 1, provider: "openai", apiKeySecret: "OPENAI_API_KEY" };

function errorsOf(input: unknown) {
  const r = validateLlmAgentConfig(input);
  if (r.ok) throw new Error("expected invalid config");
  return r.errors;
}

describe("validateLlmAgentConfig", () => {
  it("accepts a minimal config", () => {
    const r = validateLlmAgentConfig(base);
    expect(r.ok).toBe(true);
  });

  it("rejects baseUrl for providers other than openai", () => {
    expect(
      errorsOf({
        ...base,
        provider: "anthropic",
        apiKeySecret: "ANTHROPIC_API_KEY",
        baseUrl: "https://example.com/v1",
      }),
    ).toContainEqual({
      path: "baseUrl",
      message: 'is only allowed when provider is "openai"',
    });
    expect(
      validateLlmAgentConfig({ ...base, baseUrl: "https://example.com/v1" }).ok,
    ).toBe(true);
  });

  it("rejects a private-address MCP url", () => {
    const urls = [
      "https://10.1.2.3/mcp",
      "https://172.20.0.1/mcp",
      "https://192.168.1.5/mcp",
      "https://127.0.0.1/mcp",
      "https://169.254.169.254/mcp",
      "https://[::1]/mcp",
      "https://[fd00::1]/mcp",
      "https://localhost/mcp",
      "http://example.com/mcp",
    ];
    for (const url of urls) {
      const errors = errorsOf({
        ...base,
        toolSources: [
          { kind: "mcp", name: "ok", url: "https://example.com/mcp" },
          { kind: "mcp", name: "bad", url },
        ],
      });
      expect(
        errors.map((e) => e.path),
        url,
      ).toEqual(["toolSources[1].url"]);
    }
    expect(
      validateLlmAgentConfig({
        ...base,
        toolSources: [
          { kind: "mcp", name: "ok", url: "https://example.com/mcp" },
        ],
      }).ok,
    ).toBe(true);
  });

  it("rejects an unknown field", () => {
    expect(errorsOf({ ...base, colour: "red" })).toContainEqual({
      path: "colour",
      message: "unknown field",
    });
    expect(
      errorsOf({ ...base, tools: { maxRounds: 3, extra: 1 } }),
    ).toContainEqual({ path: "tools.extra", message: "unknown field" });
  });

  it("reports ranges, duplicate names and a second service source", () => {
    const errors = errorsOf({
      ...base,
      temperature: 3,
      toolSources: [
        { kind: "service" },
        { kind: "service" },
        { kind: "mcp", name: "a", url: "https://example.com/1" },
        { kind: "mcp", name: "a", url: "https://example.com/2" },
      ],
    });
    const paths = errors.map((e) => e.path);
    expect(paths).toContain("temperature");
    expect(paths).toContain("toolSources[1]");
    expect(paths).toContain("toolSources[3].name");
  });

  it("the JSON schema file matches the exported schema", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const file = join(here, "../../../schema/voicethere.llm.schema.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(
      JSON.parse(JSON.stringify(LLM_AGENT_CONFIG_JSON_SCHEMA)),
    );
  });
});
