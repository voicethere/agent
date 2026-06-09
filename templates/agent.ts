/**
 * Full starter template — copy into your project and build to a single `agent.js` bundle.
 *
 * Handles every `SpeechEvent` from the runner voice pipeline (`@node-webrtc-rust/sdk/voice`).
 * Replace the stub bodies with your product logic; keep `onUserSpeechFinal` as the main turn hook.
 *
 * Build:
 *   npm install @voicethere/agent
 *   npx @voicethere/agent build
 *
 * Voice E2E (VoiceThere agent runner — platform or internal deployment):
 *   AGENT_BUNDLE_PATH=./dist/agent.js npm run start
 */

import {
  agentLog,
  defineAgent,
  speak,
  type SpeechEvent,
} from "@voicethere/agent";

/** Per-peer conversational state — extend or replace with your store. */
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

/**
 * Dispatch every speech lifecycle event from the parent Sherpa/VAD/STT/TTS pipeline.
 * `speech.type` values match `SpeechEventType` in `@node-webrtc-rust/sdk/voice`.
 */
function handleSpeechEvent(sessionId: string, speech: SpeechEvent): void {
  const state = peerState(sessionId);
  const detail = formatSpeechDetail(speech);

  switch (speech.type) {
    // --- User turn (VAD + STT) ---
    case "user_speaking_start":
      state.userSpeaking = true;
      agentLog("info", `[${sessionId}] user_speaking_start`);
      break;

    case "user_speaking_end":
      state.userSpeaking = false;
      agentLog("info", `[${sessionId}] user_speaking_end`);
      break;

    case "vad_triggered":
      agentLog(
        "info",
        `[${sessionId}] vad_triggered — STT listen window opened`,
      );
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
      agentLog(
        "info",
        `[${sessionId}] user_stt_not_found — no speech recognized in listen window`,
      );
      // Optional: speak(sessionId, "I didn't catch that. Could you repeat?")
      break;

    case "user_speech_partial":
      state.lastPartial = speech.text ?? "";
      agentLog("info", `[${sessionId}] user_speech_partial ${detail}`);
      // Optional: live captions, early intent detection, custom barge-in rules
      break;

    case "user_speech_final":
      state.lastPartial = "";
      agentLog("info", `[${sessionId}] user_speech_final ${detail}`);
      // Primary turn boundary — `onUserSpeechFinal` runs after this for convenience
      break;

    // --- Agent playback (TTS) ---
    case "agent_speaking_start":
      state.agentSpeaking = true;
      agentLog("info", `[${sessionId}] agent_speaking_start`);
      break;

    case "agent_speaking_end":
      state.agentSpeaking = false;
      agentLog("info", `[${sessionId}] agent_speaking_end`);
      break;

    case "barge_in":
      agentLog(
        "info",
        `[${sessionId}] barge_in — user interrupted agent playback`,
      );
      // Optional: cancel in-flight LLM/TTS work keyed by sessionId
      break;

    case "error":
      agentLog(
        "error",
        `[${sessionId}] pipeline error: ${speech.error ?? "unknown"}`,
      );
      break;

    default: {
      const _exhaustive: never = speech.type;
      agentLog(
        "error",
        `[${sessionId}] unhandled speech event: ${String(_exhaustive)}`,
      );
    }
  }
}

defineAgent({
  onSessionStart({ sessionId, env }) {
    agentLog("info", `session_start ${sessionId} env=${JSON.stringify(env)}`);
    speak(sessionId, "Hello! How can I help?");
  },

  onSpeechEvent({ sessionId }, speech) {
    handleSpeechEvent(sessionId, speech);
  },

  onUserSpeechFinal({ sessionId, text }) {
    // Replace with LLM / tool calls / business logic
    speak(sessionId, `You said: ${text}`);
  },

  onSessionEnd({ sessionId }) {
    peers.delete(sessionId);
    agentLog("info", `session_end ${sessionId}`);
  },
});
