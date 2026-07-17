import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildChildExecArgv } from "../src/sandbox/sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");
const SANDBOX_DIR = join(__dirname, "../src/sandbox");
const LOADER = join(SANDBOX_DIR, "loader-entry.js");

function runSandboxedChild(
  bundlePath: string,
): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stderrChunks: Buffer[] = [];
    const child = fork(LOADER, [], {
      env: {
        NODE_ENV: "production",
        __CHILD_BUNDLE_PATH__: bundlePath,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      execArgv: buildChildExecArgv({
        loaderDir: SANDBOX_DIR,
        bundlePath,
      }),
    });

    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({
        exitCode: code,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

describe("buildChildExecArgv", () => {
  it("matches runner permission flags (no child_process, scoped fs read)", () => {
    const argv = buildChildExecArgv({
      loaderDir: "/app/src/sandbox",
      bundlePath: "/app/dist/agent.js",
    });
    expect(argv).toContain("--permission");
    expect(argv).toContain("--allow-fs-read=/app/src/sandbox");
    expect(argv).toContain("--allow-fs-read=/app/dist");
    expect(argv).toContain("--allow-fs-read=/app/dist/agent.js");
    expect(argv.some((flag) => flag.includes("allow-child-process"))).toBe(
      false,
    );
    expect(argv.some((flag) => flag.includes("allow-fs-write"))).toBe(false);
    expect(argv.some((flag) => flag.includes("allow-addons"))).toBe(false);
  });

  it("resolves relative loader and bundle paths", () => {
    const argv = buildChildExecArgv({
      loaderDir: "./src/sandbox",
      bundlePath: "./dist/agent.js",
    });
    expect(argv[0]).toBe("--permission");
    expect(argv[1]).toMatch(/^--allow-fs-read=/);
    expect(argv[2]).toMatch(/^--allow-fs-read=/);
    expect(argv[1]).not.toBe(argv[2]);
  });

  it("includes bundle file path when loader and bundle share a parent", () => {
    const argv = buildChildExecArgv({
      loaderDir: "/app/dist",
      bundlePath: "/app/dist/agent.js",
    });
    const readFlags = argv.filter((flag) =>
      flag.startsWith("--allow-fs-read="),
    );
    expect(readFlags).toContain("--allow-fs-read=/app/dist");
    expect(readFlags).toContain("--allow-fs-read=/app/dist/agent.js");
  });
  it("includes allow-net flags when allowNetHosts is set", () => {
    const argv = buildChildExecArgv({
      loaderDir: "/app/src/sandbox",
      bundlePath: "/app/dist/agent.js",
      allowNetHosts: ["project-redis", "127.0.0.1:6379"],
    });
    expect(argv).toContain("--allow-net=project-redis");
    expect(argv).toContain("--allow-net=127.0.0.1:6379");
    expect(argv.some((flag) => flag.includes("allow-child-process"))).toBe(
      false,
    );
    expect(argv.some((flag) => flag.includes("allow-fs-write"))).toBe(false);
    expect(argv.some((flag) => flag.includes("allow-addons"))).toBe(false);
  });

  it("omits allow-net when allowNetHosts is empty or absent", () => {
    const argv = buildChildExecArgv({
      loaderDir: "/app/src/sandbox",
      bundlePath: "/app/dist/agent.js",
      allowNetHosts: ["", "  "],
    });
    expect(argv.some((flag) => flag.startsWith("--allow-net"))).toBe(false);
  });
});

describe("child sandbox enforcement", () => {
  it("blocks fs read outside allowlisted dirs", async () => {
    const result = await runSandboxedChild(join(FIXTURES, "read-fs-probe.mjs"));
    expect(result.exitCode).not.toBe(0);
  }, 10_000);

  it("blocks child_process exec", async () => {
    const result = await runSandboxedChild(join(FIXTURES, "spawn-probe.mjs"));
    expect(result.exitCode).not.toBe(0);
  }, 10_000);
});
