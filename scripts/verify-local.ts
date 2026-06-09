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

import type { ChildToParentMessage } from "../src/protocol.js";
import {
  VERIFY_SESSION_ID,
  parseBundleArg,
  waitForSpeak,
} from "./verify-local-lib.js";
import { startSandboxedChild } from "./sandbox/start-child.js";

const READY_MS = 300;
const SPEAK_TIMEOUT_MS = 5000;

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
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
    sessionId: VERIFY_SESSION_ID,
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
    sessionId: VERIFY_SESSION_ID,
    env: {
      SESSION_ID: VERIFY_SESSION_ID,
      PROJECT_ID: "local",
      BUILD_ID: "verify",
    },
  });

  await delay(READY_MS);

  child.send({
    type: "speech_event",
    sessionId: VERIFY_SESSION_ID,
    event: { type: "user_speech_final", text: "hello from verify local" },
  });

  try {
    const speak = await waitForSpeak(
      childMessages,
      VERIFY_SESSION_ID,
      SPEAK_TIMEOUT_MS,
    );
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

  child.send({ type: "session_end", sessionId: VERIFY_SESSION_ID });
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
