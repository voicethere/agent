import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { AgentLogMessage, NodeWarningMessage } from "../src/protocol.js";
import { buildChildExecArgv } from "../src/sandbox/sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SANDBOX_DIR = join(__dirname, "../src/sandbox");
const LOADER = join(SANDBOX_DIR, "loader-entry.js");
const WARNING_FORWARDER = join(SANDBOX_DIR, "warning-forwarder.cjs");
const PROBE = join(__dirname, "fixtures/node-warning-probe.mjs");

interface ProbeResult {
  exitCode: number | null;
  stderr: string;
  warnings: NodeWarningMessage[];
  logs: AgentLogMessage[];
}

function runProbe(stripWarningFlags: boolean): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    let execArgv = buildChildExecArgv({
      loaderDir: SANDBOX_DIR,
      bundlePath: PROBE,
      warningForwarderPath: WARNING_FORWARDER,
    });
    if (stripWarningFlags) {
      execArgv = execArgv.filter(
        (arg) => arg !== "--no-warnings" && !arg.startsWith("--require="),
      );
    }
    const stderrChunks: Buffer[] = [];
    const warnings: NodeWarningMessage[] = [];
    const logs: AgentLogMessage[] = [];
    const child = fork(LOADER, [], {
      env: {
        NODE_ENV: "production",
        __CHILD_BUNDLE_PATH__: PROBE,
        SESSION_ID: "warn-session",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      execArgv,
      serialization: "advanced",
    });
    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("message", (message: unknown) => {
      const m = message as { type?: string };
      if (m?.type === "node_warning") warnings.push(m as NodeWarningMessage);
      if (m?.type === "log") logs.push(m as AgentLogMessage);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({
        exitCode: code,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        warnings,
        logs,
      });
    });
  });
}

describe("node warning forwarder (real sandboxed child)", () => {
  it("forwards every warning over IPC and keeps stderr free of warning text", async () => {
    const result = await runProbe(false);
    expect(result.exitCode).toBe(0);

    const find = (name: string, code?: string) =>
      result.warnings.filter(
        (w) => w.name === name && (code === undefined || w.code === code),
      );

    // bootstrap flag warning (only visible to a --require preload)
    expect(
      result.warnings.some(
        (w) =>
          w.name === "ExperimentalWarning" &&
          /--allow-net/.test(w.message) &&
          w.messageLength === w.message.length,
      ),
    ).toBe(true);
    expect(find("ExperimentalWarning").some((w) => w.message === "cust")).toBe(
      true,
    );
    expect(find("DeprecationWarning", "DEP9999")).toHaveLength(1);
    expect(find("MaxListenersExceededWarning")).toHaveLength(1);
    expect(find("DeprecationWarning", "DEP0005")).toHaveLength(1);

    expect(result.stderr).toContain("raw boom");
    expect(result.stderr).not.toMatch(
      /Warning|DEP\d{4}|--allow-net|MaxListeners|\(node:/,
    );

    const boom = result.logs.find((l) => l.message === "boom");
    expect(boom).toMatchObject({ type: "log", level: "error" });

    const calls = result.logs.find((l) =>
      l.message.startsWith("customer-listener-calls:"),
    );
    expect(Number(calls?.message.split(":")[1])).toBeGreaterThanOrEqual(4);
  }, 15_000);

  it("fails without --no-warnings and the --require preload", async () => {
    const result = await runProbe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.stderr).toMatch(/Warning/);
  }, 15_000);
});
