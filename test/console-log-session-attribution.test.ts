import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildAgentBundle } from "../src/build-bundle.js";
import type { AgentLogMessage } from "../src/protocol.js";
import { buildChildExecArgv } from "../src/sandbox/sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = join(__dirname, "..");
const FIXTURES = join(__dirname, "fixtures");
const SANDBOX_DIR = join(AGENT_ROOT, "src/sandbox");
const LOADER = join(SANDBOX_DIR, "loader-entry.js");
const WARNING_FORWARDER = join(SANDBOX_DIR, "warning-forwarder.cjs");
const TMP_DIR = join(AGENT_ROOT, "test", ".tmp", "console-attribution");
const BUNDLE = join(TMP_DIR, "console-attribution-agent.js");
const OLD_RUNTIME_BUNDLE = join(
  FIXTURES,
  "console-attribution-old-runtime.mjs",
);
const POD_ID = "runner-bridge-pod-0";
const WAIT_MS = 15_000;

function startChild(bundlePath: string): {
  child: ChildProcess;
  logs: AgentLogMessage[];
} {
  const logs: AgentLogMessage[] = [];
  const child = fork(LOADER, [], {
    env: {
      NODE_ENV: "production",
      __CHILD_BUNDLE_PATH__: bundlePath,
      SESSION_ID: POD_ID,
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    execArgv: buildChildExecArgv({
      loaderDir: SANDBOX_DIR,
      warningForwarderPath: WARNING_FORWARDER,
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
  return { child, logs };
}

async function waitForLogs(
  logs: AgentLogMessage[],
  messages: string[],
  label: string,
): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (messages.every((m) => logs.some((l) => l.message === m))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `${label}: timed out waiting for ${messages.join(", ")}; got ${logs
      .map((l) => l.message)
      .join(", ")}`,
  );
}

function sessionStart(sessionId: string) {
  return { type: "session_start", sessionId, env: { SESSION_ID: sessionId } };
}

describe("console.* session attribution", () => {
  beforeAll(async () => {
    mkdirSync(TMP_DIR, { recursive: true });
    await buildAgentBundle({
      cwd: AGENT_ROOT,
      entry: "test/fixtures/console-attribution-agent.ts",
      outfile: BUNDLE,
    });
  }, 30_000);

  afterAll(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("attributes each line to the session whose handler produced it", async () => {
    const { child, logs } = startChild(BUNDLE);
    try {
      await waitForLogs(logs, ["attr-module"], "module load");
      child.send(sessionStart("A"));
      await waitForLogs(logs, ["A-1"], "session A start");
      child.send(sessionStart("B"));
      await waitForLogs(logs, ["A-2", "A-timer", "B-1"], "interleave");
    } finally {
      child.kill("SIGKILL");
    }

    const byMessage = new Map(logs.map((l) => [l.message, l]));
    expect(byMessage.get("attr-module")?.sessionId).toBeUndefined();
    expect(byMessage.get("A-1")?.sessionId).toBe("A");
    expect(byMessage.get("A-2")?.sessionId).toBe("A");
    expect(byMessage.get("A-timer")?.sessionId).toBe("A");
    expect(byMessage.get("B-1")?.sessionId).toBe("B");

    const order = logs.map((l) => l.message);
    expect(order.indexOf("B-1")).toBeLessThan(order.indexOf("A-2"));
    expect(logs.some((l) => l.sessionId === POD_ID)).toBe(false);
  }, 30_000);

  it("sends no session for a bundle without the runtime getter", async () => {
    const { child, logs } = startChild(OLD_RUNTIME_BUNDLE);
    try {
      await waitForLogs(logs, ["old-module"], "old module load");
      child.send(sessionStart("A"));
      await waitForLogs(logs, ["old-handler"], "old handler");
    } finally {
      child.kill("SIGKILL");
    }
    expect(logs.every((l) => l.sessionId === undefined)).toBe(true);
  }, 30_000);
});
