import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { ChildToParentMessage } from "../protocol.js";
import { startSandboxedChild } from "../sandbox/start-child.js";
import {
  VERIFY_SESSION_ID,
  parseBundleArg,
  waitForSessionStartAck,
} from "./lib.js";
import type {
  VerifyAgentOptions,
  VerifyAgentResult,
  VerifyCheckResult,
} from "./run-verify.js";

const START_TIMEOUT_MS = 5000;
const MIN_NODE_MAJOR = 22;

function logLine(quiet: boolean | undefined, message: string): void {
  if (!quiet) {
    process.stdout.write(`${message}\n`);
  }
}

function failCheck(
  checks: VerifyCheckResult[],
  name: string,
  detail: string,
): VerifyAgentResult {
  checks.push({ name, ok: false, detail });
  return { ok: false, checks, bundlePath: "" };
}

export async function runAgentVerifyStart(
  options: VerifyAgentOptions = {},
): Promise<VerifyAgentResult> {
  const cwd = options.cwd ?? process.cwd();
  const checks: VerifyCheckResult[] = [];
  const quiet = options.quiet;
  const bundlePath =
    options.bundlePath ??
    parseBundleArg([], process.env, cwd);

  logLine(quiet, "[@voicethere/agent verify-start]");

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
    return failCheck(
      checks,
      "Node.js version",
      `Node ${MIN_NODE_MAJOR}+ required; found ${process.version}`,
    );
  }
  checks.push({
    name: "Node.js version",
    ok: true,
    detail: process.version,
  });
  logLine(quiet, `✓ Node.js ${process.version}`);

  const resolvedBundle = resolve(cwd, bundlePath);
  if (!existsSync(resolvedBundle)) {
    return failCheck(
      checks,
      "Bundle present",
      `Bundle not found: ${resolvedBundle}`,
    );
  }
  checks.push({
    name: "Bundle present",
    ok: true,
    detail: resolvedBundle,
  });
  logLine(quiet, `✓ Bundle present (${resolvedBundle})`);

  const childMessages: ChildToParentMessage[] = [];
  let childError: string | undefined;
  let earlyExitCode: number | null | undefined;

  let child: ReturnType<typeof startSandboxedChild>;
  try {
    child = startSandboxedChild({
      sessionId: VERIFY_SESSION_ID,
      bundlePath: resolvedBundle,
      onStderr: (message) => {
        if (!quiet) {
          process.stderr.write(`[child stderr] ${message}\n`);
        }
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failCheck(checks, "Sandbox spawn", detail);
  }

  const exitPromise = new Promise<number | null>((resolveExit) => {
    child.onExit((code) => {
      earlyExitCode = code;
      resolveExit(code);
    });
  });
  const stopChild = async (): Promise<void> => {
    child.kill("SIGTERM");
    await exitPromise;
  };

  checks.push({
    name: "Sandbox spawn",
    ok: true,
    detail: `pid ${child.pid}`,
  });
  logLine(quiet, `✓ Sandbox spawn (pid ${child.pid})`);

  const hasPermissionFlag = child.execArgv.includes("--permission");
  const hasReadAllowlist = child.execArgv.some((arg) =>
    arg.startsWith("--allow-fs-read="),
  );
  if (!hasPermissionFlag || !hasReadAllowlist) {
    await stopChild();
    return failCheck(
      checks,
      "Sandbox flags",
      `Expected --permission and --allow-fs-read flags; got: ${child.execArgv.join(" ")}`,
    );
  }
  checks.push({
    name: "Sandbox flags",
    ok: true,
    detail: child.execArgv.join(" "),
  });
  logLine(quiet, "✓ Sandbox flags");

  child.onMessage((message) => {
    childMessages.push(message);
    if (message.type === "agent_error") {
      childError = message.message;
    }
  });

  child.send({
    type: "session_start",
    sessionId: VERIFY_SESSION_ID,
    env: {
      SESSION_ID: VERIFY_SESSION_ID,
      PROJECT_ID: "local",
      BUILD_ID: "verify-start",
    },
  });

  try {
    await waitForSessionStartAck(
      childMessages,
      VERIFY_SESSION_ID,
      START_TIMEOUT_MS,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await stopChild();
    return failCheck(checks, "Bundle startup", detail);
  }

  if (earlyExitCode !== undefined) {
    await stopChild();
    return failCheck(
      checks,
      "Bundle startup",
      `Child exited early with code ${earlyExitCode ?? "null"}`,
    );
  }

  checks.push({ name: "Bundle startup", ok: true });
  logLine(quiet, "✓ Bundle startup");

  if (childError) {
    await stopChild();
    return failCheck(checks, "No agent errors", childError);
  }

  checks.push({ name: "No agent errors", ok: true });
  logLine(quiet, "✓ No agent errors");

  child.send({ type: "session_end", sessionId: VERIFY_SESSION_ID });
  await stopChild();

  logLine(quiet, "[@voicethere/agent verify-start] All checks passed.");
  return { ok: true, checks, bundlePath: resolvedBundle };
}
