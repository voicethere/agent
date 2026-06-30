import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runAgentVerifyStart } from "../src/verify/run-verify-start.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILT_BUNDLE = join(__dirname, "../dist/agent.js");
const ECHO_FIXTURE = join(__dirname, "fixtures/echo-agent.mjs");

describe("runAgentVerifyStart", () => {
  it("passes when bundle starts in sandbox and acks session_start", async () => {
    const result = await runAgentVerifyStart({
      bundlePath: BUILT_BUNDLE,
      quiet: true,
    });

    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.ok)).toBe(true);
  });

  it("fails when bundle is missing", async () => {
    const result = await runAgentVerifyStart({
      bundlePath: "does-not-exist/agent.js",
      quiet: true,
    });

    expect(result.ok).toBe(false);
    expect(result.checks.some((check) => check.name === "Bundle present")).toBe(
      true,
    );
  });

  it("fails when bundle does not ack session_start in sandbox", async () => {
    const result = await runAgentVerifyStart({
      bundlePath: ECHO_FIXTURE,
      quiet: true,
    });

    expect(result.ok).toBe(false);
    expect(result.checks.some((check) => check.name === "Bundle startup")).toBe(
      true,
    );
  });
});
