/**
 * Full echo agent — speaks and chats back "you said: …" for voice and text.
 *
 * Build:
 *   npm install @voicethere/agent
 *   npx @voicethere/agent build --entry templates/echo.ts
 */
import {
  agentLog,
  defineAgent,
  parseChatText,
  sendToClient,
  speak,
  type SpeechEvent,
} from "@voicethere/agent";

const echoPrefix =
  (process.env.AGENT_ECHO_PREFIX ?? "you said:").trim() || "you said:";

function formatEcho(text: string): string {
  return `${echoPrefix} ${text}`.trim();
}

defineAgent({
  onSessionStart({ sessionId }) {
    sendToClient(sessionId, {
      type: "agent_event",
      event: "session_start",
      sessionId,
    });
    agentLog("info", `echo session_start ${sessionId}`);
  },

  onSpeechEvent({ sessionId }, event: SpeechEvent) {
    sendToClient(sessionId, {
      type: "agent_event",
      event: event.type,
      text: event.text,
      raw: event,
    });
  },

  onUserSpeechFinal({ sessionId, text }) {
    const reply = formatEcho(text);
    speak(sessionId, reply);
    sendToClient(sessionId, { type: "chat_reply", text: reply });
  },

  onDataChannelMessage(ctx) {
    const text = parseChatText(ctx.message);
    if (!text) return;
    const reply = formatEcho(text);
    sendToClient(ctx.sessionId, { type: "chat_reply", text: reply });
    speak(ctx.sessionId, reply);
  },

  onSessionEnd({ sessionId }) {
    sendToClient(sessionId, {
      type: "agent_event",
      event: "session_end",
      sessionId,
    });
    agentLog("info", `echo session_end ${sessionId}`);
  },
});
