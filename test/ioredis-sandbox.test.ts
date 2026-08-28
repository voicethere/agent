import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { buildChildExecArgv } from "../src/sandbox/sandbox.js";
import { startMiniRedis, type MiniRedis } from "./helpers/mini-redis.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = join(__dirname, "..");
const FIXTURES = join(__dirname, "fixtures");
const SANDBOX_DIR = join(__dirname, "../src/sandbox");
const LOADER = join(SANDBOX_DIR, "loader-entry.js");
const IOREDIS_PROBE = join(FIXTURES, "ioredis-probe.mjs");
const NODE_MODULES = join(AGENT_ROOT, "node_modules");
const PROBE_TIMEOUT_MS = 8_000;

function runIoredisProbe(options: {
  port: number;
  allowInternet?: boolean;
  allowNetHosts?: string[];
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let child: ReturnType<typeof fork> | undefined;
    let settled = false;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child) {
        child.kill("SIGKILL");
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    };

    // Production agents bundle ioredis into agent.js; in this unit test we allow
    // reading node_modules so the probe can `require("ioredis")` under --permission.
    const execArgv = [
      ...buildChildExecArgv({
        loaderDir: SANDBOX_DIR,
        bundlePath: IOREDIS_PROBE,
        allowInternet: options.allowInternet,
        allowNetHosts: options.allowNetHosts,
      }),
      `--allow-fs-read=${NODE_MODULES}`,
    ];
    child = fork(LOADER, [], {
      env: {
        NODE_ENV: "production",
        __CHILD_BUNDLE_PATH__: IOREDIS_PROBE,
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: String(options.port),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv,
    });

    const timer = setTimeout(
      () => finish(child?.exitCode ?? null),
      PROBE_TIMEOUT_MS,
    );

    child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      if (child) {
        child.kill("SIGKILL");
      }
      reject(error);
    });
    child.on("exit", (code) => finish(code));
  });
}

describe("ioredis under child sandbox", () => {
  let miniRedis: MiniRedis | undefined;

  afterEach(async () => {
    if (miniRedis) {
      await miniRedis.close();
      miniRedis = undefined;
    }
  });

  it("connects with ioredis when allow-net includes the redis host", async () => {
    miniRedis = await startMiniRedis();

    const result = await runIoredisProbe({
      port: miniRedis.port,
      allowNetHosts: [`127.0.0.1:${miniRedis.port}`],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("IOREDIS_OK");
  }, 15_000);

  it("fails to connect when allow-net is not granted", async () => {
    miniRedis = await startMiniRedis();

    const result = await runIoredisProbe({
      port: miniRedis.port,
      allowInternet: false,
    });

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /ERR_ACCESS_DENIED|AccessDenied|IOREDIS_FAIL/,
    );
  }, 15_000);
});
