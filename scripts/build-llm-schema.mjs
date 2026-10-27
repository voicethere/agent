#!/usr/bin/env node
/** Writes schema/voicethere.llm.schema.json from the compiled config module, formatted with the repo's Prettier config. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as prettier from "prettier";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = await import(
  pathToFileURL(join(root, "dist/llm/agent/config.js")).href
);
const target = join(root, "schema/voicethere.llm.schema.json");
mkdirSync(join(root, "schema"), { recursive: true });
const options = (await prettier.resolveConfig(target)) ?? {};
const text = await prettier.format(
  `${JSON.stringify(mod.LLM_AGENT_CONFIG_JSON_SCHEMA, null, 2)}\n`,
  { ...options, filepath: target },
);
writeFileSync(target, text);
