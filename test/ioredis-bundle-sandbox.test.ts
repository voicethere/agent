import { fork } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { buildAgentBundle } from "../src/build-bundle.js";
import { buildChildExecArgv } from "../src/sandbox/sandbox.js";
import type { ChildToParentMessage } from "../src/protocol.js";
import { startMiniRedis, type MiniRedis } from "./helpers/mini-redis.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = join(__dirname, "..");
const SANDBOX_DIR = join(AGENT_ROOT, "src/sandbox");
const LOADER = join(SANDBOX_DIR, "loader-entry.js");
const TEST_TMP_DIR = join(AGENT_ROOT, "test", ".tmp");

function runBundledIoredisAgent(options: {
  bundlePath: string;
  port: number;
  timeoutMs?: number;
}): Promise<{
  exitCode: number | null;
  messages: ChildToParentMessage[];
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const stderrChunks: Buffer[] = [];
    const messages: ChildToParentMessage[] = [];
    const timeoutMs = options.timeoutMs ?? 10_000;
    const execArgv = buildChildExecArgv({
      loaderDir: SANDBOX_DIR,
      bundlePath: options.bundlePath,
      allowNetHosts: [`127.0.0.1:${options.port}`],
    });
    const child = fork(LOADER, [], {
      env: {
        NODE_ENV: "production",
        __CHILD_BUNDLE_PATH__: options.bundlePath,
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: String(options.port),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv,
    });

    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve({
        exitCode,
        messages,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    };

    const timer = setTimeout(() => finish(child.exitCode), timeoutMs);

    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("message", (message) => {
      messages.push(message as ChildToParentMessage);
      if (
        message &&
        typeof message === "object" &&
        (message as ChildToParentMessage).type === "log" &&
        (message as { message?: string }).message?.includes("IOREDIS_BUNDLE_OK")
      ) {
        finish(child.exitCode);
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (timer) {
        finish(code);
      }
    });
  });
}

describe("bundled ioredis agent under child sandbox", () => {
  let miniRedis: MiniRedis | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    if (miniRedis) {
      await miniRedis.close();
      miniRedis = undefined;
    }
    if (tempDir) {
      rmSync(join(tempDir, "ioredis-bundle-agent.js"), { force: true });
      tempDir = undefined;
    }
  });

  it("loads bundle and connects via onAgentStart when allow-net includes redis host", async () => {
    miniRedis = await startMiniRedis();
    mkdirSync(TEST_TMP_DIR, { recursive: true });
    tempDir = TEST_TMP_DIR;
    const bundlePath = join(TEST_TMP_DIR, "ioredis-bundle-agent.js");

    await buildAgentBundle({
      cwd: AGENT_ROOT,
      entry: "test/fixtures/ioredis-bundle-agent.ts",
      outfile: bundlePath,
    });

    const result = await runBundledIoredisAgent({
      bundlePath,
      port: miniRedis.port,
    });

    const logs = result.messages
      .filter((message) => message.type === "log")
      .map((message) => message.message);
    const errors = result.messages
      .filter((message) => message.type === "agent_error")
      .map((message) => message.message);

    expect(errors).toEqual([]);
    expect(result.exitCode).toBeNull();
    expect(logs.some((line) => line.includes("IOREDIS_BUNDLE_OK"))).toBe(true);
    expect(errors.join("\n")).not.toMatch(
      /Bundle load failed.*Dynamic require/,
    );
  }, 20_000);
});
