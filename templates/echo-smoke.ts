/**
 * Minimal echo agent for e2e voice-smoke, agent-smoke, and cli-smoke uploads.
 *
 * Echoes voice finals and DataChannel chat via speak() → TTS (client sees agent_speaking_* speech_events).
 */
import { defineAgent, parseChatText, speak } from "@voicethere/agent";

defineAgent({
  onSessionStart({ sessionId }) {
    setTimeout(() => {
      speak(sessionId, "ready");
    }, 1000);
  },

  onUserSpeechFinal({ sessionId, text }) {
    const trimmed = text.trim();
    if (!trimmed) return;
    speak(sessionId, `echo:${trimmed}`);
  },

  onDataChannelMessage(ctx) {
    const text = parseChatText(ctx.message);
    if (!text?.trim()) return;
    if (text.trim().toLowerCase() === "ping") return;
    speak(ctx.sessionId, `echo:${text.trim()}`);
  },
});
