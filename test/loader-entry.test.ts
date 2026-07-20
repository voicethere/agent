import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildChildExecArgv } from "../src/sandbox/sandbox.js";
import type { AgentLogMessage } from "../src/protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");
const SANDBOX_DIR = join(__dirname, "../src/sandbox");
const LOADER = join(SANDBOX_DIR, "loader-entry.js");

function runConsoleLogProbe(): Promise<{
  exitCode: number | null;
  logs: AgentLogMessage[];
}> {
  return new Promise((resolve, reject) => {
    const bundlePath = join(FIXTURES, "console-log-probe.mjs");
    const logs: AgentLogMessage[] = [];
    const child = fork(LOADER, [], {
      env: {
        NODE_ENV: "production",
        __CHILD_BUNDLE_PATH__: bundlePath,
        SESSION_ID: "probe-session",
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: buildChildExecArgv({
        loaderDir: SANDBOX_DIR,
        bundlePath,
      }),
    });

    child.on("message", (message) => {
      if (
        message &&
        typeof message === "object" &&
        (message as AgentLogMessage).type === "log"
      ) {
        logs.push(message as AgentLogMessage);
      }
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ exitCode: code, logs });
    });
  });
}

describe("loader-entry console overrides", () => {
  it("maps console levels and structured first-arg objects", async () => {
    const { exitCode, logs } = await runConsoleLogProbe();
    expect(exitCode).toBe(0);

    const byMessage = new Map(logs.map((entry) => [entry.message, entry]));

    expect(byMessage.get("plain-info")).toMatchObject({
      type: "log",
      level: "info",
      sessionId: "probe-session",
      ts: expect.any(Number),
    });
    expect(byMessage.get("plain-debug")).toMatchObject({
      level: "debug",
    });
    expect(byMessage.get("plain-warn")).toMatchObject({
      level: "warn",
    });
    expect(byMessage.get("plain-error")).toMatchObject({
      level: "error",
    });
    expect(byMessage.get("structured")).toMatchObject({
      level: "info",
      fields: { key: "value" },
    });
  }, 10_000);
});
