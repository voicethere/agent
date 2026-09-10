import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getTemplateById } from "./registry.js";

export const IMAGE_PROVIDED_NPM_PACKAGES = [
  "@voicethere/agent",
  "@types/node",
] as const;

export interface BuildCustomerPackageJsonOptions {
  templateId: string;
  name?: string;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(MODULE_DIR, "..", "..");

function readAgentPackageVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
}

export function buildCustomerPackageJson(
  options: BuildCustomerPackageJsonOptions,
): string {
  const template = getTemplateById(options.templateId);
  const agentVersion = readAgentPackageVersion();
  const dependencies: Record<string, string> = {
    "@voicethere/agent": `^${agentVersion}`,
    ...template.npmDependencies,
  };

  const pkg = {
    name: options.name ?? `voicethere-${options.templateId}`,
    private: true,
    type: "module",
    dependencies,
    scripts: {
      build: `npx @voicethere/agent build --entry ${template.entry} --outfile dist/agent.js`,
      verify: `npx @voicethere/agent verify --entry ${template.entry} --outfile dist/agent.js`,
      "verify:start": `npx @voicethere/agent verify-start --entry ${template.entry} --outfile dist/agent.js`,
      upload: "voicethere build upload",
      deploy: "voicethere deploy --wait",
      "source:push": "voicethere source push",
      "source:pull": "voicethere source pull",
    },
  };

  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export interface StripImageProvidedNpmDependenciesResult {
  pkg: Record<string, unknown>;
  remainingDependencyCount: number;
}

export function stripImageProvidedNpmDependencies(
  parsed: Record<string, unknown>,
): StripImageProvidedNpmDependenciesResult {
  const pkg = { ...parsed };
  delete pkg.scripts;

  const deps = {
    ...((pkg.dependencies as Record<string, string> | undefined) ?? {}),
  };
  for (const key of IMAGE_PROVIDED_NPM_PACKAGES) {
    delete deps[key];
  }
  pkg.dependencies = deps;

  const remainingDependencyCount = Object.keys(deps).length;

  return { pkg, remainingDependencyCount };
}
