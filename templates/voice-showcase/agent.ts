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
  type ConversationTurnResult,
} from "./conversation.js";
import {
  applyOutboundOps,
  greetingOps,
  spokenThenPlayOps,
} from "./delivery.js";

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

function deliverSpokenThenPlay(
  sessionId: string,
  result: Pick<ConversationTurnResult, "messages" | "speakLines">,
): void {
  applyOutboundOps(
    sessionId,
    spokenThenPlayOps(result.messages, result.speakLines),
    { sendToClient, speak },
  );
}

async function applyTurn(
  sessionId: string,
  result: ConversationTurnResult,
): Promise<void> {
  sessions.set(sessionId, result.state);
  deliverSpokenThenPlay(sessionId, result);

  if (result.pendingWeather) {
    const weatherResult = await resolveWeatherTurn(
      result.state,
      result.pendingWeather.city,
      result.pendingWeather.country,
    );
    sessions.set(sessionId, weatherResult.state);
    deliverSpokenThenPlay(sessionId, weatherResult);
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
    applyOutboundOps(sessionId, greetingOps(sessionId, GREETING), {
      sendToClient,
      speak,
    });
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
