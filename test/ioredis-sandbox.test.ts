import { fork } from "node:child_process";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { buildChildExecArgv } from "../src/sandbox/sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = join(__dirname, "..");
const FIXTURES = join(__dirname, "fixtures");
const SANDBOX_DIR = join(__dirname, "../src/sandbox");
const LOADER = join(SANDBOX_DIR, "loader-entry.js");
const IOREDIS_PROBE = join(FIXTURES, "ioredis-probe.mjs");
const NODE_MODULES = join(AGENT_ROOT, "node_modules");

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

function runIoredisProbe(options: {
  port: number;
  allowInternet?: boolean;
  allowNetHosts?: string[];
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
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
    const child = fork(LOADER, [], {
      env: {
        NODE_ENV: "production",
        __CHILD_BUNDLE_PATH__: IOREDIS_PROBE,
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: String(options.port),
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

describe("ioredis under child sandbox", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("connects with ioredis when allow-net includes the redis host", async () => {
    const mini = await startMiniRedis();
    server = mini.server;

    const result = await runIoredisProbe({
      port: mini.port,
      allowNetHosts: [`127.0.0.1:${mini.port}`],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("IOREDIS_OK");
  }, 15_000);

  it("fails to connect when allow-net is not granted", async () => {
    const mini = await startMiniRedis();
    server = mini.server;

    const result = await runIoredisProbe({
      port: mini.port,
      allowInternet: false,
    });

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /ERR_ACCESS_DENIED|AccessDenied|IOREDIS_FAIL/,
    );
  }, 15_000);
});
