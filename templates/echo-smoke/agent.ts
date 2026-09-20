/**
 * Minimal echo agent for e2e voice-smoke, agent-smoke, and cli-smoke uploads.
 *
 * Echoes voice finals and DataChannel chat via speak() → TTS (client sees agent_speaking_* speech_events).
 */
import { defineAgent, parseChatText, speak } from "@voicethere/agent";

/**
 * TTS reply prefix with a sentence boundary so Piper does not glue words.
 * Use a word local streaming STT (Kroko Zipformer) reliably emits a token for;
 * `echo.` measured ~5% no-token Piper renders (audio intact). `Okay.` does not.
 */
export function formatEchoSpeak(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return `Okay. ${trimmed}`;
}

defineAgent({
  onSessionStart({ sessionId }) {
    setTimeout(() => {
      speak(sessionId, "ready");
    }, 1000);
  },

  onUserSpeechFinal({ sessionId, text }) {
    const echoText = formatEchoSpeak(text);
    if (!echoText) return;
    speak(sessionId, echoText);
  },

  onDataChannelMessage(ctx) {
    const text = parseChatText(ctx.message);
    if (!text?.trim()) return;
    if (text.trim().toLowerCase() === "ping") return;
    const echoText = formatEchoSpeak(text);
    if (!echoText) return;
    speak(ctx.sessionId, echoText);
  },
});
