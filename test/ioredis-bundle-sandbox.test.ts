import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { buildAgentBundle } from "../src/build-bundle.js";
import { buildChildExecArgv } from "../src/sandbox/sandbox.js";
import type { ChildToParentMessage } from "../src/protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = join(__dirname, "..");
const SANDBOX_DIR = join(AGENT_ROOT, "src/sandbox");
const LOADER = join(SANDBOX_DIR, "loader-entry.js");
const TEST_TMP_DIR = join(AGENT_ROOT, "test", ".tmp");

/** Minimal RESP mock — enough for ioredis connect + PING with enableReadyCheck:false. */
function startMiniRedis(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const upper = buf.toUpperCase();
        if (upper.includes("PING")) {
          socket.write("+PONG\r\n");
          buf = "";
        } else if (upper.includes("INFO")) {
          const body = "# Server\r\nredis_version:7.0.0\r\n";
          socket.write(`$${Buffer.byteLength(body)}\r\n${body}\r\n`);
          buf = "";
        } else if (
          upper.includes("AUTH") ||
          upper.includes("SELECT") ||
          upper.includes("CLIENT") ||
          upper.includes("QUIT")
        ) {
          socket.write("+OK\r\n");
          buf = "";
        } else if (upper.includes("HELLO")) {
          socket.write("-ERR unknown command\r\n");
          buf = "";
        } else if (buf.length > 8192) {
          socket.write("+OK\r\n");
          buf = "";
        }
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to bind mini redis"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

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
      child.kill("SIGTERM");
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
  let server: Server | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    if (tempDir) {
      rmSync(join(tempDir, "ioredis-bundle-agent.js"), { force: true });
      tempDir = undefined;
    }
  });

  it("loads bundle and connects via onAgentStart when allow-net includes redis host", async () => {
    const mini = await startMiniRedis();
    server = mini.server;
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
      port: mini.port,
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
    expect(errors.join("\n")).not.toMatch(/Bundle load failed.*Dynamic require/);
  }, 20_000);
});
