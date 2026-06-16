import type { SpeechEvent } from "@node-webrtc-rust/sdk/voice";

import type {
  DataChannelKind,
  ParentToChildMessage,
} from "./protocol.js";

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
  onSessionStart?: (ctx: SessionContext) => void | Promise<void>;
  /** Fired for every speech lifecycle event from the parent voice pipeline. */
  onSpeechEvent?: (
    ctx: SpeechEventContext,
    event: SpeechEvent,
  ) => void | Promise<void>;
  /** Convenience handler — also invoked when `speech.type` is `user_speech_final`. */
  onUserSpeechFinal?: (ctx: SpeechContext) => void | Promise<void>;
  onSessionEnd?: (ctx: { sessionId: string }) => void | Promise<void>;
  /** Browser data channel JSON (chat, custom app protocol). */
  onDataChannelMessage?: (ctx: DataChannelContext) => void | Promise<void>;
  /** Browser data channel binary (game state, custom framing). */
  onDataChannelBinary?: (ctx: DataChannelContext) => void | Promise<void>;
}

function isParentMessage(value: unknown): value is ParentToChildMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as { type?: string };
  return (
    msg.type === "session_start" ||
    msg.type === "speech_event" ||
    msg.type === "session_end" ||
    msg.type === "data_channel_message" ||
    msg.type === "data_channel_binary"
  );
}

function parseDataChannelPayload(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * Register IPC handlers for a customer agent child process.
 * Call once at bundle entry; runner parent sends {@link ParentToChildMessage} events.
 */
export function defineAgent(handlers: AgentHandlers): void {
  process.on("message", (message: unknown) => {
    if (!isParentMessage(message)) return;

    void (async () => {
      try {
        switch (message.type) {
          case "session_start":
            await handlers.onSessionStart?.({
              sessionId: message.sessionId,
              env: message.env,
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
            await handlers.onSessionEnd?.({ sessionId: message.sessionId });
            break;
        }
      } catch (error) {
        const errMessage =
          error instanceof Error ? error.message : String(error);
        process.send?.({
          type: "agent_error",
          sessionId: message.sessionId,
          message: errMessage,
        });
      }
    })();
  });
}

/** Ask the runner parent to synthesize speech for the session. */
export function speak(sessionId: string, text: string): void {
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
  process.send?.({ type: "send_binary_to_client", sessionId, data: buffer, channel });
}

/** Structured log forwarded to the runner parent. */
export function agentLog(level: "info" | "error", message: string): void {
  process.send?.({ type: "log", level, message });
}

/** Extract chat text from a parsed data channel message. */
export function parseChatText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const record = message as { type?: string; text?: string };
  if (record.type !== "chat" || typeof record.text !== "string") return null;
  const trimmed = record.text.trim();
  return trimmed.length > 0 ? trimmed : null;
}
