#!/usr/bin/env node
/**
 * Guard against ERR_PACKAGE_PATH_NOT_EXPORTED when tsx/Node resolves via CJS.
 * Run after `npm run build` in test:ci and release workflow.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const REQUIRED_CONDITIONS = ["import", "require", "default"];

function assertExportConditions(label, spec) {
  if (typeof spec === "string") {
    throw new Error(`${label}: expected object export map, got string`);
  }
  for (const cond of REQUIRED_CONDITIONS) {
    if (!spec[cond]) {
      throw new Error(`${label}: missing "${cond}" export condition`);
    }
  }
}

for (const [subpath, spec] of Object.entries(pkg.exports ?? {})) {
  assertExportConditions(subpath, spec);
}

const requireFromPkg = createRequire(join(root, "package.json"));

for (const subpath of ["", "/verify"]) {
  const resolved = requireFromPkg.resolve(`${pkg.name}${subpath}`);
  if (!resolved.endsWith(".js")) {
    throw new Error(
      `${pkg.name}${subpath || "/."} resolved to non-js path: ${resolved}`,
    );
  }
  const mod = requireFromPkg(`${pkg.name}${subpath}`);
  if (subpath === "/verify") {
    if (typeof mod.runAgentVerify !== "function") {
      throw new Error("@voicethere/agent/verify must export runAgentVerify");
    }
  } else if (typeof mod !== "object" || mod == null) {
    throw new Error("@voicethere/agent root export must be an object");
  }
}

console.log("verify-package-exports: ok");
