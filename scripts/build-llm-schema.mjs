#!/usr/bin/env node
/** Writes schema/voicethere.llm.schema.json from the compiled config module. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = await import(
  pathToFileURL(join(root, "dist/llm/agent/config.js")).href
);
mkdirSync(join(root, "schema"), { recursive: true });
writeFileSync(
  join(root, "schema/voicethere.llm.schema.json"),
  `${JSON.stringify(mod.LLM_AGENT_CONFIG_JSON_SCHEMA, null, 2)}\n`,
);
