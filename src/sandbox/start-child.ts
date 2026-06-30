/**
 * Fork a customer agent bundle the same way the agent runner does (IPC + sandbox).
 *
 * Keep behavior aligned with runner `src/child/starter.ts`.
 */

import { fork, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_CHILD_ENV_KEYS,
  type ChildToParentMessage,
  type ParentToChildMessage,
} from "../protocol.js";
import { buildChildExecArgv } from "./sandbox.js";

const SANDBOX_DIR = dirname(fileURLToPath(import.meta.url));
const LOADER_ENTRY = join(SANDBOX_DIR, "loader-entry.js");

export interface StartSandboxedChildOptions {
  sessionId: string;
  /** Absolute path to customer bundle. If omitted, uses `defaultBundlePath`. */
  bundlePath?: string;
  /** Optional fallback bundle when `bundlePath` is not provided. */
  defaultBundlePath?: string;
  projectId?: string;
  buildId?: string;
  allowlistedEnv?: Record<string, string>;
  onStderr?: (message: string, childPid: number) => void;
}

export interface SandboxedChild {
  pid: number;
  bundlePath: string;
  execArgv: string[];
  send(message: ParentToChildMessage): boolean;
  kill(signal?: NodeJS.Signals): void;
  onMessage(handler: (message: ChildToParentMessage) => void): () => void;
  onExit(
    handler: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): () => void;
}

export function resolveBundlePath(
  bundlePath?: string,
  defaultBundlePath?: string,
): string {
  const raw = bundlePath?.trim() || defaultBundlePath?.trim();
  if (!raw) {
    throw new Error("Bundle path is required");
  }
  const resolved = resolve(raw);
  if (!existsSync(resolved)) {
    throw new Error(`Bundle not found: ${resolved}`);
  }
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function startSandboxedChild(
  options: StartSandboxedChildOptions,
): SandboxedChild {
  const bundlePath = resolveBundlePath(
    options.bundlePath,
    options.defaultBundlePath,
  );
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    __CHILD_BUNDLE_PATH__: bundlePath,
  };

  for (const key of ALLOWED_CHILD_ENV_KEYS) {
    if (key === "SESSION_ID") env[key] = options.sessionId;
    if (key === "PROJECT_ID" && options.projectId) env[key] = options.projectId;
    if (key === "BUILD_ID" && options.buildId) env[key] = options.buildId;
  }

  for (const [key, value] of Object.entries(options.allowlistedEnv ?? {})) {
    if (
      (ALLOWED_CHILD_ENV_KEYS as readonly string[]).includes(key) ||
      key.startsWith("AGENT_")
    ) {
      env[key] = value;
    }
  }

  const execArgv = buildChildExecArgv({
    loaderDir: SANDBOX_DIR,
    bundlePath,
  });

  const child: ChildProcess = fork(LOADER_ENTRY, [], {
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv,
  });

  child.stderr?.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (message) options.onStderr?.(message, child.pid ?? -1);
  });

  const messageHandlers = new Set<(message: ChildToParentMessage) => void>();
  const exitHandlers = new Set<
    (code: number | null, signal: NodeJS.Signals | null) => void
  >();

  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const payload = message as ChildToParentMessage;
    for (const handler of messageHandlers) {
      handler(payload);
    }
  });

  child.on("exit", (code, signal) => {
    for (const handler of exitHandlers) {
      handler(code, signal);
    }
  });

  return {
    pid: child.pid ?? -1,
    bundlePath,
    execArgv: [...execArgv],
    send(message: ParentToChildMessage) {
      if (!child.connected) return false;
      return child.send(message);
    },
    kill(signal: NodeJS.Signals = "SIGTERM") {
      child.kill(signal);
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onExit(handler) {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
  };
}
