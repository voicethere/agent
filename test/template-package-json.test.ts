import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  AGENT_TEMPLATES,
  buildCustomerPackageJson,
  listSeedOnCreateTemplates,
  loadTemplateProjectWorkspace,
  loadTemplateWorkspaceSources,
  stripImageProvidedNpmDependencies,
} from "../src/templates/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const agentVersion = (
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  }
).version;

const IO_REDIS_TEMPLATES = ["game-sync", "webhooks-redis", "redis-sync"] as const;

describe("loadTemplateProjectWorkspace", () => {
  const productSeedTemplates = AGENT_TEMPLATES.filter(
    (template) => template.kind === "product" && template.seedOnCreate,
  );

  it("includes package.json for every product seedOnCreate template", () => {
    for (const template of productSeedTemplates) {
      const workspace = loadTemplateProjectWorkspace(template.id);
      const pkgFile = workspace.find((file) => file.path === "package.json");
      expect(pkgFile, `${template.id} missing package.json`).toBeDefined();
      expect(pkgFile?.content.length).toBeGreaterThan(0);
    }
  });

  it("does not add package.json to loadTemplateWorkspaceSources", () => {
    for (const template of productSeedTemplates) {
      const sources = loadTemplateWorkspaceSources(template.id);
      expect(sources.some((file) => file.path === "package.json")).toBe(false);
    }
  });

  it("package.json parses with agent caret dep and required scripts", () => {
    for (const template of productSeedTemplates) {
      const workspace = loadTemplateProjectWorkspace(template.id);
      const pkgFile = workspace.find((file) => file.path === "package.json");
      const parsed = JSON.parse(pkgFile?.content ?? "{}") as {
        name: string;
        private: boolean;
        type: string;
        dependencies: Record<string, string>;
        scripts: Record<string, string>;
      };

      expect(parsed.name).toBe(`voicethere-${template.id}`);
      expect(parsed.private).toBe(true);
      expect(parsed.type).toBe("module");
      expect(parsed.dependencies["@voicethere/agent"]).toBe(
        `^${agentVersion}`,
      );
      expect(parsed.scripts.build).toContain(template.entry);
      expect(parsed.scripts.verify).toContain(template.entry);
      expect(parsed.scripts.upload).toBe("voicethere build upload");
      expect(parsed.scripts.deploy).toBe("voicethere deploy --wait");
    }
  });

  it("includes ioredis for redis-backed templates", () => {
    for (const id of IO_REDIS_TEMPLATES) {
      const workspace = loadTemplateProjectWorkspace(id);
      const pkgFile = workspace.find((file) => file.path === "package.json");
      const parsed = JSON.parse(pkgFile?.content ?? "{}") as {
        dependencies: Record<string, string>;
      };
      expect(parsed.dependencies.ioredis).toBe("^5.11.1");
    }
  });

  it("echo template has no ioredis dependency", () => {
    const workspace = loadTemplateProjectWorkspace("echo");
    const pkgFile = workspace.find((file) => file.path === "package.json");
    const parsed = JSON.parse(pkgFile?.content ?? "{}") as {
      dependencies: Record<string, string>;
    };
    expect(parsed.dependencies.ioredis).toBeUndefined();
  });
});

describe("stripImageProvidedNpmDependencies", () => {
  it("strips agent and scripts from echo package.json", () => {
    const raw = buildCustomerPackageJson({ templateId: "echo" });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const { pkg, remainingDependencyCount } =
      stripImageProvidedNpmDependencies(parsed);

    expect(remainingDependencyCount).toBe(0);
    expect(pkg.scripts).toBeUndefined();
    expect(
      (pkg.dependencies as Record<string, string>)["@voicethere/agent"],
    ).toBeUndefined();
  });

  it("strips agent and scripts but keeps ioredis for game-sync", () => {
    const raw = buildCustomerPackageJson({ templateId: "game-sync" });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const { pkg, remainingDependencyCount } =
      stripImageProvidedNpmDependencies(parsed);

    expect(remainingDependencyCount).toBe(1);
    expect(pkg.scripts).toBeUndefined();
    const deps = pkg.dependencies as Record<string, string>;
    expect(deps["@voicethere/agent"]).toBeUndefined();
    expect(deps.ioredis).toBe("^5.11.1");
    expect(Object.keys(deps)).toEqual(["ioredis"]);
  });
});

describe("listSeedOnCreateTemplates", () => {
  it("matches product seedOnCreate templates", () => {
    const seedIds = listSeedOnCreateTemplates().map((template) => template.id);
    expect(seedIds.sort()).toEqual(
      AGENT_TEMPLATES.filter(
        (template) => template.kind === "product" && template.seedOnCreate,
      )
        .map((template) => template.id)
        .sort(),
    );
  });
});
