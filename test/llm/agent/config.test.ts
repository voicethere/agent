import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  LLM_AGENT_CONFIG_JSON_SCHEMA,
  validateLlmAgentConfig,
} from "../../../src/llm/agent/config.js";

const base = {
  version: 1,
  provider: "openai",
  apiKeySecret: "AGENT_OPENAI_API_KEY",
};

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

  it("rejects an apiKeySecret without the AGENT_ prefix", () => {
    expect(
      errorsOf({ ...base, apiKeySecret: "OPENAI_API_KEY" }),
    ).toContainEqual({
      path: "apiKeySecret",
      message:
        "must start with AGENT_ (only AGENT_* project secrets reach the agent)",
    });
  });

  it("rejects an MCP bearer secret without the AGENT_ prefix", () => {
    const errors = errorsOf({
      ...base,
      toolSources: [
        {
          kind: "mcp",
          name: "ok",
          url: "https://example.com/mcp",
          auth: { type: "bearer", secret: "MCP_TOKEN" },
        },
        {
          kind: "mcp",
          name: "hdr",
          url: "https://example.com/mcp2",
          auth: { type: "headers", headers: { "X-Key": "MCP_KEY" } },
        },
      ],
    });
    expect(errors.map((e) => e.path)).toEqual([
      "toolSources[0].auth.secret",
      "toolSources[1].auth.headers.X-Key",
    ]);
    expect(errors[0].message).toContain("must start with AGENT_");
  });

  it("accepts AGENT_ names", () => {
    expect(
      validateLlmAgentConfig({
        ...base,
        toolSources: [
          {
            kind: "mcp",
            name: "ok",
            url: "https://example.com/mcp",
            auth: { type: "bearer", secret: "AGENT_MCP_TOKEN" },
          },
          {
            kind: "mcp",
            name: "hdr",
            url: "https://example.com/mcp2",
            auth: { type: "headers", headers: { "X-Key": "AGENT_MCP_KEY" } },
          },
        ],
      }).ok,
    ).toBe(true);
  });

  it("accepts and ignores $schema", () => {
    const r = validateLlmAgentConfig({
      ...base,
      $schema:
        "./node_modules/@voicethere/agent/schema/voicethere.llm.schema.json",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.stringify(r.config)).not.toContain("$schema");
  });

  it("rejects baseUrl for providers other than openai", () => {
    expect(
      errorsOf({
        ...base,
        provider: "anthropic",
        apiKeySecret: "AGENT_ANTHROPIC_API_KEY",
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

  describe("knowledge", () => {
    const redis = {
      store: "redis",
      embeddings: { provider: "openai", dimensions: 512 },
    };
    const supabase = {
      store: "supabase",
      topK: 5,
      embeddings: {
        provider: "gemini",
        apiKeySecret: "AGENT_GEMINI_API_KEY",
      },
      supabase: {
        urlSecret: "AGENT_SUPABASE_URL",
        keySecret: "AGENT_SUPABASE_KEY",
        rpc: "match_documents",
        matchThreshold: 0.6,
        cacheTtlSeconds: 300,
      },
    };

    it("accepts redis, supabase and off blocks", () => {
      const r = validateLlmAgentConfig({ ...base, knowledge: redis });
      expect(r.ok && r.config.knowledge).toEqual({
        store: "redis",
        embeddings: {
          provider: "openai",
          dimensions: 512,
          apiKeySecret: "AGENT_OPENAI_API_KEY",
        },
      });
      expect(validateLlmAgentConfig({ ...base, knowledge: supabase }).ok).toBe(
        true,
      );
      expect(
        validateLlmAgentConfig({ ...base, knowledge: { store: "off" } }).ok,
      ).toBe(true);
    });

    it.each([
      [
        "anthropic embeddings",
        { ...redis, embeddings: { provider: "anthropic" } },
        "knowledge.embeddings.provider",
      ],
      [
        "supabase block missing",
        { store: "supabase", embeddings: redis.embeddings },
        "knowledge.supabase",
      ],
      [
        "bad secret name",
        {
          ...supabase,
          supabase: { ...supabase.supabase, keySecret: "SUPABASE_KEY" },
        },
        "knowledge.supabase.keySecret",
      ],
      ["topK 11", { ...redis, topK: 11 }, "knowledge.topK"],
      [
        "bad rpc",
        {
          ...supabase,
          supabase: { ...supabase.supabase, rpc: "x/../y" },
        },
        "knowledge.supabase.rpc",
      ],
      [
        "bad namespace",
        { ...redis, redis: { namespace: "Bad Space" } },
        "knowledge.redis.namespace",
      ],
      [
        "embeddings key needed when provider differs from the top-level one",
        { store: "redis", embeddings: { provider: "gemini" } },
        "knowledge.embeddings.apiKeySecret",
      ],
      ["embeddings missing", { store: "redis" }, "knowledge.embeddings"],
      ["unknown field", { ...redis, extra: 1 }, "knowledge.extra"],
    ])("rejects: %s", (_name, knowledge, path) => {
      expect(errorsOf({ ...base, knowledge }).map((e) => e.path)).toContain(
        path,
      );
    });

    it("anthropic message names the alternatives", () => {
      const e = errorsOf({
        ...base,
        knowledge: { ...redis, embeddings: { provider: "anthropic" } },
      });
      expect(e[0]?.message).toBe(
        "anthropic has no embeddings API; use openai, gemini or openrouter",
      );
    });

    it("the JSON schema on disk describes the knowledge block", async () => {
      const schema = LLM_AGENT_CONFIG_JSON_SCHEMA.properties.knowledge;
      expect(schema.required).toEqual(["store"]);
      expect(schema.properties.store.enum).toEqual([
        "redis",
        "supabase",
        "off",
      ]);
      expect(Object.keys(schema.properties.supabase.properties)).toEqual([
        "urlSecret",
        "keySecret",
        "rpc",
        "matchThreshold",
        "cacheTtlSeconds",
      ]);
      const onDisk = JSON.parse(
        readFileSync(
          join(
            dirname(fileURLToPath(import.meta.url)),
            "../../../schema/voicethere.llm.schema.json",
          ),
          "utf8",
        ),
      ) as { properties: Record<string, unknown> };
      expect(onDisk.properties.knowledge).toEqual(
        JSON.parse(JSON.stringify(schema)),
      );
    });
  });
});
