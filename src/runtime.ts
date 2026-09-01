import { randomUUID } from "node:crypto";

import type { SpeechEvent } from "@node-webrtc-rust/sdk/voice";
import { AsyncLocalStorage } from "node:async_hooks";

import type {
  AgentLogLevel,
  AgentLogMessage,
  DataChannelKind,
  MixControlAckMessage,
  MixControlAction,
  MixControlMessage,
  MixControlResult,
  MixPlacement,
  MixPose,
  ParentToChildMessage,
  RecordingControlAckMessage,
  RecordingControlAction,
  RecordingControlResult,
  SttControlAckMessage,
  SttControlResult,
  WebhookMessage,
} from "./protocol.js";
import { MIX_REQUIRES_VOICE_PLUS_DATA } from "./protocol.js";
import { SessionSerialQueue } from "./session-serial-queue.js";

export const SESSION_START_INIT_DELAY_ENABLED_ENV =
  "AGENT_SESSION_START_INIT_DELAY_ENABLED";
export const SESSION_START_INIT_DELAY_MS_ENV =
  "AGENT_SESSION_START_INIT_DELAY_MS";
const DEFAULT_SESSION_START_INIT_DELAY_MS = 500;

export interface SessionContext {
  sessionId: string;
  env: Record<string, string>;
  /** `true` when the runner advertises conversation recording for this project. */
  recordingAvailable: boolean;
  /** `true` when the runner session is Voice+Data and mix APIs are available. */
  mixAvailable: boolean;
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

export interface AgentStartContext {
  /** Snapshot of `process.env` at child start (includes `AGENT_REDIS_URL` when set). */
  env: Record<string, string>;
}

/** Context for process-wide inbound webhook IPC (`type: "webhook"`). */
export interface WebhookContext {
  eventId: string;
  projectId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  /** Exact inbound bytes — verify HMAC on this, then `JSON.parse`. */
  body: Buffer;
  contentType: string | null;
  receivedAt: string;
  /** Live session ids on this child (from runner); empty when omitted on older runners. */
  sessionIds: string[];
}

export interface AgentHandlers {
  /**
   * Runs once when the child registers handlers — before any session IPC is handled.
   * Use for process-wide setup (e.g. connect `ioredis` via `process.env.AGENT_REDIS_URL`).
   * Errors are logged and reported; session IPC is still accepted afterward so the child does not hang.
   */
  onAgentStart?: (ctx: AgentStartContext) => void | Promise<void>;
  /**
   * Process-wide inbound HTTP webhook from the edge (not session-queued).
   * VoiceThere does not verify signatures — use `AGENT_WEBHOOK_SIGNING_SECRET` in
   * `process.env` and verify HMAC on {@link WebhookContext.body} before parsing JSON.
   */
  onWebhook?: (ctx: WebhookContext) => void | Promise<void>;
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

function isRecordingControlAckMessage(
  value: unknown,
): value is RecordingControlAckMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as { type?: string; requestId?: unknown };
  return (
    msg.type === "recording_control_ack" && typeof msg.requestId === "string"
  );
}

function isMixControlAckMessage(value: unknown): value is MixControlAckMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as { type?: string; requestId?: unknown };
  return msg.type === "mix_control_ack" && typeof msg.requestId === "string";
}

function isSttControlAckMessage(value: unknown): value is SttControlAckMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as { type?: string; requestId?: unknown };
  return msg.type === "stt_control_ack" && typeof msg.requestId === "string";
}

function isWebhookMessage(value: unknown): value is WebhookMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as {
    type?: string;
    eventId?: unknown;
    projectId?: unknown;
  };
  return (
    msg.type === "webhook" &&
    typeof msg.eventId === "string" &&
    typeof msg.projectId === "string"
  );
}

function coerceInboundBinary(value: unknown): Buffer | null {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "object") {
    const maybeBufferLike = value as { type?: unknown; data?: unknown };
    if (
      maybeBufferLike.type === "Buffer" &&
      Array.isArray(maybeBufferLike.data)
    ) {
      return Buffer.from(maybeBufferLike.data);
    }
  }
  return null;
}

function normalizeWebhookHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") {
      out[key] = raw;
    }
  }
  return out;
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
    msg.type === "idle_timeout" ||
    msg.type === "recording_control_ack" ||
    msg.type === "mix_control_ack" ||
    msg.type === "stt_control_ack" ||
    msg.type === "webhook"
  );
}

/** Parent IPC tied to a `sessionId` (excludes process-wide `webhook` and control acks). */
type SessionScopedParentMessage = Exclude<
  ParentToChildMessage,
  | WebhookMessage
  | RecordingControlAckMessage
  | MixControlAckMessage
  | SttControlAckMessage
>;

function isSessionScopedParentMessage(
  value: unknown,
): value is SessionScopedParentMessage {
  return isParentMessage(value) && !isWebhookMessage(value);
}

function parseDataChannelPayload(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

const peerEnvBySessionId = new Map<string, Record<string, string>>();
/** Cached from `session_start.recordingAvailable` until `session_end`. */
const recordingAvailableBySessionId = new Map<string, boolean>();
/** Cached from `session_start.mixAvailable` until `session_end`. */
const mixAvailableBySessionId = new Map<string, boolean>();
/** Sessions that received `session_end`; `speak()` becomes a no-op when no live gen. */
const endedSessionIds = new Set<string>();

const RECORDING_CONTROL_ACK_TIMEOUT_MS = 5000;

type PendingRecordingAck = {
  sessionId: string;
  resolve: (result: RecordingControlResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pendingRecordingAcks = new Map<string, PendingRecordingAck>();

const MIX_CONTROL_ACK_TIMEOUT_MS = 5000;
const STT_CONTROL_ACK_TIMEOUT_MS = 5000;

type PendingMixAck = {
  resolve: (result: MixControlResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingSttAck = {
  resolve: (result: SttControlResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pendingMixAcks = new Map<string, PendingMixAck>();
const pendingSttAcks = new Map<string, PendingSttAck>();

function handleRecordingControlAck(message: RecordingControlAckMessage): void {
  const pending = pendingRecordingAcks.get(message.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRecordingAcks.delete(message.requestId);
  pending.resolve({
    ok: message.ok,
    reason: message.reason,
    requestId: message.requestId,
  });
}

function handleMixControlAck(message: MixControlAckMessage): void {
  const pending = pendingMixAcks.get(message.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingMixAcks.delete(message.requestId);
  pending.resolve({
    ok: message.ok,
    reason: message.reason,
    requestId: message.requestId,
  });
}

function handleSttControlAck(message: SttControlAckMessage): void {
  const pending = pendingSttAcks.get(message.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingSttAcks.delete(message.requestId);
  pending.resolve({
    ok: message.ok,
    reason: message.reason,
    requestId: message.requestId,
  });
}

function clearPendingMixAcks(reason: string): void {
  for (const [requestId, pending] of pendingMixAcks) {
    clearTimeout(pending.timer);
    pendingMixAcks.delete(requestId);
    pending.resolve({ ok: false, reason, requestId });
  }
}

function clearPendingSttAcks(reason: string): void {
  for (const [requestId, pending] of pendingSttAcks) {
    clearTimeout(pending.timer);
    pendingSttAcks.delete(requestId);
    pending.resolve({ ok: false, reason, requestId });
  }
}

function isMixAvailableInProcess(): boolean {
  for (const available of mixAvailableBySessionId.values()) {
    if (available) return true;
  }
  return false;
}

function assertMixAvailable(): void {
  if (!isMixAvailableInProcess()) {
    throw new Error(MIX_REQUIRES_VOICE_PLUS_DATA);
  }
}

function clearPendingRecordingAcksForSession(
  sessionId: string,
  reason: string,
): void {
  for (const [requestId, pending] of pendingRecordingAcks) {
    if (pending.sessionId !== sessionId) continue;
    clearTimeout(pending.timer);
    pendingRecordingAcks.delete(requestId);
    pending.resolve({ ok: false, reason, requestId });
  }
}

function isVoicethereAgentChild(): boolean {
  return (
    typeof process.send === "function" &&
    process.connected !== false &&
    typeof process.env.__CHILD_BUNDLE_PATH__ === "string" &&
    process.env.__CHILD_BUNDLE_PATH__.trim().length > 0
  );
}

export type SessionExecutionStore = {
  sessionId: string;
  generation: number;
};

/**
 * Generation-aware execution context for inbound handlers. Outbound helpers
 * (`speak`, `sendToClient`, …) consult this so a late old-generation callback
 * cannot emit after `clear` / session-id reuse.
 */
const sessionExecutionContext = new AsyncLocalStorage<SessionExecutionStore>();

/** @deprecated Prefer {@link sessionExecutionContext}; kept for log session id. */
const agentLogSessionContext = new AsyncLocalStorage<string>();

/** Live inbound queue for the child process (set by {@link defineAgent}). */
let inboundQueueAuthority: SessionSerialQueue | null = null;

/** Idempotent: at most one child-process `unhandledRejection` listener. */
let childUnhandledRejectionGuardInstalled = false;

function normalizeRejectionReason(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * Once-per-process safety net for detached customer promises (fire-and-forget
 * work outside awaited handlers). Awaited handler failures stay reported only by
 * the try/catch in {@link defineAgent} — this listener must not double-report those.
 *
 * Does not install `uncaughtException` (a corrupted child must still exit).
 */
function installChildUnhandledRejectionGuard(): void {
  if (childUnhandledRejectionGuardInstalled) {
    return;
  }
  childUnhandledRejectionGuardInstalled = true;

  process.on("unhandledRejection", (reason: unknown) => {
    const err = normalizeRejectionReason(reason);
    const store = sessionExecutionContext.getStore();
    const sessionId =
      store?.sessionId ?? agentLogSessionContext.getStore() ?? "";
    if (!allowOutboundForSession(sessionId || undefined)) {
      return;
    }
    agentLog(
      "error",
      `unhandledRejection: ${err.message}`,
      sessionId || undefined,
    );
    sendParentMessage({
      type: "agent_error",
      sessionId,
      message: err.message,
      stack: err.stack,
    });
  });
}

/**
 * True when outbound IPC/logs for `sessionId` are allowed under the current
 * generation-aware ALS + live session registration.
 *
 * Detached sends (timers, Redis fan-out) run outside handler ALS. The inbound
 * queue keeps a session row until `session_end` clears it — `isLive` means
 * "still connected/registered", not "a handler is currently running".
 */
export function allowOutboundForSession(sessionId?: string): boolean {
  if (!sessionId) {
    // Process-wide logs without a session are always allowed.
    return true;
  }
  const store = sessionExecutionContext.getStore();
  const queue = inboundQueueAuthority;
  if (store && store.sessionId === sessionId) {
    if (!queue) return !endedSessionIds.has(sessionId);
    return queue.isCurrentGeneration(sessionId, store.generation);
  }
  // No ALS (or cross-session target): require a registered session that has
  // not been marked ended. Stale same-id handlers are blocked via ALS above.
  if (endedSessionIds.has(sessionId)) return false;
  if (!queue) return true;
  return queue.isLive(sessionId);
}

function sendParentMessage(message: unknown): void {
  const msgType =
    message && typeof message === "object" && "type" in message
      ? (message as { type?: string }).type
      : undefined;
  if (msgType === "mix_control" || msgType === "stt_control") {
    process.send?.(message as never);
    return;
  }

  const sessionId =
    message &&
    typeof message === "object" &&
    "sessionId" in message &&
    typeof (message as { sessionId?: unknown }).sessionId === "string"
      ? (message as { sessionId: string }).sessionId
      : undefined;
  if (!allowOutboundForSession(sessionId)) return;
  process.send?.(message as never);
}

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

async function handleWebhookMessage(
  message: WebhookMessage,
  handlers: AgentHandlers,
): Promise<void> {
  if (!handlers.onWebhook) return;

  const body = coerceInboundBinary(message.body);
  if (!body) {
    agentLog("warn", "webhook ipc dropped: body is not binary");
    return;
  }

  const ctx: WebhookContext = {
    eventId: message.eventId,
    projectId: message.projectId,
    method: typeof message.method === "string" ? message.method : "POST",
    path: typeof message.path === "string" ? message.path : "",
    headers: normalizeWebhookHeaders(message.headers),
    body,
    contentType:
      typeof message.contentType === "string" ? message.contentType : null,
    receivedAt:
      typeof message.receivedAt === "string" ? message.receivedAt : "",
    sessionIds: Array.isArray(message.sessionIds)
      ? message.sessionIds.filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        )
      : [],
  };

  try {
    const started = Date.now();
    await handlers.onWebhook(ctx);
    sendParentMessage({
      type: "webhook_handled",
      projectId: message.projectId,
      eventId: message.eventId,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    await runErrorHook(handlers, {
      sessionId: "",
      projectId: message.projectId,
      env: process.env as Record<string, string>,
      error: err,
    });
    sendParentMessage({
      type: "agent_error",
      sessionId: "",
      message: err.message,
      stack: err.stack,
    });
  }
}

async function handleParentMessage(
  message: SessionScopedParentMessage,
  handlers: AgentHandlers,
): Promise<void> {
  switch (message.type) {
    case "session_start":
      endedSessionIds.delete(message.sessionId);
      peerEnvBySessionId.set(message.sessionId, message.env);
      recordingAvailableBySessionId.set(
        message.sessionId,
        message.recordingAvailable ?? false,
      );
      mixAvailableBySessionId.set(
        message.sessionId,
        message.mixAvailable ?? false,
      );
      const sessionStartInitDelayMs = resolveSessionStartInitDelayMs();
      if (sessionStartInitDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, sessionStartInitDelayMs),
        );
      }
      await (handlers.onClientJoin ?? handlers.onSessionStart)?.({
        sessionId: message.sessionId,
        env: message.env,
        recordingAvailable: message.recordingAvailable ?? false,
        mixAvailable: message.mixAvailable ?? false,
      });
      sendParentMessage({
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
      clearPendingRecordingAcksForSession(message.sessionId, "session_ended");
      peerEnvBySessionId.delete(message.sessionId);
      recordingAvailableBySessionId.delete(message.sessionId);
      mixAvailableBySessionId.delete(message.sessionId);
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
 *
 * Optional {@link AgentHandlers.onAgentStart} runs once before any session message
 * is processed (session IPC waits on that gate).
 */
export function defineAgent(handlers: AgentHandlers): void {
  installChildUnhandledRejectionGuard();
  const inboundBySession = new SessionSerialQueue();
  inboundQueueAuthority = inboundBySession;
  const agentStartReady = runAgentStartHook(handlers);

  process.on("message", (message: unknown) => {
    if (isRecordingControlAckMessage(message)) {
      handleRecordingControlAck(message);
      return;
    }
    if (isMixControlAckMessage(message)) {
      handleMixControlAck(message);
      return;
    }
    if (isSttControlAckMessage(message)) {
      handleSttControlAck(message);
      return;
    }
    if (isWebhookMessage(message)) {
      void agentStartReady.then(() => handleWebhookMessage(message, handlers));
      return;
    }
    if (!isSessionScopedParentMessage(message)) return;

    // Invalidate immediately on arrival — do not wait behind queued work that
    // must be cancelled. session_end then enqueues on a fresh generation for
    // the leave hook only.
    if (message.type === "session_end") {
      endedSessionIds.add(message.sessionId);
      clearPendingRecordingAcksForSession(message.sessionId, "session_ended");
      inboundBySession.clear(message.sessionId);
    }
    // session_start must not chain onto a dying session_end generation — clear
    // first so enqueue always gets a new live row for the new connection.
    if (message.type === "session_start") {
      endedSessionIds.delete(message.sessionId);
      inboundBySession.clear(message.sessionId);
    }

    inboundBySession.enqueue(message.sessionId, async (_signal, context) => {
      await agentStartReady;
      try {
        await sessionExecutionContext.run(
          {
            sessionId: message.sessionId,
            generation: context.generation,
          },
          async () =>
            agentLogSessionContext.run(message.sessionId, async () => {
              try {
                await handleParentMessage(message, handlers);
              } catch (error) {
                const err =
                  error instanceof Error ? error : new Error(String(error));
                const env =
                  peerEnvBySessionId.get(message.sessionId) ??
                  buildIdleEnv(message.sessionId);
                await runErrorHook(handlers, {
                  sessionId: message.sessionId,
                  projectId: env.PROJECT_ID,
                  buildId: env.BUILD_ID,
                  env,
                  error: err,
                  customerContext: parseCustomerContext(
                    env.AGENT_CUSTOMER_CONTEXT,
                  ),
                });
                sendParentMessage({
                  type: "agent_error",
                  sessionId: message.sessionId,
                  message: err.message,
                  stack: err.stack,
                });
              }
            }),
        );
      } finally {
        // Leave-hook row is temporary. Drop it only if this generation is
        // still current (a racing session_start already cleared + replaced).
        if (
          message.type === "session_end" &&
          inboundBySession.isCurrentGeneration(
            message.sessionId,
            context.generation,
          )
        ) {
          inboundBySession.clear(message.sessionId);
        }
      }
    });
  });
}

async function runAgentStartHook(handlers: AgentHandlers): Promise<void> {
  if (!handlers.onAgentStart) return;
  try {
    await handlers.onAgentStart({
      env: process.env as Record<string, string>,
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    agentLog("error", `onAgentStart failed: ${err.message}`);
    sendParentMessage({
      type: "agent_error",
      sessionId: "",
      message: err.message,
      stack: err.stack,
    });
  }
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
  const onIdleTimeout = handlers.onIdleTimeout;
  agentLog(
    "info",
    `idle_timeout ipc received (maxGraceMs=${message.maxGraceMs}, onIdleTimeout=${typeof onIdleTimeout === "function"})`,
    message.sessionId,
  );

  if (!onIdleTimeout) {
    sendParentMessage({
      type: "idle_timeout_done",
      sessionId: message.sessionId,
    });
    agentLog(
      "info",
      "idle_timeout_done ipc sent (no onIdleTimeout handler)",
      message.sessionId,
    );
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
    await onIdleTimeout(ctx);
  } catch (hookError) {
    error = hookError instanceof Error ? hookError.message : String(hookError);
    agentLog("error", `onIdleTimeout failed: ${error}`, message.sessionId);
  }

  sendParentMessage({
    type: "idle_timeout_done",
    sessionId: message.sessionId,
    error,
  });
  agentLog(
    "info",
    error
      ? `idle_timeout_done ipc sent (onIdleTimeout error: ${error})`
      : "idle_timeout_done ipc sent (onIdleTimeout completed)",
    message.sessionId,
  );
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
  recordingAvailableBySessionId.clear();
  mixAvailableBySessionId.clear();
  inboundQueueAuthority = null;
  for (const [requestId, pending] of pendingRecordingAcks) {
    clearTimeout(pending.timer);
    pendingRecordingAcks.delete(requestId);
  }
  clearPendingMixAcks("reset");
  clearPendingSttAcks("reset");
}

/** Ask the runner parent to synthesize speech for the session. */
export function speak(sessionId: string, text: string): void {
  sendParentMessage({ type: "speak", sessionId, text });
}

/** True when {@link SessionStartMessage.recordingAvailable} was set for the session. */
export function isRecordingAvailable(ctx: SessionContext): boolean {
  return ctx.recordingAvailable;
}

/** True when {@link SessionStartMessage.mixAvailable} was set for the session. */
export function isMixAvailable(ctx: SessionContext): boolean {
  return ctx.mixAvailable;
}

async function sendMixControl(
  action: MixControlAction,
  payload: Omit<MixControlMessage, "type" | "action" | "requestId">,
): Promise<MixControlResult> {
  assertMixAvailable();

  const requestId = randomUUID();

  if (!isVoicethereAgentChild()) {
    return { ok: true, reason: "local_mock", requestId };
  }

  return new Promise<MixControlResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingMixAcks.delete(requestId);
      resolve({ ok: false, reason: "timeout", requestId });
    }, MIX_CONTROL_ACK_TIMEOUT_MS);

    pendingMixAcks.set(requestId, { resolve, timer });

    sendParentMessage({
      type: "mix_control",
      action,
      requestId,
      ...payload,
    });
  });
}

async function sendSttControl(options: {
  enabled: boolean;
  clientId?: string;
  sessionId?: string;
}): Promise<SttControlResult> {
  const requestId = randomUUID();

  if (!isVoicethereAgentChild()) {
    return { ok: true, reason: "local_mock", requestId };
  }

  return new Promise<SttControlResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingSttAcks.delete(requestId);
      resolve({ ok: false, reason: "timeout", requestId });
    }, STT_CONTROL_ACK_TIMEOUT_MS);

    pendingSttAcks.set(requestId, { resolve, timer });

    sendParentMessage({
      type: "stt_control",
      requestId,
      enabled: options.enabled,
      ...(options.clientId ? { clientId: options.clientId } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    });
  });
}

/** Create a mix group with initial members (Voice+Data only). */
export function createMixGroup(options: {
  id: string;
  clientIds: string[];
}): Promise<MixControlResult> {
  return sendMixControl("create_group", {
    groupId: options.id,
    clientIds: [...options.clientIds],
  });
}

/**
 * Move a client into a mix group (exclusive — removed from any previous group).
 * `clientId` is the orchestrator/browser peer id ({@link SessionContext.sessionId}).
 */
export function addClientToMix(
  groupId: string,
  clientId: string,
): Promise<MixControlResult> {
  return sendMixControl("add_client", { groupId, clientId });
}

/** Remove a client from a mix group (ungrouped — hears nobody). */
export function removeClientFromMix(
  groupId: string,
  clientId: string,
): Promise<MixControlResult> {
  return sendMixControl("remove_client", { groupId, clientId });
}

/** Update a client's 6DOF pose for positional mixing. */
export function setClientPose(
  clientId: string,
  pose: MixPose,
): Promise<MixControlResult> {
  return sendMixControl("set_pose", { clientId, pose });
}

/** Enable or disable live pose-based panning (Voice+Data only). */
export function setPositionalMixing(
  enabled: boolean,
): Promise<MixControlResult> {
  return sendMixControl("set_positional", { enabled });
}

/** Set named placement for client sources when positional mixing is off. */
export function setDefaultMixPlacement(
  placement: MixPlacement,
): Promise<MixControlResult> {
  return sendMixControl("set_default_placement", { placement });
}

/** Set named placement for agent TTS in the mix output. */
export function setTtsMixPlacement(
  placement: MixPlacement,
): Promise<MixControlResult> {
  return sendMixControl("set_tts_placement", { placement });
}

/** Set a live world-space pose for the TTS speaker (positional mixing on). */
export function setTtsPose(pose: MixPose): Promise<MixControlResult> {
  return sendMixControl("set_tts_pose", { pose });
}

/** Clear the live TTS pose; named placement applies again. */
export function clearTtsPose(): Promise<MixControlResult> {
  return sendMixControl("clear_tts_pose", {});
}

/**
 * Enable or disable STT for one client or all connected clients.
 *
 * When `clientId` is omitted, the runner applies the change to every client.
 * `clientId` matches {@link SessionContext.sessionId}. Optional `sessionId` is
 * forwarded to the runner when provided (same peer id for single-client scope).
 */
export function setSttEnabled(options: {
  enabled: boolean;
  clientId?: string;
  sessionId?: string;
}): Promise<SttControlResult> {
  return sendSttControl(options);
}

async function sendRecordingControl(
  sessionId: string,
  action: RecordingControlAction,
): Promise<RecordingControlResult> {
  const requestId = randomUUID();

  if (!allowOutboundForSession(sessionId)) {
    return { ok: false, reason: "session_ended", requestId };
  }

  if (
    recordingAvailableBySessionId.has(sessionId) &&
    recordingAvailableBySessionId.get(sessionId) === false &&
    (action === "start" || action === "resume")
  ) {
    agentLog(
      "warn",
      "Project conversation recording is disabled; the agent cannot turn recording on",
      sessionId,
    );
    return { ok: false, reason: "disabled", requestId };
  }

  if (!isVoicethereAgentChild()) {
    return { ok: true, reason: "local_mock", requestId };
  }

  return new Promise<RecordingControlResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingRecordingAcks.delete(requestId);
      resolve({ ok: false, reason: "timeout", requestId });
    }, RECORDING_CONTROL_ACK_TIMEOUT_MS);

    pendingRecordingAcks.set(requestId, { sessionId, resolve, timer });

    sendParentMessage({
      type: "recording_control",
      sessionId,
      action,
      requestId,
    });
  });
}

/** Ask the runner parent to start conversation recording for the session. */
export function startRecording(
  sessionId: string,
): Promise<RecordingControlResult> {
  return sendRecordingControl(sessionId, "start");
}

/** Ask the runner parent to pause an in-progress recording for the session. */
export function pauseRecording(
  sessionId: string,
): Promise<RecordingControlResult> {
  return sendRecordingControl(sessionId, "pause");
}

/** Ask the runner parent to resume a paused recording for the session. */
export function resumeRecording(
  sessionId: string,
): Promise<RecordingControlResult> {
  return sendRecordingControl(sessionId, "resume");
}

/** Ask the runner parent to stop conversation recording for the session. */
export function stopRecording(
  sessionId: string,
): Promise<RecordingControlResult> {
  return sendRecordingControl(sessionId, "stop");
}

/** Send a JSON payload to the browser peer via the runner parent. */
export function sendToClient(sessionId: string, payload: unknown): void {
  sendParentMessage({ type: "send_to_client", sessionId, payload });
}

/** Send raw bytes to the browser peer via the runner parent. */
export function sendBinaryToClient(
  sessionId: string,
  data: Buffer | Uint8Array,
  channel: DataChannelKind = "sync",
): void {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  sendParentMessage({
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
    sendParentMessage({
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

const AGENT_LOG_MESSAGE_MAX_CHARS = 2048;
const AGENT_LOG_FIELDS_MAX_CHARS = 8192;

function truncateAgentLogMessage(message: string): string {
  if (message.length <= AGENT_LOG_MESSAGE_MAX_CHARS) {
    return message;
  }
  const suffix = "…[truncated]";
  return message.slice(0, AGENT_LOG_MESSAGE_MAX_CHARS - suffix.length) + suffix;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeAgentLogFields(
  fields: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (Object.keys(fields).length === 0) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(fields);
    if (serialized.length <= AGENT_LOG_FIELDS_MAX_CHARS) {
      return fields;
    }
    return {
      _agentLogFieldsTruncated: true,
      _originalBytes: serialized.length,
      _preview:
        serialized.slice(0, AGENT_LOG_FIELDS_MAX_CHARS - 80) + "…[truncated]",
    };
  } catch {
    return { _agentLogFieldsError: "not_serializable" };
  }
}

function buildAgentLogPayload(
  level: AgentLogLevel,
  message: string,
  fields?: Record<string, unknown>,
  sessionId?: string,
): AgentLogMessage {
  const resolvedSessionId =
    sessionId ??
    sessionExecutionContext.getStore()?.sessionId ??
    agentLogSessionContext.getStore();
  const sanitizedFields = fields ? sanitizeAgentLogFields(fields) : undefined;
  return {
    type: "log",
    level,
    message: truncateAgentLogMessage(message),
    ts: Date.now(),
    ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
    ...(sanitizedFields ? { fields: sanitizedFields } : {}),
  };
}

/** Structured log forwarded to the runner parent (includes session when in a handler). */
export function agentLog(
  level: AgentLogLevel,
  message: string,
  sessionId?: string,
): void;
export function agentLog(
  level: AgentLogLevel,
  message: string,
  fields: Record<string, unknown>,
  sessionId?: string,
): void;
export function agentLog(
  level: AgentLogLevel,
  message: string,
  fieldsOrSessionId?: Record<string, unknown> | string,
  sessionId?: string,
): void {
  let fields: Record<string, unknown> | undefined;
  let resolvedSessionId: string | undefined;

  if (typeof fieldsOrSessionId === "string") {
    resolvedSessionId = fieldsOrSessionId;
  } else if (isPlainObject(fieldsOrSessionId)) {
    fields = fieldsOrSessionId;
    resolvedSessionId = sessionId;
  } else {
    resolvedSessionId = sessionId;
  }

  sendParentMessage(
    buildAgentLogPayload(level, message, fields, resolvedSessionId),
  );
}

/** Ask the runner to disconnect a browser peer (customer-initiated). */
export function disconnectClient(
  sessionId: string,
  options?: { reason?: string },
): void {
  sendParentMessage({
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
