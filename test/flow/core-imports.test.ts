import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CORE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/flow/core",
);
const ALLOWED_TYPE_ONLY = [
  resolve(CORE, "../../llm/types"),
  resolve(CORE, "../../llm/agent/config"),
];

interface Imp {
  spec: string;
  typeOnly: boolean;
}

function importsOf(src: string): Imp[] {
  const out: Imp[] = [];
  const stat =
    /\b(import|export)\s+(type\s+)?[^;'"]*?\bfrom\s*["']([^"']+)["']/g;
  for (let m = stat.exec(src); m; m = stat.exec(src)) {
    out.push({ spec: m[3]!, typeOnly: m[2] !== undefined });
  }
  const bare = /\bimport\s+["']([^"']+)["']/g;
  for (let m = bare.exec(src); m; m = bare.exec(src))
    out.push({ spec: m[1]!, typeOnly: false });
  const dyn = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (let m = dyn.exec(src); m; m = dyn.exec(src))
    out.push({ spec: m[1]!, typeOnly: false });
  return out;
}

export function violations(dir: string, src: string): string[] {
  const bad: string[] = [];
  for (const { spec, typeOnly } of importsOf(src)) {
    if (!spec.startsWith(".")) {
      bad.push(`${spec} (node: or package import)`);
      continue;
    }
    const target = resolve(dir, spec).replace(/\.js$/, "");
    const inside = target === CORE || target.startsWith(CORE + sep);
    if (inside) continue;
    if (typeOnly && ALLOWED_TYPE_ONLY.includes(target)) continue;
    bad.push(`${spec} (leaves src/flow/core)`);
  }
  return bad;
}

describe("src/flow/core stays portable", () => {
  const files = readdirSync(CORE).filter((f) => f.endsWith(".ts"));

  it("has the expected modules", () => {
    expect(files.sort()).toEqual([
      "abort.ts",
      "compile.ts",
      "conditions.ts",
      "effects.ts",
      "generate-mock.ts",
      "host.ts",
      "index.ts",
      "interpreter.ts",
      "json-pointer.ts",
      "migrate.ts",
      "mock-effects.ts",
      "mocks.ts",
      "route.ts",
      "schema.ts",
      "template.ts",
      "trace.ts",
      "types.ts",
      "validate.ts",
    ]);
  });

  it.each(files)("%s has no forbidden imports", (f) => {
    expect(violations(CORE, readFileSync(join(CORE, f), "utf8"))).toEqual([]);
  });

  describe("the guard itself", () => {
    it("rejects node: specifiers, packages, and escaping relative imports", () => {
      expect(violations(CORE, 'import fs from "node:fs";')).toHaveLength(1);
      expect(violations(CORE, 'import { x } from "zod";')).toHaveLength(1);
      expect(
        violations(CORE, 'import { r } from "../../runtime.js";'),
      ).toHaveLength(1);
      expect(
        violations(CORE, 'import { t } from "../../llm/types.js";'),
      ).toHaveLength(1);
      expect(
        violations(CORE, 'const m = await import("node:path");'),
      ).toHaveLength(1);
      expect(violations(CORE, 'import "node:fs";')).toHaveLength(1);
    });

    it("allows type-only imports of the two llm files and in-core imports", () => {
      expect(
        violations(CORE, 'import type { A } from "../../llm/types.js";'),
      ).toEqual([]);
      expect(
        violations(CORE, 'import type { B } from "../../llm/agent/config.js";'),
      ).toEqual([]);
      expect(violations(CORE, 'export * from "./types.js";')).toEqual([]);
      expect(
        violations(CORE, 'import type {\n  A,\n} from "../../llm/types.js";'),
      ).toEqual([]);
    });
  });
});
