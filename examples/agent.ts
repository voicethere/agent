/**
 * Default agent bundle — built to `dist/agent.js` for local runner dev.
 * Same speech event handling as `templates/voice-starter/agent.ts` (imports from src for this repo).
 *
 *   cd agent && npm run build
 *   AGENT_BUNDLE_PATH=../agent/dist/agent.js npm run start   # on your agent runner checkout
 */

import type { SpeechEvent } from "../src/protocol.js";
import {
  agentLog,
  defineAgent,
  parseChatText,
  sendToClient,
  speak,
} from "../src/runtime.js";

interface PeerState {
  agentSpeaking: boolean;
  lastPartial: string;
}

const peers = new Map<string, PeerState>();

function peerState(sessionId: string): PeerState {
  let state = peers.get(sessionId);
  if (!state) {
    state = {
      agentSpeaking: false,
      lastPartial: "",
    };
    peers.set(sessionId, state);
  }
  return state;
}

function formatSpeechDetail(speech: SpeechEvent): string {
  if (speech.text) return `"${speech.text}"`;
  if (speech.error) return speech.error;
  const reason = (speech as SpeechEvent & { reason?: string }).reason;
  if (reason) return reason;
  return "";
}

function handleSpeechEvent(sessionId: string, speech: SpeechEvent): void {
  const state = peerState(sessionId);
  const detail = formatSpeechDetail(speech);

  switch (speech.type) {
    case "user_speech_final":
      state.lastPartial = "";
      agentLog("info", `[${sessionId}] user_speech_final ${detail}`);
      break;
    case "agent_speaking_start":
      state.agentSpeaking = true;
      agentLog("info", `[${sessionId}] agent_speaking_start`);
      break;
    case "agent_speaking_end":
      state.agentSpeaking = false;
      agentLog("info", `[${sessionId}] agent_speaking_end`);
      break;
    case "barge_in":
      agentLog("info", `[${sessionId}] barge_in`);
      break;
    default:
      // Other types are not delivered, apart from the language-switch events in RUNNER_LANGUAGE_SWITCH_EVENTS.
      break;
  }
}

defineAgent({
  onSessionStart({ sessionId }) {
    speak(sessionId, "Hello! How can I help?");
  },

  onSpeechEvent({ sessionId }, speech) {
    handleSpeechEvent(sessionId, speech);
  },

  onUserSpeechFinal({ sessionId, text }) {
    speak(sessionId, `You said: ${text}`);
  },

  onDataChannelMessage({ sessionId, message }) {
    const text = parseChatText(message);
    if (!text) return;
    agentLog("info", `[${sessionId}] chat_received "${text}"`);
    speak(sessionId, `You wrote: ${text}`);
    sendToClient(sessionId, { type: "chat_echo", text });
  },

  onSessionEnd({ sessionId }) {
    peers.delete(sessionId);
    agentLog("info", `session_end ${sessionId}`);
  },
});
