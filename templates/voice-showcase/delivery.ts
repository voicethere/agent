/**
 * Voice-showcase outbound order: send spoken TTS text to the client first,
 * then trigger TTS play. Parent IPC preserves this order.
 */

import type { OutboundMessage } from "./conversation.js";

export type OutboundOp =
  | { kind: "send"; message: OutboundMessage }
  | { kind: "play"; text: string };

export interface OutboundDeps {
  sendToClient: (sessionId: string, payload: unknown) => void;
  speak: (sessionId: string, text: string) => void;
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

export function greetingOps(
  sessionId: string,
  greeting: string,
): OutboundOp[] {
  return spokenThenPlayOps(
    [
      { type: "agent_event", event: "session_start", sessionId },
      { type: "chat_reply", text: greeting },
    ],
    [greeting],
  );
}

export function applyOutboundOps(
  sessionId: string,
  ops: OutboundOp[],
  deps: OutboundDeps,
): void {
  for (const op of ops) {
    if (op.kind === "send") {
      deps.sendToClient(sessionId, op.message);
    } else {
      deps.speak(sessionId, op.text);
    }
  }
}
