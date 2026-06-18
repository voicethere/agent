import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  resolveBundlePath,
  startSandboxedChild,
} from "../src/sandbox/start-child.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ECHO_FIXTURE = join(__dirname, "fixtures/echo-agent.mjs");

async function waitForAssertion(
  assertion: () => void,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  assertion();
}

describe("resolveBundlePath", () => {
  let tempFile: string | undefined;

  afterEach(() => {
    if (tempFile && existsSync(tempFile)) unlinkSync(tempFile);
    tempFile = undefined;
  });

  it("throws when bundle file is missing", () => {
    expect(() => resolveBundlePath("/no/such/agent.js")).toThrow(
      /Bundle not found/,
    );
  });

  it("resolves an existing bundle path", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "agent-bundle-"));
    tempFile = join(tempDir, "agent.mjs");
    writeFileSync(tempFile, "export {};\n");
    expect(resolveBundlePath(tempFile)).toBe(realpathSync(tempFile));
  });

  it("trims whitespace in bundle path", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "agent-bundle-"));
    tempFile = join(tempDir, "agent.mjs");
    writeFileSync(tempFile, "export {};\n");
    expect(resolveBundlePath(`  ${tempFile}  `)).toBe(realpathSync(tempFile));
  });

  it("returns realpath for symlinked bundle (var/run → run on Linux)", () => {
    const root = join(tmpdir(), `agent-bundle-symlink-${process.pid}`);
    const realDir = join(root, "run", "runner");
    const linkDir = join(root, "var", "run", "runner");
    mkdirSync(realDir, { recursive: true });
    mkdirSync(join(root, "var", "run"), { recursive: true });
    tempFile = join(realDir, "bundle.js");
    writeFileSync(tempFile, "export {};\n");
    symlinkSync(realDir, linkDir, "dir");

    const viaSymlink = join(linkDir, "bundle.js");
    expect(resolveBundlePath(viaSymlink)).toBe(realpathSync(tempFile));
  });
});

describe("startSandboxedChild IPC", () => {
  it("loads fixture bundle and echoes user_speech_final via speak IPC", async () => {
    const child = startSandboxedChild({
      sessionId: "test-peer",
      bundlePath: ECHO_FIXTURE,
      projectId: "proj-1",
      buildId: "build-1",
    });

    const messages: Array<{ type: string; text?: string; message?: string }> =
      [];
    const exitPromise = new Promise<number | null>((resolve) => {
      child.onExit((code) => resolve(code));
    });

    child.onMessage((message) => {
      messages.push(message);
    });

    child.send({
      type: "session_start",
      sessionId: "test-peer",
      env: { SESSION_ID: "test-peer" },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    child.send({
      type: "speech_event",
      sessionId: "test-peer",
      event: { type: "user_speech_final", text: "hello sandbox" },
    });

    await waitForAssertion(() => {
      const speak = messages.find((m) => m.type === "speak");
      expect(speak?.text).toBe("echo:hello sandbox");
    });

    const started = messages.find(
      (m) => m.type === "log" && m.message === "started:test-peer",
    );
    expect(started).toBeDefined();

    child.kill("SIGTERM");
    await exitPromise;
  }, 10_000);

  it("returns false from send when child is disconnected", async () => {
    const child = startSandboxedChild({
      sessionId: "disconnect-peer",
      bundlePath: ECHO_FIXTURE,
    });

    const exitPromise = new Promise<number | null>((resolve) => {
      child.onExit((code) => resolve(code));
    });

    child.kill("SIGKILL");
    await exitPromise;

    expect(
      child.send({
        type: "session_start",
        sessionId: "disconnect-peer",
        env: {},
      }),
    ).toBe(false);
  }, 10_000);
});
