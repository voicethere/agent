import { describe, expect, it } from "vitest";

import { buildChildExecArgv } from "../scripts/sandbox/sandbox.js";

describe("local sandbox harness", () => {
  it("matches runner permission flags (no child_process, scoped fs read)", () => {
    const argv = buildChildExecArgv({
      loaderDir: "/app/scripts/sandbox",
      bundlePath: "/app/dist/agent.js",
    });
    expect(argv).toContain("--permission");
    expect(argv).toContain("--allow-fs-read=/app/scripts/sandbox");
    expect(argv).toContain("--allow-fs-read=/app/dist");
    expect(argv.some((flag) => flag.includes("allow-child-process"))).toBe(
      false,
    );
    expect(argv.some((flag) => flag.includes("allow-fs-write"))).toBe(false);
  });
});
