import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const loopFile = join(root, "eject", "llm", "loop.ts");

describe("llm eject source", () => {
  it("eject loop source imports only package entry points", () => {
    const source = readFileSync(loopFile, "utf8");
    expect(source.startsWith("// Copied from @voicethere/agent ")).toBe(true);
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(specifiers.length).toBeGreaterThan(0);
    const allowed = new Set([
      "@voicethere/agent",
      "@voicethere/agent/llm",
      ...builtinModules,
      ...builtinModules.map((name) => `node:${name}`),
    ]);
    for (const specifier of specifiers) {
      expect(allowed.has(specifier), specifier).toBe(true);
    }
  });

  it("eject loop typechecks against the built package", () => {
    const dir = mkdtempSync(join(tmpdir(), "voicethere-eject-"));
    try {
      const tsconfig = join(dir, "tsconfig.json");
      writeFileSync(
        tsconfig,
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            allowImportingTsExtensions: true,
            types: ["node"],
            typeRoots: [join(root, "node_modules", "@types")],
            baseUrl: root,
            paths: {
              "@voicethere/agent": [join(root, "dist/index.d.ts")],
              "@voicethere/agent/llm": [join(root, "dist/llm/index.d.ts")],
            },
          },
          files: [loopFile],
        }),
      );
      const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
      let output = "";
      try {
        execFileSync(process.execPath, [tsc, "-p", tsconfig], {
          cwd: root,
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      }
      expect(output).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
