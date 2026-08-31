import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAgentBundle } from "../build-bundle.js";
import {
  AGENT_TEMPLATES,
  type AgentTemplateDefinition,
  type TemplateKind,
  getTemplateById,
  listSeedOnCreateTemplates,
} from "./registry.js";

export type {
  AgentTemplateDefinition,
  AgentTemplateId,
  TemplateKind,
} from "./registry.js";
export {
  AGENT_TEMPLATES,
  getTemplateById,
  isAgentTemplateId,
  listSeedOnCreateTemplates,
} from "./registry.js";

export interface TemplateSourceFile {
  /** Project-relative path within the template tree (e.g. `agent.ts`, `world-layout.ts`). */
  path: string;
  content: string;
}

export interface ListTemplatesFilter {
  kind?: TemplateKind;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(MODULE_DIR, "..", "..");
const TEMPLATES_DIR = join(PACKAGE_ROOT, "templates");

function toProjectRelativeSourcePath(sourceFile: string): string {
  if (sourceFile.includes("/")) {
    return sourceFile.split("/").pop() ?? sourceFile;
  }
  return sourceFile;
}

export function listTemplates(
  filter?: ListTemplatesFilter,
): AgentTemplateDefinition[] {
  if (!filter?.kind) {
    return [...AGENT_TEMPLATES];
  }
  return AGENT_TEMPLATES.filter((template) => template.kind === filter.kind);
}

export function getTemplate(id: string): AgentTemplateDefinition {
  return getTemplateById(id);
}

export function resolveTemplateEntryPath(id: string): string {
  const template = getTemplateById(id);
  const entryPath = join(TEMPLATES_DIR, template.entry);
  if (!existsSync(entryPath)) {
    throw new Error(`Template entry not found for ${id}: ${entryPath}`);
  }
  return resolve(entryPath);
}

export function loadTemplateSources(id: string): TemplateSourceFile[] {
  const template = getTemplateById(id);
  return template.sourceFiles.map((sourceFile) => {
    const absolutePath = join(TEMPLATES_DIR, sourceFile);
    if (!existsSync(absolutePath)) {
      throw new Error(`Template source not found for ${id}: ${absolutePath}`);
    }
    return {
      path: toProjectRelativeSourcePath(sourceFile),
      content: readFileSync(absolutePath, "utf8"),
    };
  });
}

/** Like {@link loadTemplateSources}, but paths match registry `sourceFiles` (e.g. `voice-showcase/agent.ts`). */
export function loadTemplateWorkspaceSources(id: string): TemplateSourceFile[] {
  const template = getTemplateById(id);
  return template.sourceFiles.map((sourceFile) => {
    const absolutePath = join(TEMPLATES_DIR, sourceFile);
    if (!existsSync(absolutePath)) {
      throw new Error(`Template source not found for ${id}: ${absolutePath}`);
    }
    return {
      path: sourceFile,
      content: readFileSync(absolutePath, "utf8"),
    };
  });
}

function seedBundlePath(id: string): string {
  return join(PACKAGE_ROOT, "dist", "templates", id, "agent.js");
}

export function hasSeedBundle(id: string): boolean {
  const template = getTemplateById(id);
  if (!template.seedOnCreate) {
    return false;
  }
  return existsSync(seedBundlePath(id));
}

export function loadTemplateBundle(id: string): Buffer {
  const template = getTemplateById(id);
  if (!template.seedOnCreate) {
    throw new Error(`Template ${id} does not publish a seed bundle`);
  }
  const bundlePath = seedBundlePath(id);
  if (!existsSync(bundlePath)) {
    throw new Error(
      `Missing prebuilt seed bundle for ${id}. Run npm run build in @voicethere/agent.`,
    );
  }
  return readFileSync(bundlePath);
}

export async function buildSeedTemplateBundles(): Promise<void> {
  for (const template of listSeedOnCreateTemplates()) {
    const outfile = seedBundlePath(template.id);
    await buildAgentBundle({
      cwd: PACKAGE_ROOT,
      entry: join("templates", template.entry),
      outfile,
    });
  }
}
