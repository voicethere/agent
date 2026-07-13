import type { SpeechEvent } from "@node-webrtc-rust/sdk/voice";
import { AsyncLocalStorage } from "node:async_hooks";

import type { DataChannelKind, ParentToChildMessage } from "./protocol.js";
import { SessionSerialQueue } from "./session-serial-queue.js";

export const SESSION_START_INIT_DELAY_ENABLED_ENV =
  "AGENT_SESSION_START_INIT_DELAY_ENABLED";
export const SESSION_START_INIT_DELAY_MS_ENV =
  "AGENT_SESSION_START_INIT_DELAY_MS";
const DEFAULT_SESSION_START_INIT_DELAY_MS = 500;

export interface SessionContext {
  sessionId: string;
  env: Record<string, string>;
}

export interface SpeechContext {
  sessionId: string;
  text: string;
}

export interface SpeechEventContext {
  sessionId: string;
}

export interface DataChannelContext {
  sessionId: string;
  /** Parsed JSON when the payload is valid JSON; otherwise the raw string. */
  message: unknown;
  raw: string | null;
  /** Present when the parent forwarded a binary data channel frame. */
  rawBinary: Buffer | null;
  channel: DataChannelKind;
}

export interface AgentHandlers {
  /** Alias for {@link AgentHandlers.onSessionStart}. */
  onClientJoin?: (ctx: SessionContext) => void | Promise<void>;
  onSessionStart?: (ctx: SessionContext) => void | Promise<void>;
  /** Fired for every speech lifecycle event from the parent voice pipeline. */
  onSpeechEvent?: (
    ctx: SpeechEventContext,
    event: SpeechEvent,
  ) => void | Promise<void>;
  /** Convenience handler — also invoked when `speech.type` is `user_speech_final`. */
  onUserSpeechFinal?: (ctx: SpeechContext) => void | Promise<void>;
  /** Alias for {@link AgentHandlers.onSessionEnd}. */
  onClientLeave?: (ctx: { sessionId: string }) => void | Promise<void>;
  onSessionEnd?: (ctx: { sessionId: string }) => void | Promise<void>;
  /** Browser data channel JSON (chat, custom app protocol). */
  onDataChannelMessage?: (ctx: DataChannelContext) => void | Promise<void>;
  /** Browser data channel binary (game state, custom framing). */
  onDataChannelBinary?: (ctx: DataChannelContext) => void | Promise<void>;
  /**
   * Idle timeout fired — run cleanup before the runner disconnects the peer.
   * Must not throw; errors are logged and reported as session errors.
   */
  onIdleTimeout?: (ctx: IdleTimeoutContext) => void | Promise<void>;
  /**
   * Optional — runs when handler code throws before runner crash handling.
   * Must not throw; hook errors are logged via {@link agentLog}.
   */
  errorHook?: (ctx: AgentErrorContext) => void | Promise<void>;
}

export interface IdleTimeoutContext {
  sessionId: string;
  projectId?: string;
  buildId?: string;
  env: Record<string, string>;
  idleTimeoutSeconds: number;
}

export interface AgentErrorContext {
  sessionId: string;
  projectId?: string;
  buildId?: string;
  env: Record<string, string>;
  error: Error;
  customerContext?: Record<string, unknown>;
}

function isParentMessage(value: unknown): value is ParentToChildMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as { type?: string };
  return (
    msg.type === "session_start" ||
    msg.type === "speech_event" ||
    msg.type === "session_end" ||
    msg.type === "data_channel_message" ||
    msg.type === "data_channel_binary" ||
    msg.type === "idle_timeout"
  );
}

function parseDataChannelPayload(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

const peerEnvBySessionId = new Map<string, Record<string, string>>();
/** Sessions that received `session_end`; `speak()` becomes a no-op. */
const endedSessionIds = new Set<string>();
/** Active orchestrator session while a parent IPC handler runs (per-session queue). */
const agentLogSessionContext = new AsyncLocalStorage<string>();

function parseBooleanEnv(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return defaultValue;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  return defaultValue;
}

function parseNonNegativeIntegerEnv(
  value: string | undefined,
  defaultValue: number,
): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
  return Math.floor(parsed);
}

function resolveSessionStartInitDelayMs(): number {
  const enabled = parseBooleanEnv(
    process.env[SESSION_START_INIT_DELAY_ENABLED_ENV],
    true,
  );
  if (!enabled) return 0;
  return parseNonNegativeIntegerEnv(
    process.env[SESSION_START_INIT_DELAY_MS_ENV],
    DEFAULT_SESSION_START_INIT_DELAY_MS,
  );
}

async function handleParentMessage(
  message: ParentToChildMessage,
  handlers: AgentHandlers,
): Promise<void> {
  switch (message.type) {
    case "session_start":
      endedSessionIds.delete(message.sessionId);
      peerEnvBySessionId.set(message.sessionId, message.env);
      const sessionStartInitDelayMs = resolveSessionStartInitDelayMs();
      if (sessionStartInitDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, sessionStartInitDelayMs),
        );
      }
      await (handlers.onClientJoin ?? handlers.onSessionStart)?.({
        sessionId: message.sessionId,
        env: message.env,
      });
      process.send?.({
        type: "session_start_ack",
        sessionId: message.sessionId,
      });
      break;
    case "speech_event":
      await handlers.onSpeechEvent?.(
        { sessionId: message.sessionId },
        message.event,
      );
      if (
        message.event.type === "user_speech_final" &&
        typeof message.event.text === "string" &&
        message.event.text.trim()
      ) {
        await handlers.onUserSpeechFinal?.({
          sessionId: message.sessionId,
          text: message.event.text.trim(),
        });
      }
      break;
    case "data_channel_message":
      await handlers.onDataChannelMessage?.({
        sessionId: message.sessionId,
        message: parseDataChannelPayload(message.payload),
        raw: message.payload,
        rawBinary: null,
        channel: "control",
      });
      break;
    case "data_channel_binary":
      await handlers.onDataChannelBinary?.({
        sessionId: message.sessionId,
        message: null,
        raw: null,
        rawBinary: message.data,
        channel: message.channel ?? "sync",
      });
      break;
    case "session_end":
      peerEnvBySessionId.delete(message.sessionId);
      await (handlers.onClientLeave ?? handlers.onSessionEnd)?.({
        sessionId: message.sessionId,
      });
      break;
    case "idle_timeout":
      await runIdleTimeoutHook(handlers, message);
      break;
  }
}

/**
 * Register IPC handlers for a customer agent child process.
 * Call once at bundle entry; runner parent sends {@link ParentToChildMessage} events.
 *
 * Parent messages for the same `sessionId` are handled strictly in arrival order;
 * different sessions run independently (shared-child / load-safe).
 */
export function defineAgent(handlers: AgentHandlers): void {
  const inboundBySession = new SessionSerialQueue();

  process.on("message", (message: unknown) => {
    if (!isParentMessage(message)) return;

    inboundBySession.enqueue(message.sessionId, async () => {
      await agentLogSessionContext.run(message.sessionId, async () => {
        try {
          if (message.type === "session_end") {
            endedSessionIds.add(message.sessionId);
            inboundBySession.clear(message.sessionId);
          }
          await handleParentMessage(message, handlers);
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          const env =
            peerEnvBySessionId.get(message.sessionId) ??
            buildIdleEnv(message.sessionId);
          await runErrorHook(handlers, {
            sessionId: message.sessionId,
            projectId: env.PROJECT_ID,
            buildId: env.BUILD_ID,
            env,
            error: err,
            customerContext: parseCustomerContext(env.AGENT_CUSTOMER_CONTEXT),
          });
          process.send?.({
            type: "agent_error",
            sessionId: message.sessionId,
            message: err.message,
            stack: err.stack,
          });
        }
      });
    });
  });
}

function parseCustomerContext(
  raw: string | undefined,
): Record<string, unknown> | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed context
  }
  return undefined;
}

async function runErrorHook(
  handlers: AgentHandlers,
  ctx: AgentErrorContext,
): Promise<void> {
  if (!handlers.errorHook) return;
  try {
    await handlers.errorHook(ctx);
  } catch (hookError) {
    const message =
      hookError instanceof Error ? hookError.message : String(hookError);
    agentLog("error", `errorHook failed: ${message}`, ctx.sessionId);
  }
}

async function runIdleTimeoutHook(
  handlers: AgentHandlers,
  message: { sessionId: string; maxGraceMs: number },
): Promise<void> {
  if (!handlers.onIdleTimeout) {
    process.send?.({
      type: "idle_timeout_done",
      sessionId: message.sessionId,
    });
    return;
  }

  const env =
    peerEnvBySessionId.get(message.sessionId) ??
    buildIdleEnv(message.sessionId);
  const idleTimeoutSeconds = Number(env.IDLE_TIMEOUT_SEC) || 0;
  const ctx: IdleTimeoutContext = {
    sessionId: message.sessionId,
    projectId: env.PROJECT_ID,
    buildId: env.BUILD_ID,
    env,
    idleTimeoutSeconds,
  };

  let error: string | undefined;
  try {
    await handlers.onIdleTimeout(ctx);
  } catch (hookError) {
    error = hookError instanceof Error ? hookError.message : String(hookError);
    agentLog("error", `onIdleTimeout failed: ${error}`, message.sessionId);
  }

  process.send?.({
    type: "idle_timeout_done",
    sessionId: message.sessionId,
    error,
  });
}

function buildIdleEnv(sessionId: string): Record<string, string> {
  return {
    SESSION_ID: sessionId,
    ...(process.env.PROJECT_ID ? { PROJECT_ID: process.env.PROJECT_ID } : {}),
    ...(process.env.BUILD_ID ? { BUILD_ID: process.env.BUILD_ID } : {}),
    ...(process.env.IDLE_TIMEOUT_SEC
      ? { IDLE_TIMEOUT_SEC: process.env.IDLE_TIMEOUT_SEC }
      : {}),
  };
}

/** @internal Vitest helper — clears module-level session lifecycle between tests. */
export function resetAgentIpcStateForTests(): void {
  endedSessionIds.clear();
  peerEnvBySessionId.clear();
}

/** Ask the runner parent to synthesize speech for the session. */
export function speak(sessionId: string, text: string): void {
  if (endedSessionIds.has(sessionId)) return;
  process.send?.({ type: "speak", sessionId, text });
}

/** Send a JSON payload to the browser peer via the runner parent. */
export function sendToClient(sessionId: string, payload: unknown): void {
  process.send?.({ type: "send_to_client", sessionId, payload });
}

/** Send raw bytes to the browser peer via the runner parent. */
export function sendBinaryToClient(
  sessionId: string,
  data: Buffer | Uint8Array,
  channel: DataChannelKind = "sync",
): void {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  process.send?.({
    type: "send_binary_to_client",
    sessionId,
    data: buffer,
    channel,
  });
}

/**
 * Broadcasts binary data to specified clients over a specific data channel.
 *
 * @param data The binary data to be sent, either as a Buffer or Uint8Array.
 * @param sessionIds An array of session IDs representing the target clients.
 * @param channel The data channel over which the binary data is sent. Defaults to "sync".
 * @return void
 */
export function broadCastBinaryToClients(
  data: Buffer | Uint8Array,
  sessionIds: readonly string[],
  channel: DataChannelKind = "sync",
): void {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  for (const sessionId of sessionIds) {
    process.send?.({
      type: "send_binary_to_client",
      sessionId,
      data: buffer,
      channel,
    });
  }
}

/** Send the same JSON payload to one or more browser peers. */
export function broadcastToClients(
  payload: unknown,
  sessionIds: readonly string[],
): void {
  for (const sessionId of sessionIds) {
    sendToClient(sessionId, payload);
  }
}

/** Structured log forwarded to the runner parent (includes session when in a handler). */
export function agentLog(
  level: "info" | "error",
  message: string,
  sessionId?: string,
): void {
  const resolvedSessionId = sessionId ?? agentLogSessionContext.getStore();
  process.send?.({
    type: "log",
    level,
    message,
    ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
  });
}

/** Ask the runner to disconnect a browser peer (customer-initiated). */
export function disconnectClient(
  sessionId: string,
  options?: { reason?: string },
): void {
  process.send?.({
    type: "disconnect_client",
    sessionId,
    reason: options?.reason,
  });
}

/** Extract chat text from a parsed data channel message. */
export function parseChatText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const record = message as { type?: string; text?: string };
  if (record.type !== "chat" || typeof record.text !== "string") return null;
  const trimmed = record.text.trim();
  return trimmed.length > 0 ? trimmed : null;
}
