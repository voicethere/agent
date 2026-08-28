import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_TEMPLATES,
  getTemplate,
  hasSeedBundle,
  listSeedOnCreateTemplates,
  listTemplates,
  loadTemplateBundle,
  loadTemplateSources,
  resolveTemplateEntryPath,
} from "../src/templates/index.js";
import {
  isAllowlistedEnvProbeKey,
  resolveEnvProbeValue,
} from "../templates/game-sync-smoke.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

describe("agent template registry", () => {
  it("lists all registered templates", () => {
    expect(listTemplates()).toHaveLength(AGENT_TEMPLATES.length);
    expect(
      listTemplates()
        .map((template) => template.id)
        .sort(),
    ).toEqual(
      [
        "crash",
        "echo",
        "echo-dc",
        "echo-smoke",
        "game-sync",
        "game-sync-smoke",
        "redis-sync",
        "voice-showcase",
        "voice-starter",
        "webhooks",
        "webhooks-redis",
      ].sort(),
    );
  });

  it("filters templates by kind", () => {
    const product = listTemplates({ kind: "product" });
    expect(product.every((template) => template.kind === "product")).toBe(true);
    expect(product).toHaveLength(7);

    const e2e = listTemplates({ kind: "e2e" });
    expect(e2e.every((template) => template.kind === "e2e")).toBe(true);
    expect(e2e).toHaveLength(4);
  });

  it("throws for unknown template ids", () => {
    expect(() => getTemplate("missing")).toThrow(/Unknown agent template id/);
  });

  it("resolves entry paths for every template", () => {
    for (const template of AGENT_TEMPLATES) {
      const entryPath = resolveTemplateEntryPath(template.id);
      expect(existsSync(entryPath)).toBe(true);
      expect(entryPath).toContain(join("templates", template.entry));
    }
  });

  it("loads non-empty sources for every template", () => {
    for (const template of AGENT_TEMPLATES) {
      const sources = loadTemplateSources(template.id);
      expect(sources.length).toBeGreaterThan(0);
      expect(sources.length).toBe(template.sourceFiles.length);
      for (const source of sources) {
        expect(source.path.length).toBeGreaterThan(0);
        expect(source.content.length).toBeGreaterThan(50);
      }
      expect(
        sources.some((source) => source.content.includes("defineAgent")),
      ).toBe(true);
    }
  });

  it("loads redis-sync multi-file sources with world-layout", () => {
    const sources = loadTemplateSources("redis-sync");
    expect(sources.map((source) => source.path).sort()).toEqual(
      ["agent.ts", "world-layout.ts"].sort(),
    );
    expect(
      sources.find((source) => source.path === "world-layout.ts")?.content,
    ).toContain("REDIS_WORLD_KEY");
  });
});

describe("seed template bundles", () => {
  const seedIds = listSeedOnCreateTemplates().map((template) => template.id);

  it("marks only product templates as seedOnCreate", () => {
    expect(seedIds.sort()).toEqual(
      [
        "echo",
        "echo-dc",
        "game-sync",
        "voice-showcase",
        "voice-starter",
        "webhooks",
        "webhooks-redis",
      ].sort(),
    );
  });

  it("has prebuilt bundles after build for every seedOnCreate template", () => {
    for (const id of seedIds) {
      const bundlePath = join(root, "dist", "templates", id, "agent.js");
      expect(existsSync(bundlePath), `missing ${bundlePath}`).toBe(true);
      expect(hasSeedBundle(id)).toBe(true);
      const bundle = loadTemplateBundle(id);
      expect(bundle.byteLength).toBeGreaterThan(500);
      expect(bundle.toString("utf8")).toContain("defineAgent");
    }
  });

  it("rejects loadTemplateBundle for e2e-only templates", () => {
    expect(() => loadTemplateBundle("echo-smoke")).toThrow(
      /does not publish a seed bundle/,
    );
    expect(hasSeedBundle("echo-smoke")).toBe(false);
  });
});

describe("game-sync-smoke env_probe", () => {
  it("loads env_probe handler and allowlist in template sources", () => {
    const sources = loadTemplateSources("game-sync-smoke");
    const content = sources.map((source) => source.content).join("\n");
    expect(content).toContain("env_probe");
    expect(content).toContain("env_probe_ack");
    expect(content).toContain("AGENT_E2E_ENV_PROBE_KEY_PATTERN");
  });
});

describe("game-sync-smoke env_probe helpers", () => {
  it("allowlists AGENT_E2E_* keys only", () => {
    expect(isAllowlistedEnvProbeKey("AGENT_E2E_SMOKE")).toBe(true);
    expect(isAllowlistedEnvProbeKey("AGENT_E2E_SECRET")).toBe(true);
    expect(isAllowlistedEnvProbeKey("AGENT_OPENAI_API_KEY")).toBe(false);
    expect(isAllowlistedEnvProbeKey("AGENT_WEBHOOK_SIGNING_SECRET")).toBe(
      false,
    );
    expect(isAllowlistedEnvProbeKey("AGENT_E2E_lowercase")).toBe(false);
  });

  it("resolveEnvProbeValue returns process.env for allowlisted keys", () => {
    const previous = process.env.AGENT_E2E_SMOKE;
    process.env.AGENT_E2E_SMOKE = "probe-value";
    try {
      expect(resolveEnvProbeValue("AGENT_E2E_SMOKE")).toBe("probe-value");
      expect(resolveEnvProbeValue("AGENT_OPENAI_API_KEY")).toBe(null);
    } finally {
      if (previous === undefined) {
        delete process.env.AGENT_E2E_SMOKE;
      } else {
        process.env.AGENT_E2E_SMOKE = previous;
      }
    }
  });
});
