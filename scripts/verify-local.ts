#!/usr/bin/env node
/**
 * Local sandbox smoke — fork your agent bundle like voicethere/runner does.
 *
 * Usage:
 *   npm run verify:local
 *   AGENT_BUNDLE_PATH=./dist/agent.js npm run verify:local:only
 *   npm run verify:local -- --bundle ./dist/agent.js
 *
 * Requires Node 22+ (--permission). Does not run WebRTC; use voicethere/runner for voice E2E.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { ChildToParentMessage } from "../src/protocol.js";
import { startSandboxedChild } from "./sandbox/start-child.js";

const SESSION_ID = "local-verify";
const DEFAULT_BUNDLE = resolve("dist/agent.js");
const READY_MS = 300;
const SPEAK_TIMEOUT_MS = 5000;

function parseBundleArg(argv: string[]): string {
  const flagIndex = argv.indexOf("--bundle");
  if (flagIndex >= 0 && argv[flagIndex + 1]) {
    return resolve(argv[flagIndex + 1]);
  }
  if (process.env.AGENT_BUNDLE_PATH?.trim()) {
    return resolve(process.env.AGENT_BUNDLE_PATH.trim());
  }
  return DEFAULT_BUNDLE;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function waitForSpeak(
  messages: ChildToParentMessage[],
  timeoutMs: number,
): Promise<Extract<ChildToParentMessage, { type: "speak" }>> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const speak = messages.find(
        (m): m is Extract<ChildToParentMessage, { type: "speak" }> => {
          return m.type === "speak" && m.sessionId === SESSION_ID;
        },
      );
      if (speak) {
        clearInterval(timer);
        resolvePromise(speak);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for child speak IPC`,
          ),
        );
      }
    }, 50);
  });
}

async function main(): Promise<void> {
  const bundlePath = parseBundleArg(process.argv.slice(2));
  if (!existsSync(bundlePath)) {
    console.error(`[verify:local] Bundle not found: ${bundlePath}`);
    console.error(
      "[verify:local] Run `npm run build` first or set AGENT_BUNDLE_PATH.",
    );
    process.exit(1);
  }

  const childMessages: ChildToParentMessage[] = [];
  let childError: string | undefined;

  console.log(`[verify:local] bundle=${bundlePath}`);

  const child = startSandboxedChild({
    sessionId: SESSION_ID,
    bundlePath,
    onStderr: (message) => console.error(`[child stderr] ${message}`),
  });

  child.onMessage((message) => {
    childMessages.push(message);
    if (message.type === "log") {
      console.log(`[child ${message.level}] ${message.message}`);
    }
    if (message.type === "agent_error") {
      childError = message.message;
    }
    if (message.type === "speak") {
      console.log(`[child speak] ${message.text}`);
    }
  });

  const exitPromise = new Promise<number | null>((resolveExit) => {
    child.onExit((code) => resolveExit(code));
  });

  child.send({
    type: "session_start",
    sessionId: SESSION_ID,
    env: { SESSION_ID, PROJECT_ID: "local", BUILD_ID: "verify" },
  });

  await delay(READY_MS);

  child.send({
    type: "speech_event",
    sessionId: SESSION_ID,
    event: { type: "user_speech_final", text: "hello from verify local" },
  });

  try {
    const speak = await waitForSpeak(childMessages, SPEAK_TIMEOUT_MS);
    if (!speak.text.trim()) {
      throw new Error("Child returned empty speak text");
    }
  } catch (error) {
    console.error(
      `[verify:local] FAIL: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (childError) console.error(`[verify:local] agent_error: ${childError}`);
    child.kill("SIGTERM");
    await exitPromise;
    process.exit(1);
  }

  if (childError) {
    console.error(`[verify:local] FAIL: agent_error: ${childError}`);
    child.kill("SIGTERM");
    await exitPromise;
    process.exit(1);
  }

  child.send({ type: "session_end", sessionId: SESSION_ID });
  child.kill("SIGTERM");
  await exitPromise;

  console.log(
    "[verify:local] OK — bundle loaded in sandbox and responded to user_speech_final",
  );
}

main().catch((error) => {
  console.error(
    `[verify:local] FAIL: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
