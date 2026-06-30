import { resolve } from "node:path";

import type { ChildToParentMessage } from "../protocol.js";

export const VERIFY_SESSION_ID = "local-verify";
export const DEFAULT_VERIFY_BUNDLE = "dist/agent.js";
export const DEFAULT_VERIFY_ENTRY = "agent.ts";
export const VERIFY_CALLBACK_KEYS = [
  "onSpeechEvent",
  "onUserSpeechFinal",
  "onDataChannelMessage",
  "onDataChannelBinary",
] as const;
export type VerifyCallbackKey = (typeof VERIFY_CALLBACK_KEYS)[number];

export function parseBundleArg(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === "--bundle" || arg === "-b") && argv[i + 1]) {
      return resolve(cwd, argv[i + 1]);
    }
  }
  if (env.AGENT_BUNDLE_PATH?.trim()) {
    return resolve(cwd, env.AGENT_BUNDLE_PATH.trim());
  }
  return resolve(cwd, DEFAULT_VERIFY_BUNDLE);
}

export function waitForSpeak(
  messages: ChildToParentMessage[],
  sessionId: string,
  timeoutMs: number,
): Promise<Extract<ChildToParentMessage, { type: "speak" }>> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const speak = messages.find(
        (m): m is Extract<ChildToParentMessage, { type: "speak" }> =>
          m.type === "speak" && m.sessionId === sessionId,
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

export function waitForSessionStartAck(
  messages: ChildToParentMessage[],
  sessionId: string,
  timeoutMs: number,
): Promise<Extract<ChildToParentMessage, { type: "session_start_ack" }>> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const ack = messages.find(
        (m): m is Extract<ChildToParentMessage, { type: "session_start_ack" }> =>
          m.type === "session_start_ack" && m.sessionId === sessionId,
      );
      if (ack) {
        clearInterval(timer);
        resolvePromise(ack);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for child session_start_ack IPC`,
          ),
        );
      }
    }, 50);
  });
}

export function detectVerifyCallbacks(
  bundleSource: string,
): VerifyCallbackKey[] {
  const matched = new Set<VerifyCallbackKey>();

  for (const key of VERIFY_CALLBACK_KEYS) {
    // Detect common object-literal forms in transpiled bundles:
    // - onSpeechEvent: fn
    // - onSpeechEvent(ctx) {}
    // - { onSpeechEvent, ... } (shorthand)
    const asProperty = new RegExp(`\\b${key}\\b\\s*:`);
    const asMethod = new RegExp(`\\b${key}\\b\\s*\\(`);
    const asShorthand = new RegExp(`\\b${key}\\b(?=\\s*[,}])`);
    if (
      asProperty.test(bundleSource) ||
      asMethod.test(bundleSource) ||
      asShorthand.test(bundleSource)
    ) {
      matched.add(key);
    }
  }

  return [...matched];
}

export function hasDefineAgentRegistration(bundleSource: string): boolean {
  return /\bdefineAgent\s*\(/.test(bundleSource);
}
