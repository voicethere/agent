import { resolve } from "node:path";

import type { ChildToParentMessage } from "../protocol.js";

export const VERIFY_SESSION_ID = "local-verify";
export const DEFAULT_VERIFY_BUNDLE = "dist/agent.js";
export const DEFAULT_VERIFY_ENTRY = "agent.ts";

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
