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
export type { SpeechEvent } from "@node-webrtc-rust/sdk/voice";

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
  | IdleTimeoutMessage
  | RecordingControlAckMessage
  | MixControlAckMessage
  | SttControlAckMessage
  | WebhookMessage;

/**
 * Messages the customer child may send back to the runner parent.
 *
 * Prefer {@link speak}, {@link startRecording}, {@link sendToClient}, {@link sendBinaryToClient}, and {@link agentLog} helpers over raw `process.send`.
 */
export type ChildToParentMessage =
  | SessionStartAckMessage
  | SpeakMessage
  | RecordingControlMessage
  | MixControlMessage
  | SttControlMessage
  | AgentLogMessage
  | AgentErrorMessage
  | SendToClientMessage
  | SendBinaryToClientMessage
  | IdleTimeoutDoneMessage
  | DisconnectClientMessage
  | WebhookHandledMessage;

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
  /**
   * When `true`, the runner has conversation recording enabled for this project.
   * Absent on older runners — treat as `false`.
   */
  recordingAvailable?: boolean;
  /**
   * When `true`, the runner session is Voice+Data and positional mix APIs are available.
   * Absent on older runners or voice/data-only sessions — treat as `false`.
   */
  mixAvailable?: boolean;
  /**
   * When `true`, TTS pose / listener pose / positional panning APIs are available
   * (voice or Voice+Data). Absent on data-only or older runners — treat as `false`.
   */
  ttsPoseAvailable?: boolean;
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
 * Ask the parent to start, pause, resume, or stop conversation recording for a session.
 *
 * Recording runs in the runner parent — use {@link startRecording}, {@link pauseRecording},
 * {@link resumeRecording}, and {@link stopRecording} instead of raw `process.send`.
 */
export type RecordingControlAction = "start" | "pause" | "resume" | "stop";

export interface RecordingControlMessage {
  type: "recording_control";
  /** Target peer/session id (must match a prior {@link SessionStartMessage}). */
  sessionId: string;
  action: RecordingControlAction;
  /** Correlates with {@link RecordingControlAckMessage.requestId}. */
  requestId: string;
}

/** Runner acknowledgement for a {@link RecordingControlMessage}. */
export interface RecordingControlAckMessage {
  type: "recording_control_ack";
  sessionId: string;
  action: RecordingControlAction;
  requestId: string;
  ok: boolean;
  reason?:
    | "applied"
    | "disabled"
    | "unsupported"
    | "stopped"
    | "local_mock"
    | "timeout"
    | string;
}

/** Result returned by {@link startRecording} and related helpers. */
export type RecordingControlResult = {
  ok: boolean;
  reason?: string;
  requestId: string;
};

/** Named stereo placement when positional mixing is off (and for TTS panning). */
export type MixPlacement =
  "center" | "left" | "right" | "front" | "behind" | "below" | "above";

/** 6DOF pose for positional mixing (world position + unit quaternion). */
export interface MixPose {
  position: { x: number; y: number; z: number };
  orientation: { x: number; y: number; z: number; w: number };
}

export type MixControlAction =
  | "create_group"
  | "add_client"
  | "remove_client"
  | "set_pose"
  | "set_positional"
  | "set_default_placement"
  | "set_tts_placement"
  | "set_tts_pose"
  | "clear_tts_pose";

/**
 * Ask the runner parent to change mix groups, poses, or placement settings.
 *
 * Mix runs in the runner parent — use {@link createMixGroup}, {@link setClientPose},
 * and related helpers instead of raw `process.send`. Requires Voice+Data
 * ({@link SessionStartMessage.mixAvailable}).
 */
export interface MixControlMessage {
  type: "mix_control";
  action: MixControlAction;
  /** Correlates with {@link MixControlAckMessage.requestId}. */
  requestId: string;
  groupId?: string;
  /** Peer/session ids (orchestrator session id). */
  clientIds?: string[];
  /** Single peer/session id for add/remove/pose actions. */
  clientId?: string;
  pose?: MixPose;
  enabled?: boolean;
  placement?: MixPlacement;
}

/** Runner acknowledgement for a {@link MixControlMessage}. */
export interface MixControlAckMessage {
  type: "mix_control_ack";
  action: MixControlAction;
  requestId: string;
  ok: boolean;
  reason?: "applied" | "unsupported" | "local_mock" | "timeout" | string;
}

/** Result returned by mix control helpers. */
export type MixControlResult = {
  ok: boolean;
  reason?: string;
  requestId: string;
};

/**
 * Ask the runner parent to enable or disable STT for one client or all clients.
 *
 * `clientId` omitted targets every connected client. `clientId` is the same id as
 * {@link SessionContext.sessionId} (orchestrator/browser peer id).
 */
export interface SttControlMessage {
  type: "stt_control";
  requestId: string;
  enabled: boolean;
  /** When set, only this peer/session is affected. */
  clientId?: string;
  /**
   * Optional scope hint for the runner (same id as `clientId` when targeting one peer).
   * Omitted when toggling all clients.
   */
  sessionId?: string;
}

/** Runner acknowledgement for a {@link SttControlMessage}. */
export interface SttControlAckMessage {
  type: "stt_control_ack";
  requestId: string;
  ok: boolean;
  reason?: "applied" | "unsupported" | "local_mock" | "timeout" | string;
}

/** Result returned by {@link setSttEnabled}. */
export type SttControlResult = {
  ok: boolean;
  reason?: string;
  requestId: string;
};

/** Thrown by mix group helpers when {@link SessionStartMessage.mixAvailable} is not `true`. */
export const MIX_REQUIRES_VOICE_PLUS_DATA =
  "Mix APIs require sessionMode 'voice+data' (voice tracks and a sync data channel)";

/** Thrown by TTS pose helpers when {@link SessionStartMessage.ttsPoseAvailable} is not `true`. */
export const TTS_POSE_REQUIRES_VOICE =
  "TTS pose APIs require voice or voice+data (not data-only)";

/** Log severity forwarded to the runner parent process. */
export type AgentLogLevel = "debug" | "info" | "warn" | "error";

/**
 * Structured log line forwarded to runner stdout / Winston.
 *
 * Use {@link agentLog} instead of calling `process.send` directly.
 */
export interface AgentLogMessage {
  type: "log";
  level: AgentLogLevel;
  message: string;
  /** Optional structured key/value context (serialized size capped by {@link agentLog}). */
  fields?: Record<string, unknown>;
  /** Orchestrator session id when the log originates from a session handler. */
  sessionId?: string;
  /** Milliseconds since epoch when the child emitted the log. */
  ts?: number;
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
 * Inbound HTTP webhook forwarded from the edge — process-wide, not tied to a session.
 *
 * Delivered to {@link AgentHandlers.onWebhook} on every child in the runner process
 * (not session-queued). {@link WebhookMessage.body} is the exact inbound bytes — verify
 * HMAC/signatures on `body` before `JSON.parse` in customer code.
 */
export interface WebhookMessage {
  type: "webhook";
  /** Edge-generated id for idempotency. */
  eventId: string;
  projectId: string;
  method: string;
  path: string;
  /** All inbound request headers (string values). */
  headers: Record<string, string>;
  /** Exact inbound body bytes — do not parse in the SDK before the customer handler. */
  body: Buffer;
  contentType: string | null;
  receivedAt: string;
  /**
   * Orchestrator session ids registered on this child when the runner forwarded
   * the webhook. Prefer over in-child `connectedSessions` when present (runner
   * is source of truth for live sessions). Absent on older runners.
   */
  sessionIds?: string[];
}

/** Child reports onWebhook completion latency (process-wide, not session-scoped). */
export interface WebhookHandledMessage {
  type: "webhook_handled";
  projectId: string;
  eventId: string;
  durationMs: number;
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
 * not read `process.env` for session fields — only the `env` object on session start.
 *
 * Process-wide secrets such as `AGENT_REDIS_URL` (when project Redis is enabled) and
 * `AGENT_WEBHOOK_SIGNING_SECRET` (for inbound webhook HMAC verification) are still
 * available on `process.env` inside `onAgentStart` / `onWebhook`.
 * Keys prefixed with `AGENT_` may also be forwarded into the child environment.
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
