/**
 * Recording consent template — ask consent, pause for PII, resume when allowed.
 *
 * Build:
 *   npx @voicethere/agent build --entry templates/recording-consent/agent.ts
 */
import {
  agentLog,
  defineAgent,
  parseChatText,
  pauseRecording,
  resumeRecording,
  sendToClient,
  speak,
  stopRecording,
  type SpeechEvent,
} from "@voicethere/agent";

import {
  beginSession,
  handleUtterance,
  type ConversationState,
  type ConversationTurnResult,
  type OutboundMessage,
  type RecordingAction,
} from "./conversation.js";

let sessions = new Map<string, ConversationState>();
/** Per-session consent flag (shared-child safe — not one process-wide boolean). */
let consentBySessionId = new Map<string, boolean>();

function getState(sessionId: string): ConversationState {
  const state = sessions.get(sessionId);
  if (!state) {
    throw new Error(
      `recording-consent: missing session state for ${sessionId}`,
    );
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

async function applyRecordingAction(
  sessionId: string,
  action: RecordingAction,
): Promise<void> {
  if (!action) return;
  switch (action) {
    case "pause":
      await pauseRecording(sessionId);
      break;
    case "stop":
      await stopRecording(sessionId);
      break;
    case "start":
    case "resume":
      await resumeRecording(sessionId);
      break;
  }
}

async function applyTurn(
  sessionId: string,
  result: ConversationTurnResult,
): Promise<void> {
  sessions.set(sessionId, result.state);
  if (result.state.consent !== undefined) {
    consentBySessionId.set(sessionId, result.state.consent);
  }
  if (result.warnRecordingDisabled) {
    agentLog(
      "warn",
      "Project conversation recording is disabled; skipping consent and will not call startRecording",
      sessionId,
    );
  }
  speakLines(sessionId, result.speakLines);
  deliverMessages(sessionId, result.messages);
  await applyRecordingAction(sessionId, result.recordingAction);
}

async function onUserText(sessionId: string, text: string): Promise<void> {
  const state = getState(sessionId);
  const result = handleUtterance(state, text);
  await applyTurn(sessionId, result);
}

defineAgent({
  onAgentStart() {
    sessions = new Map();
    consentBySessionId = new Map();
  },

  onSessionStart({ sessionId, recordingAvailable }) {
    const result = beginSession(recordingAvailable);
    sessions.set(sessionId, result.state);
    if (result.warnRecordingDisabled) {
      agentLog(
        "warn",
        "Project conversation recording is disabled; skipping consent and will not call startRecording",
        sessionId,
      );
    }
    speakLines(sessionId, result.speakLines);
    deliverMessages(sessionId, result.messages);
    sendToClient(sessionId, {
      type: "agent_event",
      event: "session_start",
      sessionId,
    });
    agentLog(
      "info",
      `recording-consent session_start ${sessionId} recordingAvailable=${recordingAvailable}`,
      sessionId,
    );
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
    consentBySessionId.delete(sessionId);
    sendToClient(sessionId, {
      type: "agent_event",
      event: "session_end",
      sessionId,
    });
    agentLog("info", `recording-consent session_end ${sessionId}`, sessionId);
  },
});
