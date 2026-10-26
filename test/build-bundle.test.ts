import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { buildAgentBundle } from "../src/build-bundle.js";

describe("buildAgentBundle", () => {
  it("bundles templates/voice-starter/agent.ts into a single ESM file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voicethere-agent-build-"));
    const outfile = join(dir, "dist", "agent.js");

    try {
      await buildAgentBundle({
        cwd: process.cwd(),
        entry: "templates/voice-starter/agent.ts",
        outfile,
      });

      const source = readFileSync(outfile, "utf8");
      expect(source.length).toBeGreaterThan(500);
      expect(source).toContain("defineAgent");
      expect(source).toContain("speak");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bundles ioredis without esbuild dynamic require shim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voicethere-agent-ioredis-"));
    const outfile = join(dir, "dist", "agent.js");

    try {
      await buildAgentBundle({
        cwd: process.cwd(),
        entry: "test/fixtures/ioredis-bundle-agent.ts",
        outfile,
      });

      const source = readFileSync(outfile, "utf8");
      expect(source).toContain("defineAgent");
      expect(source).toContain("(import.meta.url)");
      expect(source).not.toContain('__require("supports-color")');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when entry is missing", async () => {
    await expect(
      buildAgentBundle({
        entry: "does-not-exist/agent.ts",
        outfile: "dist/agent.js",
      }),
    ).rejects.toThrow(/Entry not found/);
  });

  it("bundles .md imports as text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voicethere-agent-md-"));
    try {
      writeFileSync(
        join(dir, "prompt.md"),
        "You are a calm voice assistant.\n",
      );
      writeFileSync(
        join(dir, "agent.ts"),
        'import prompt from "./prompt.md";\nconsole.log(prompt);\n',
      );
      await buildAgentBundle({
        cwd: dir,
        entry: "agent.ts",
        outfile: join(dir, "dist", "agent.js"),
      });
      const source = readFileSync(join(dir, "dist", "agent.js"), "utf8");
      expect(source).toContain("You are a calm voice assistant.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildAgentBundle module identifiers", () => {
  it("a bundle with the LLM agent and its own createRequire import loads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voicethere-agent-createrequire-"));
    const outfile = join(dir, "agent.mjs");
    try {
      await buildAgentBundle({
        cwd: process.cwd(),
        entry: "test/fixtures/llm-create-require-agent.ts",
        outfile,
      });
      const source = readFileSync(outfile, "utf8");
      expect(source).toContain("__voicethereCreateRequire(import.meta.url)");
      // Parsing is what failed: "Identifier 'createRequire' has already been declared".
      // Import in a child: importing runs defineAgent, which talks to its parent over IPC.
      const run = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const m = await import(${JSON.stringify(pathToFileURL(outfile).href)}); process.stdout.write(typeof m.entryRequire); process.exit(0);`,
        ],
        { encoding: "utf8", timeout: 20_000 },
      );
      expect(run.stderr).not.toContain("has already been declared");
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toBe("function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
