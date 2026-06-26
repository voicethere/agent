/**
 * IPC message shapes between trusted runner parent and isolated customer child.
 *
 * Transport: Node.js `process.send` / `process.on('message')` on a forked child.
 * Speech payloads use {@link SpeechEvent} from `@node-webrtc-rust/sdk/voice` unchanged.
 *
 * IPC shapes are shared with the VoiceThere agent runner (session worker parent).
 *
 * @packageDocumentation
 */

import type { SpeechEvent } from "@node-webrtc-rust/sdk/voice";

/**
 * Messages the trusted runner parent may send to the sandboxed customer child.
 *
 * Register handlers via {@link defineAgent} in `@voicethere/agent` — do not read
 * `process.on('message')` directly in customer bundles.
 */
export type ParentToChildMessage =
  | SessionStartMessage
  | SpeechEventMessage
  | SessionEndMessage
  | DataChannelMessageMessage
  | DataChannelBinaryMessage
  | IdleTimeoutMessage;

/**
 * Messages the customer child may send back to the runner parent.
 *
 * Prefer {@link speak}, {@link sendToClient}, {@link sendBinaryToClient}, and {@link agentLog} helpers over raw `process.send`.
 */
export type ChildToParentMessage =
  | SessionStartAckMessage
  | SpeakMessage
  | AgentLogMessage
  | AgentErrorMessage
  | SendToClientMessage
  | SendBinaryToClientMessage
  | IdleTimeoutDoneMessage
  | DisconnectClientMessage;

/** Which WebRTC data channel carried a binary IPC payload. */
export type DataChannelKind = "control" | "sync";

/**
 * A WebRTC peer connected to the runner and mapped to this child process.
 *
 * Emitted once per `sessionId` before the first {@link SpeechEventMessage}.
 * `env.SESSION_ID` matches {@link SessionStartMessage.sessionId}.
 */
export interface SessionStartMessage {
  type: "session_start";
  /** Browser/signaling peer id for this conversation leg. */
  sessionId: string;
  /**
   * Allowlisted environment variables copied from the runner process.
   * Keys are a subset of {@link ALLOWED_CHILD_ENV_KEYS}.
   */
  env: Record<string, string>;
}

/**
 * Forwards one speech lifecycle event from the parent Sherpa/VAD/STT/TTS pipeline.
 *
 * The {@link SpeechEvent} shape matches `@node-webrtc-rust/sdk/voice` — see SDK docs
 * for `SpeechEventType` semantics (`user_speech_final`, `barge_in`, etc.).
 *
 * Delivered to customer code as `onSpeechEvent(ctx, message.event)`; `user_speech_final`
 * also triggers the `onUserSpeechFinal` handler when `event.text` is non-empty.
 */
export interface SpeechEventMessage {
  type: "speech_event";
  /** Peer/session id the event belongs to. */
  sessionId: string;
  /** Native pipeline event payload (`type`, optional `text` / `error`). */
  event: SpeechEvent;
}

/**
 * The peer disconnected or the runner is tearing down this session leg.
 *
 * Emitted when the runner unregisters a peer or tears down the session.
 */
export interface SessionEndMessage {
  type: "session_end";
  /** Peer/session id that ended. */
  sessionId: string;
}

/**
 * Child confirms {@link SessionStartMessage} was fully handled.
 *
 * Parent may gate `speech_event` / data-channel IPC until this arrives, which
 * prevents races where `session_start` async setup overlaps later messages.
 */
export interface SessionStartAckMessage {
  type: "session_start_ack";
  /** Peer/session id that completed startup inside the child. */
  sessionId: string;
}

/**
 * Raw JSON payload received from the browser data channel (voice-control or voicethere).
 */
export interface DataChannelMessageMessage {
  type: "data_channel_message";
  sessionId: string;
  /** UTF-8 JSON string from the browser peer. */
  payload: string;
}

/**
 * Raw binary payload from the browser data channel (`voice-control` or `voicethere-sync`).
 */
export interface DataChannelBinaryMessage {
  type: "data_channel_binary";
  sessionId: string;
  data: Buffer;
  channel?: DataChannelKind;
}

/**
 * Ask the parent to synthesize speech on the agent outbound WebRTC track.
 *
 * Handled by the runner parent, which synthesizes audio on the outbound WebRTC track.
 * TTS does **not** run inside the sandboxed child.
 */
export interface SpeakMessage {
  type: "speak";
  /** Target peer/session id (must match a prior {@link SessionStartMessage}). */
  sessionId: string;
  /** UTF-8 text passed to the parent TTS vendor. */
  text: string;
}

/**
 * Structured log line forwarded to runner stdout / Winston.
 *
 * Use {@link agentLog} instead of calling `process.send` directly.
 */
export interface AgentLogMessage {
  type: "log";
  level: "info" | "error";
  message: string;
  /** Orchestrator session id when the log originates from a session handler. */
  sessionId?: string;
}

/**
 * Unhandled exception or rejected promise in customer agent code.
 *
 * The parent may play crash TTS and treat the child as failed. Prefer try/catch in
 * handlers; use this only for fatal reporting.
 */
export interface AgentErrorMessage {
  type: "agent_error";
  /** Peer/session id active when the error occurred. */
  sessionId: string;
  /** Human-readable error summary (no stack traces required). */
  message: string;
  /** Optional stack trace from handler throw. */
  stack?: string;
}

/**
 * Send a JSON-serializable payload to the browser peer over the WebRTC data channel.
 */
export interface SendToClientMessage {
  type: "send_to_client";
  sessionId: string;
  payload: unknown;
}

/** Send raw bytes to the browser peer over a WebRTC data channel. */
export interface SendBinaryToClientMessage {
  type: "send_binary_to_client";
  sessionId: string;
  data: Buffer;
  channel?: DataChannelKind;
}

/**
 * Idle timeout fired — run {@link AgentHandlers.onIdleTimeout} before disconnect.
 */
export interface IdleTimeoutMessage {
  type: "idle_timeout";
  sessionId: string;
  /** Wall-clock grace for the customer callback (default 30000). */
  maxGraceMs: number;
}

/**
 * Customer callback finished (or failed) after {@link IdleTimeoutMessage}.
 */
export interface IdleTimeoutDoneMessage {
  type: "idle_timeout_done";
  sessionId: string;
  /** Set when the customer hook threw or rejected. */
  error?: string;
}

/**
 * Ask the runner to disconnect a browser peer (customer-initiated).
 */
export interface DisconnectClientMessage {
  type: "disconnect_client";
  sessionId: string;
  reason?: string;
}

/**
 * Environment variable names the runner may inject into {@link SessionStartMessage.env}.
 *
 * The runner may add more project-specific keys over time; customer bundles must
 * not read `process.env` directly — only the `env` object on session start.
 */
export const ALLOWED_CHILD_ENV_KEYS = [
  "SESSION_ID",
  "PROJECT_ID",
  "BUILD_ID",
  "IDLE_TIMEOUT_SEC",
  /** JSON string — opaque customer context from browser session start. */
  "AGENT_CUSTOMER_CONTEXT",
] as const;

/** Union of allowlisted env key names. */
export type AllowedChildEnvKey = (typeof ALLOWED_CHILD_ENV_KEYS)[number];
