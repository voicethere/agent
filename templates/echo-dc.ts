/**
 * Echo debug agent — relays speech events and chat replies over the data channel.
 *
 * Build:
 *   npm install @voicethere/agent
 *   npx @voicethere/agent build --entry templates/echo-dc.ts
 */
import {
  agentLog,
  defineAgent,
  parseChatText,
  sendToClient,
  type SpeechEvent,
} from "@voicethere/agent";

const echoPrefix =
  (process.env.AGENT_ECHO_PREFIX ?? "you said:").trim() || "you said:";

defineAgent({
  onSessionStart({ sessionId }) {
    sendToClient(sessionId, {
      type: "agent_event",
      event: "session_start",
      sessionId,
    });
    agentLog("info", `echo-dc session_start ${sessionId}`);
  },

  onSpeechEvent({ sessionId }, event: SpeechEvent) {
    sendToClient(sessionId, {
      type: "agent_event",
      event: event.type,
      text: event.text,
      raw: event,
    });
  },

  onDataChannelMessage(ctx) {
    const text = parseChatText(ctx.message);
    if (!text) return;
    sendToClient(ctx.sessionId, {
      type: "chat_reply",
      text: `${echoPrefix} ${text}`,
    });
  },

  onSessionEnd({ sessionId }) {
    sendToClient(sessionId, {
      type: "agent_event",
      event: "session_end",
      sessionId,
    });
    agentLog("info", `echo-dc session_end ${sessionId}`);
  },
});
