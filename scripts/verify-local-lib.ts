import { resolve } from "node:path";

import type { ChildToParentMessage } from "../src/protocol.js";

export const VERIFY_SESSION_ID = "local-verify";
export const DEFAULT_VERIFY_BUNDLE = "dist/agent.js";

export function parseBundleArg(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const flagIndex = argv.indexOf("--bundle");
  if (flagIndex >= 0 && argv[flagIndex + 1]) {
    return resolve(cwd, argv[flagIndex + 1]);
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
