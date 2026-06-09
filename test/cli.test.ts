import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "../dist/cli.js");

describe("cli", () => {
  it("prints help when invoked with no arguments", () => {
    const result = spawnSync(process.execPath, [CLI], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Commands:");
    expect(result.stdout).toContain("build");
    expect(result.stdout).toContain("verify");
  });

  it("requires a command before bare options", () => {
    const result = spawnSync(process.execPath, [CLI, "--entry", "agent.ts"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing command");
  });
});
