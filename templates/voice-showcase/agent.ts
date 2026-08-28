/**
 * Conversational voice showcase — greeting, name, menu (weather, count, recipe, fun fact).
 *
 * Build:
 *   npx @voicethere/agent build --entry templates/voice-showcase/agent.ts
 */
import {
  agentLog,
  defineAgent,
  parseChatText,
  sendToClient,
  speak,
  type SpeechEvent,
} from "@voicethere/agent";

import {
  createInitialState,
  GREETING,
  handleUtterance,
  resolveWeatherTurn,
  type ConversationState,
  type OutboundMessage,
} from "./conversation.js";

const sessions = new Map<string, ConversationState>();

function getState(sessionId: string): ConversationState {
  let state = sessions.get(sessionId);
  if (!state) {
    state = createInitialState();
    sessions.set(sessionId, state);
  }
  return state;
}

function relaySpeechEvent(sessionId: string, event: SpeechEvent): void {
  sendToClient(sessionId, {
    type: "agent_event",
    event: event.type,
    text: event.text,
    raw: event,
  });
}

function deliverMessages(sessionId: string, messages: OutboundMessage[]): void {
  for (const message of messages) {
    sendToClient(sessionId, message);
  }
}

function speakLines(sessionId: string, lines: string[]): void {
  for (const line of lines) {
    speak(sessionId, line);
  }
}

async function applyTurn(
  sessionId: string,
  result: Awaited<ReturnType<typeof handleUtterance>>,
): Promise<void> {
  sessions.set(sessionId, result.state);
  speakLines(sessionId, result.speakLines);
  deliverMessages(sessionId, result.messages);

  if (result.pendingWeather) {
    const weatherResult = await resolveWeatherTurn(
      result.state,
      result.pendingWeather.city,
      result.pendingWeather.country,
    );
    sessions.set(sessionId, weatherResult.state);
    speakLines(sessionId, weatherResult.speakLines);
    deliverMessages(sessionId, weatherResult.messages);
  }
}

async function onUserText(sessionId: string, text: string): Promise<void> {
  const state = getState(sessionId);
  const result = handleUtterance(state, text);
  await applyTurn(sessionId, result);
}

defineAgent({
  onSessionStart({ sessionId }) {
    sessions.set(sessionId, createInitialState());
    sendToClient(sessionId, {
      type: "agent_event",
      event: "session_start",
      sessionId,
    });
    speak(sessionId, GREETING);
    sendToClient(sessionId, { type: "chat_reply", text: GREETING });
    agentLog("info", `voice-showcase session_start ${sessionId}`);
  },

  onSpeechEvent({ sessionId }, event: SpeechEvent) {
    relaySpeechEvent(sessionId, event);
  },

  onUserSpeechFinal({ sessionId, text }) {
    void onUserText(sessionId, text);
  },

  onDataChannelMessage(ctx) {
    const text = parseChatText(ctx.message);
    if (!text) return;
    void onUserText(ctx.sessionId, text);
  },

  onSessionEnd({ sessionId }) {
    sessions.delete(sessionId);
    sendToClient(sessionId, {
      type: "agent_event",
      event: "session_end",
      sessionId,
    });
    agentLog("info", `voice-showcase session_end ${sessionId}`);
  },
});
