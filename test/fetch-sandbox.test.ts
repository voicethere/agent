import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildChildExecArgv } from "../src/sandbox/sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");
const SANDBOX_DIR = join(__dirname, "../src/sandbox");
const LOADER = join(SANDBOX_DIR, "loader-entry.js");
const FETCH_PROBE = join(FIXTURES, "fetch-probe.mjs");

function runFetchProbe(): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const execArgv = buildChildExecArgv({
      loaderDir: SANDBOX_DIR,
      bundlePath: FETCH_PROBE,
    });
    const child = fork(LOADER, [], {
      env: {
        NODE_ENV: "production",
        __CHILD_BUNDLE_PATH__: FETCH_PROBE,
        FETCH_URL: "https://www.google.com/",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv,
    });

    child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

describe("fetch under child sandbox", () => {
  it("fetches a public HTTPS URL when boolean --allow-net is granted", async () => {
    const result = await runFetchProbe();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("FETCH_OK");
  }, 20_000);
});
