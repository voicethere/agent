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
  | SessionEndMessage;

/**
 * Messages the customer child may send back to the runner parent.
 *
 * Prefer {@link speak} and {@link agentLog} helpers over raw `process.send`.
 */
export type ChildToParentMessage =
  | SpeakMessage
  | AgentLogMessage
  | AgentErrorMessage;

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
] as const;

/** Union of allowlisted env key names. */
export type AllowedChildEnvKey = (typeof ALLOWED_CHILD_ENV_KEYS)[number];
