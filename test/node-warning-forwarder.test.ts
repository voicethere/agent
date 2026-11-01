import { fork, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { AgentLogMessage, NodeWarningMessage } from "../src/protocol.js";
import { buildChildExecArgv } from "../src/sandbox/sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SANDBOX_DIR = join(__dirname, "../src/sandbox");
const LOADER = join(SANDBOX_DIR, "loader-entry.js");
const WARNING_FORWARDER = join(SANDBOX_DIR, "warning-forwarder.cjs");
const DISCONNECT_PROBE = join(
  __dirname,
  "fixtures/disconnect-warning-probe.cjs",
);
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

  it("truncates message to 2048 and stack to 4096, keeps full messageLength", async () => {
    const result = await runProbe(false);
    const cap = result.warnings.find((w) => w.name === "CapWarning");
    expect(cap).toBeDefined();
    expect(cap!.message.length).toBe(2048);
    expect(cap!.messageLength).toBe(5000);
    expect(cap!.stack).toBeDefined();
    expect(cap!.stack!.length).toBeLessThanOrEqual(4096);
  }, 15_000);

  it("drops warnings silently when IPC is missing or disconnected", async () => {
    const forwarder = realpathSync(WARNING_FORWARDER);
    const execArgv = ["--no-warnings", `--require=${forwarder}`];

    // (a) no IPC channel at all
    const a = await new Promise<{ code: number | null; stderr: string }>(
      (resolve, reject) => {
        const chunks: Buffer[] = [];
        const child = spawn(
          process.execPath,
          [...execArgv, "-e", "process.emitWarning('x')"],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        child.stderr?.on("data", (c) => chunks.push(Buffer.from(c)));
        child.on("error", reject);
        child.on("exit", (code) =>
          resolve({ code, stderr: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    expect(a.code).toBe(0);
    expect(a.stderr).toBe("");

    // (b) IPC channel disconnected before the warning
    const b = await new Promise<{
      code: number | null;
      stderr: string;
      warnings: number;
    }>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let warnings = 0;
      const child = fork(DISCONNECT_PROBE, [], {
        execArgv,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      child.stderr?.on("data", (c) => chunks.push(Buffer.from(c)));
      child.on("message", (m: unknown) => {
        if ((m as { type?: string })?.type === "node_warning") warnings += 1;
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        resolve({
          code,
          stderr: Buffer.concat(chunks).toString("utf8"),
          warnings,
        }),
      );
    });
    expect(b.code).toBe(0);
    expect(b.stderr).toBe("");
    expect(b.warnings).toBe(0);
  }, 15_000);
});
