import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { buildAgentBundle } from "../build-bundle.js";
import type { ChildToParentMessage } from "../protocol.js";
import { startSandboxedChild } from "../sandbox/start-child.js";
import {
  VERIFY_SESSION_ID,
  parseBundleArg,
  waitForSpeak,
} from "./lib.js";

const READY_MS = 300;
const SPEAK_TIMEOUT_MS = 5000;
const MIN_NODE_MAJOR = 22;

export interface VerifyAgentOptions {
  cwd?: string;
  entry?: string;
  outfile?: string;
  bundlePath?: string;
  /** When true, skip the build step and verify an existing bundle only. */
  noBuild?: boolean;
  /** When true, suppress per-check log lines (for tests). */
  quiet?: boolean;
}

export interface VerifyCheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerifyAgentResult {
  ok: boolean;
  checks: VerifyCheckResult[];
  bundlePath: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

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

export async function runAgentVerify(
  options: VerifyAgentOptions = {},
): Promise<VerifyAgentResult> {
  const cwd = options.cwd ?? process.cwd();
  const checks: VerifyCheckResult[] = [];
  const quiet = options.quiet;
  const entry = options.entry ?? "agent.ts";
  const outfile = options.outfile ?? "dist/agent.js";
  const bundlePath =
    options.bundlePath ??
    parseBundleArg([], process.env, cwd);

  logLine(quiet, "[@voicethere/agent verify]");

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
    return failCheck(
      checks,
      "Node.js version",
      `Node ${MIN_NODE_MAJOR}+ required (--permission sandbox); found ${process.version}`,
    );
  }
  checks.push({
    name: "Node.js version",
    ok: true,
    detail: process.version,
  });
  logLine(quiet, `✓ Node.js ${process.version}`);

  if (!options.noBuild) {
    try {
      await buildAgentBundle({ cwd, entry, outfile });
      checks.push({
        name: "Build bundle",
        ok: true,
        detail: `${outfile} from ${entry}`,
      });
      logLine(quiet, `✓ Built ${outfile} from ${entry}`);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : String(error);
      return failCheck(checks, "Build bundle", detail);
    }
  } else {
    checks.push({
      name: "Build bundle",
      ok: true,
      detail: "skipped (--no-build)",
    });
    logLine(quiet, "○ Build bundle (skipped)");
  }

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

  checks.push({
    name: "Sandbox spawn",
    ok: true,
    detail: `pid ${child.pid}`,
  });
  logLine(quiet, `✓ Sandbox spawn (pid ${child.pid})`);

  child.onMessage((message) => {
    childMessages.push(message);
    if (message.type === "log" && !quiet) {
      process.stdout.write(`[child ${message.level}] ${message.message}\n`);
    }
    if (message.type === "agent_error") {
      childError = message.message;
    }
    if (message.type === "speak" && !quiet) {
      process.stdout.write(`[child speak] ${message.text}\n`);
    }
  });

  const exitPromise = new Promise<number | null>((resolveExit) => {
    child.onExit((code) => {
      earlyExitCode = code;
      resolveExit(code);
    });
  });

  child.send({
    type: "session_start",
    sessionId: VERIFY_SESSION_ID,
    env: {
      SESSION_ID: VERIFY_SESSION_ID,
      PROJECT_ID: "local",
      BUILD_ID: "verify",
    },
  });

  await delay(READY_MS);

  if (earlyExitCode !== undefined) {
    return failCheck(
      checks,
      "Bundle load",
      `Child exited early with code ${earlyExitCode ?? "null"}`,
    );
  }

  checks.push({ name: "Bundle load", ok: true });
  logLine(quiet, "✓ Bundle load");

  child.send({
    type: "speech_event",
    sessionId: VERIFY_SESSION_ID,
    event: { type: "user_speech_final", text: "hello from verify" },
  });

  try {
    const speak = await waitForSpeak(
      childMessages,
      VERIFY_SESSION_ID,
      SPEAK_TIMEOUT_MS,
    );
    if (!speak.text.trim()) {
      return failCheck(
        checks,
        "Speech response",
        "Child returned empty speak text for user_speech_final",
      );
    }
    checks.push({
      name: "Speech response",
      ok: true,
      detail: speak.text.trim(),
    });
    logLine(quiet, `✓ Speech response (${speak.text.trim()})`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    child.kill("SIGTERM");
    await exitPromise;
    return failCheck(checks, "Speech response", detail);
  }

  if (childError) {
    child.kill("SIGTERM");
    await exitPromise;
    return failCheck(checks, "No agent errors", childError);
  }

  checks.push({ name: "No agent errors", ok: true });
  logLine(quiet, "✓ No agent errors");

  child.send({ type: "session_end", sessionId: VERIFY_SESSION_ID });
  child.kill("SIGTERM");
  await exitPromise;

  logLine(quiet, "[@voicethere/agent verify] All checks passed.");

  return { ok: true, checks, bundlePath: resolvedBundle };
}

export function formatVerifyFailure(result: VerifyAgentResult): string {
  const failed = result.checks.filter((check) => !check.ok);
  if (failed.length === 0) {
    return "Verify failed";
  }
  return failed
    .map((check) => `${check.name}: ${check.detail ?? "failed"}`)
    .join("; ");
}
