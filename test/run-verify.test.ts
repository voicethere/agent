import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runAgentVerify } from "../src/verify/run-verify.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GAME_STATIC_FIXTURE = join(__dirname, "fixtures/game-agent-static.mjs");
const WEBHOOK_ONLY_FIXTURE = join(__dirname, "fixtures/webhook-only-agent.mjs");
const SESSION_START_ONLY_FIXTURE = join(
  __dirname,
  "fixtures/session-start-only-agent.mjs",
);
const NO_VERIFY_CALLBACKS_FIXTURE = join(
  __dirname,
  "fixtures/no-verify-callbacks-agent.mjs",
);
const ECHO_FIXTURE = join(__dirname, "fixtures/echo-agent.mjs");
const BUILT_BUNDLE = join(__dirname, "../dist/agent.js");

describe("runAgentVerify", () => {
  it("passes all checks for game/data-only static callback fixture", async () => {
    const result = await runAgentVerify({
      bundlePath: GAME_STATIC_FIXTURE,
      noBuild: true,
      quiet: true,
    });

    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.ok)).toBe(true);
  });

  it("passes all checks for built example bundle", async () => {
    const result = await runAgentVerify({
      bundlePath: BUILT_BUNDLE,
      noBuild: true,
      quiet: true,
    });

    expect(result.ok).toBe(true);
  });

  it("fails when bundle is missing", async () => {
    const result = await runAgentVerify({
      bundlePath: "does-not-exist/agent.js",
      noBuild: true,
      quiet: true,
    });

    expect(result.ok).toBe(false);
    expect(result.checks.some((check) => check.name === "Bundle present")).toBe(
      true,
    );
  });

  it("fails when bundle does not register defineAgent callbacks", async () => {
    const result = await runAgentVerify({
      bundlePath: ECHO_FIXTURE,
      noBuild: true,
      quiet: true,
    });

    expect(result.ok).toBe(false);
    expect(
      result.checks.some((check) => check.name === "Agent registration"),
    ).toBe(true);
  });

  it("passes for webhook-only bundle fixture", async () => {
    const result = await runAgentVerify({
      bundlePath: WEBHOOK_ONLY_FIXTURE,
      noBuild: true,
      quiet: true,
    });

    expect(result.ok).toBe(true);
    expect(
      result.checks.some(
        (check) =>
          check.name === "Bundle callbacks" && check.detail === "onWebhook",
      ),
    ).toBe(true);
  });

  it("passes for session-start-only bundle fixture", async () => {
    const result = await runAgentVerify({
      bundlePath: SESSION_START_ONLY_FIXTURE,
      noBuild: true,
      quiet: true,
    });

    expect(result.ok).toBe(true);
    expect(
      result.checks.some(
        (check) =>
          check.name === "Bundle callbacks" &&
          check.detail === "onSessionStart",
      ),
    ).toBe(true);
  });

  it("fails when bundle has no allowed verify callbacks", async () => {
    const result = await runAgentVerify({
      bundlePath: NO_VERIFY_CALLBACKS_FIXTURE,
      noBuild: true,
      quiet: true,
    });

    expect(result.ok).toBe(false);
    expect(
      result.checks.some((check) => check.name === "Bundle callbacks"),
    ).toBe(true);
  });
});
