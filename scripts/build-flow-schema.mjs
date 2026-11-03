#!/usr/bin/env node
/** Writes schema/voicethere.flow.schema.json from the compiled config module, formatted with the repo's Prettier config. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as prettier from "prettier";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = await import(
  pathToFileURL(join(root, "dist/flow/core/schema.js")).href
);
const target = join(root, "schema/voicethere.flow.schema.json");
mkdirSync(join(root, "schema"), { recursive: true });
const options = (await prettier.resolveConfig(target)) ?? {};
const text = await prettier.format(
  `${JSON.stringify(mod.FLOW_JSON_SCHEMA, null, 2)}\n`,
  { ...options, filepath: target },
);
writeFileSync(target, text);
