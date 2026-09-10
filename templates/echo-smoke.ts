/**
 * Minimal echo agent for e2e voice-smoke, agent-smoke, and cli-smoke uploads.
 *
 * Echoes voice finals and DataChannel chat via speak() → TTS (client sees agent_speaking_* speech_events).
 */
import { defineAgent, parseChatText, speak } from "@voicethere/agent";

/** TTS echo prefix with a sentence boundary so Piper does not glue words. */
export function formatEchoSpeak(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  // Never glue `echo:` onto the next word; Piper skips "echo colon" on `echo:One`.
  return `echo. ${trimmed}`;
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
