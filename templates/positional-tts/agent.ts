/**
 * Positional TTS template — each listener hears TTS orbiting their own pose.
 *
 * Requires Voice+Data runner mode ({@link isMixAvailable}). Mix APIs throw
 * `MIX_REQUIRES_VOICE_PLUS_DATA` otherwise.
 *
 * Build:
 *   npx @voicethere/agent build --entry templates/positional-tts/agent.ts
 */
import {
  agentLog,
  clearTtsPose,
  defineAgent,
  isMixAvailable,
  parseChatText,
  setPositionalMixing,
  setTtsPose,
  speak,
} from "@voicethere/agent";

import { orbitTtsPose } from "./orbit.js";

const ORBIT_INTERVAL_MS = 50;

const orbitTimers = new Map<string, ReturnType<typeof setInterval>>();
const sessionStartTimes = new Map<string, number>();

function clearOrbit(sessionId: string): void {
  const timer = orbitTimers.get(sessionId);
  if (timer) {
    clearInterval(timer);
    orbitTimers.delete(sessionId);
  }
  sessionStartTimes.delete(sessionId);
}

async function safeMixCall(
  sessionId: string,
  label: string,
  fn: () => Promise<{ ok: boolean; reason?: string }>,
): Promise<void> {
  try {
    const result = await fn();
    if (!result.ok) {
      agentLog(
        "warn",
        `positional-tts ${label} failed: ${result.reason}`,
        sessionId,
      );
    }
  } catch (err) {
    agentLog(
      "warn",
      `positional-tts ${label} error: ${String(err)}`,
      sessionId,
    );
  }
}

defineAgent({
  onAgentStart() {
    orbitTimers.clear();
    sessionStartTimes.clear();
  },

  onSessionStart(ctx) {
    const { sessionId } = ctx;

    if (!isMixAvailable(ctx)) {
      agentLog(
        "warn",
        "positional-tts requires Voice+Data runner mode — mix APIs unavailable",
        sessionId,
      );
      speak(
        sessionId,
        "This demo needs Voice and Data channels. Enable Voice+Data in runner settings.",
      );
      return;
    }

    void (async () => {
      await safeMixCall(sessionId, "setPositionalMixing", () =>
        setPositionalMixing(true),
      );

      const startMs = Date.now();
      sessionStartTimes.set(sessionId, startMs);

      const timer = setInterval(() => {
        const started = sessionStartTimes.get(sessionId);
        if (!started) return;
        const elapsedSec = (Date.now() - started) / 1000;
        void safeMixCall(sessionId, "setTtsPose", () =>
          setTtsPose(sessionId, orbitTtsPose(elapsedSec)),
        );
      }, ORBIT_INTERVAL_MS);

      orbitTimers.set(sessionId, timer);
      speak(sessionId, "I'll circle around you.");
    })();
  },

  onUserSpeechFinal({ sessionId, text }) {
    speak(sessionId, `You said: ${text}`);
  },

  onDataChannelMessage(ctx) {
    const text = parseChatText(ctx.message);
    if (!text) return;
    speak(ctx.sessionId, `You said: ${text}`);
  },

  onSessionEnd({ sessionId }) {
    clearOrbit(sessionId);
    void safeMixCall(sessionId, "clearTtsPose", () => clearTtsPose(sessionId));
    agentLog("info", `positional-tts session_end ${sessionId}`, sessionId);
  },
});
