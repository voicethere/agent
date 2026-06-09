import type { SpeechEvent } from "@node-webrtc-rust/sdk/voice";

import type { ParentToChildMessage } from "./protocol.js";

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
}

function isParentMessage(value: unknown): value is ParentToChildMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as { type?: string };
  return (
    msg.type === "session_start" ||
    msg.type === "speech_event" ||
    msg.type === "session_end"
  );
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

/** Structured log forwarded to the runner parent. */
export function agentLog(level: "info" | "error", message: string): void {
  process.send?.({ type: "log", level, message });
}
