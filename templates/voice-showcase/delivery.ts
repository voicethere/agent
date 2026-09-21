/**
 * Voice-showcase outbound order: send spoken TTS text to the client first,
 * then trigger TTS play. Parent IPC preserves this order.
 */

import { randomUUID } from "node:crypto";

import type { OutboundMessage } from "./conversation.js";

export type OutboundOp =
  { kind: "send"; message: OutboundMessage } | { kind: "play"; text: string };

export interface OutboundDeps {
  sendToClient: (sessionId: string, payload: unknown) => void;
  speak: (sessionId: string, text: string) => void;
  speakAndChat: (
    sessionId: string,
    text: string,
    options?: { stream?: boolean; utteranceId?: string },
  ) => void;
}

/** All DataChannel payloads, then TTS play commands. */
export function spokenThenPlayOps(
  messages: OutboundMessage[],
  speakLines: string[],
): OutboundOp[] {
  const ops: OutboundOp[] = [];
  for (const message of messages) {
    ops.push({ kind: "send", message });
  }
  for (const text of speakLines) {
    ops.push({ kind: "play", text });
  }
  return ops;
}

export function greetingOps(sessionId: string, greeting: string): OutboundOp[] {
  const utteranceId = randomUUID();
  return spokenThenPlayOps(
    [
      { type: "agent_event", event: "session_start", sessionId },
      {
        type: "chat_reply",
        text: greeting,
        stream: true,
        utteranceId,
      },
    ],
    [greeting],
  );
}

export function applyOutboundOps(
  sessionId: string,
  ops: OutboundOp[],
  deps: OutboundDeps,
): void {
  const spokenViaSpeakAndChat = new Set<string>();

  for (const op of ops) {
    if (op.kind === "send") {
      const message = op.message;
      if (
        message.type === "chat_reply" &&
        message.stream === true &&
        message.text?.trim()
      ) {
        const text = message.text.trim();
        deps.speakAndChat(sessionId, text, {
          stream: true,
          utteranceId: message.utteranceId,
        });
        spokenViaSpeakAndChat.add(text);
      } else {
        deps.sendToClient(sessionId, message);
      }
      continue;
    }

    const playText = op.text.trim();
    if (spokenViaSpeakAndChat.has(playText)) {
      continue;
    }
    deps.speak(sessionId, op.text);
  }
}
