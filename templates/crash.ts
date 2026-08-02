/**
 * Crash / echo agent for session-errors-smoke and agent-crash-policy-*-smoke.
 *
 * Protocol:
 * - `{ type: "crash_trigger" }` → throw (AGENT_HANDLER_FAILED)
 * - `{ type: "crash_exit" }` → process.exit(1)
 * - `{ type: "ping", id }` → `{ type: "pong", id }`
 * - `onUserSpeechFinal` text starting with "crash" → throw
 * - other finals → speak(`echo:${text}`)
 * - onSessionStart → speak("ready") after 1s (voice ready waiter)
 */
import { defineAgent, sendToClient, speak } from "@voicethere/agent";

export const CRASH_AGENT_MESSAGE =
  "e2e crash-agent: intentional handler failure";

function isRecord(message: unknown): message is Record<string, unknown> {
  return !!message && typeof message === "object";
}

function isCrashTrigger(message: unknown): boolean {
  return isRecord(message) && message.type === "crash_trigger";
}

function isCrashExit(message: unknown): boolean {
  return isRecord(message) && message.type === "crash_exit";
}

function isPing(message: unknown): message is { type: "ping"; id: string } {
  if (!isRecord(message) || message.type !== "ping") return false;
  return typeof message.id === "string" && message.id.trim().length > 0;
}

defineAgent({
  onSessionStart({ sessionId }) {
    setTimeout(() => {
      speak(sessionId, "ready");
    }, 1000);
  },

  onUserSpeechFinal({ sessionId, text }) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (/^crash\b/i.test(trimmed)) {
      throw new Error(CRASH_AGENT_MESSAGE);
    }
    speak(sessionId, `echo:${trimmed}`);
  },

  onDataChannelMessage(ctx) {
    if (isCrashTrigger(ctx.message)) {
      throw new Error(CRASH_AGENT_MESSAGE);
    }
    if (isCrashExit(ctx.message)) {
      process.exit(1);
    }
    if (isPing(ctx.message)) {
      sendToClient(ctx.sessionId, { type: "pong", id: ctx.message.id });
    }
  },
});
