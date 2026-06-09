/**
 * Default agent bundle — built to `dist/agent.js` for local runner dev.
 * Same event coverage as `templates/agent.ts` (imports from src for this repo).
 *
 *   cd agent && npm run build
 *   cd ../runner && AGENT_BUNDLE_PATH=../agent/dist/agent.js npm run start
 */

import type { SpeechEvent } from "../src/protocol.js";
import { agentLog, defineAgent, speak } from "../src/runtime.js";

interface PeerState {
  userSpeaking: boolean;
  agentSpeaking: boolean;
  lastPartial: string;
  sttActive: boolean;
}

const peers = new Map<string, PeerState>();

function peerState(sessionId: string): PeerState {
  let state = peers.get(sessionId);
  if (!state) {
    state = {
      userSpeaking: false,
      agentSpeaking: false,
      lastPartial: "",
      sttActive: false,
    };
    peers.set(sessionId, state);
  }
  return state;
}

function formatSpeechDetail(speech: SpeechEvent): string {
  if (speech.text) return `"${speech.text}"`;
  if (speech.error) return speech.error;
  return "";
}

function handleSpeechEvent(sessionId: string, speech: SpeechEvent): void {
  const state = peerState(sessionId);
  const detail = formatSpeechDetail(speech);

  switch (speech.type) {
    case "user_speaking_start":
      state.userSpeaking = true;
      agentLog("info", `[${sessionId}] user_speaking_start`);
      break;
    case "user_speaking_end":
      state.userSpeaking = false;
      agentLog("info", `[${sessionId}] user_speaking_end`);
      break;
    case "vad_triggered":
      agentLog("info", `[${sessionId}] vad_triggered`);
      break;
    case "stt_stream_start":
      agentLog("info", `[${sessionId}] stt_stream_start`);
      break;
    case "stt_stream_end":
      agentLog("info", `[${sessionId}] stt_stream_end`);
      break;
    case "user_stt_start":
      state.sttActive = true;
      state.lastPartial = "";
      agentLog("info", `[${sessionId}] user_stt_start`);
      break;
    case "user_stt_end":
      state.sttActive = false;
      agentLog("info", `[${sessionId}] user_stt_end`);
      break;
    case "user_stt_not_found":
      agentLog("info", `[${sessionId}] user_stt_not_found`);
      break;
    case "user_speech_partial":
      state.lastPartial = speech.text ?? "";
      agentLog("info", `[${sessionId}] user_speech_partial ${detail}`);
      break;
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
    case "error":
      agentLog("error", `[${sessionId}] error: ${speech.error ?? "unknown"}`);
      break;
    default: {
      const _exhaustive: never = speech.type;
      agentLog("error", `[${sessionId}] unhandled: ${String(_exhaustive)}`);
    }
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

  onSessionEnd({ sessionId }) {
    peers.delete(sessionId);
    agentLog("info", `session_end ${sessionId}`);
  },
});
