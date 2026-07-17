import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildAgentBundle } from "../build-bundle.js";
import {
  detectVerifyCallbacks,
  hasDefineAgentRegistration,
  parseBundleArg,
} from "./lib.js";

const MIN_NODE_MAJOR = 26;

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
      `Node ${MIN_NODE_MAJOR}+ required; found ${process.version}`,
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

  const bundleSource = readFileSync(resolvedBundle, "utf8");
  if (!hasDefineAgentRegistration(bundleSource)) {
    return failCheck(
      checks,
      "Agent registration",
      "Bundle must register handlers with defineAgent(...)",
    );
  }
  checks.push({
    name: "Agent registration",
    ok: true,
    detail: "defineAgent(...) detected",
  });
  logLine(quiet, "✓ Agent registration (defineAgent)");

  const callbacks = detectVerifyCallbacks(bundleSource);
  if (callbacks.length === 0) {
    return failCheck(
      checks,
      "Bundle callbacks",
      "Expected at least one handler: onSpeechEvent, onUserSpeechFinal, onDataChannelMessage, or onDataChannelBinary",
    );
  }
  checks.push({
    name: "Bundle callbacks",
    ok: true,
    detail: callbacks.join(", "),
  });
  logLine(quiet, `✓ Bundle callbacks (${callbacks.join(", ")})`);

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
