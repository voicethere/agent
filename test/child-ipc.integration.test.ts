import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { defineAgent, speak } from "../src/runtime.js";
import { startSandboxedChild } from "../scripts/sandbox/start-child.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");
const BUILT_BUNDLE = join(__dirname, "../dist/agent.js");

async function waitForAssertion(
  assertion: () => void,
  timeoutMs = 5000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assertion();
}

describe("forked child IPC", () => {
  it("echo fixture speaks on user_speech_final", async () => {
    const child = startSandboxedChild({
      sessionId: "runtime-peer",
      bundlePath: join(FIXTURES, "echo-agent.mjs"),
    });

    const speaks: string[] = [];
    const exitPromise = new Promise<number | null>((resolve) => {
      child.onExit((code) => resolve(code));
    });

    child.onMessage((message) => {
      if (message.type === "speak") speaks.push(message.text);
    });

    child.send({
      type: "speech_event",
      sessionId: "runtime-peer",
      event: { type: "user_speech_final", text: "ping" },
    });

    await waitForAssertion(() => {
      expect(speaks).toContain("echo:ping");
    });

    child.kill("SIGTERM");
    await exitPromise;
  }, 10_000);

  it.skipIf(!existsSync(BUILT_BUNDLE))(
    "built dist/agent.js responds under sandbox",
    async () => {
      const child = startSandboxedChild({
        sessionId: "built-peer",
        bundlePath: BUILT_BUNDLE,
      });

      const speaks: string[] = [];
      const errors: string[] = [];
      const exitPromise = new Promise<number | null>((resolve) => {
        child.onExit((code) => resolve(code));
      });

      child.onMessage((message) => {
        if (message.type === "speak") speaks.push(message.text);
        if (message.type === "agent_error") errors.push(message.message);
      });

      child.send({
        type: "session_start",
        sessionId: "built-peer",
        env: { SESSION_ID: "built-peer" },
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      child.send({
        type: "speech_event",
        sessionId: "built-peer",
        event: { type: "user_speech_final", text: "integration test" },
      });

      await waitForAssertion(() => {
        expect(errors).toHaveLength(0);
        expect(speaks.some((text) => text.trim().length > 0)).toBe(true);
      });

      child.kill("SIGTERM");
      await exitPromise;
    },
    15_000,
  );
});

describe("runtime exports", () => {
  it("exports defineAgent and speak as functions", () => {
    expect(typeof defineAgent).toBe("function");
    expect(typeof speak).toBe("function");
  });
});
