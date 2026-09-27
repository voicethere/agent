/**
 * Change STT and TTS separately, including the vendor, while the call stays up.
 *
 * The runner reports `user_language` and does not change either side. This
 * agent switches the Sherpa voice and the Sherpa STT model as two calls, so
 * one side can fail without blocking the other. Chat commands change a single
 * vendor mid-conversation:
 *
 * - `/tts sherpa de` — Sherpa TTS only
 * - `/stt sherpa de` — Sherpa STT only
 * - `/tts elevenlabs` — ElevenLabs TTS, current STT stays
 * - `/stt deepgram de` — Deepgram STT, current voice stays
 *
 * Vendor API keys are project secrets already on the running deploy. Do not
 * put keys in this file. See /docs/spoken-language.
 */
import {
  agentLog,
  defineAgent,
  parseChatText,
  setVoiceLanguage,
  speak,
  type VoiceLanguageResult,
} from "@voicethere/agent";

const ECHO_PREFIX = "you said:";
const ECHO_WAIT_MS = 4000;

const REPLIES: Record<string, string> = {
  de: "Guten Tag. Ich antworte jetzt auf Deutsch.",
  es: "Hola. Ahora respondo en español.",
  fr: "Bonjour. Je réponds maintenant en français.",
  it: "Ciao. Adesso rispondo in italiano.",
  pt: "Olá. Agora respondo em português.",
  nl: "Hallo. Ik antwoord nu in het Nederlands.",
  pl: "Dzień dobry. Teraz odpowiadam po polsku.",
  ru: "Здравствуйте. Теперь я отвечаю по-русски.",
};

type SessionLanguage = {
  language: string;
  echoTimer: ReturnType<typeof setTimeout> | undefined;
  suppressNextFinal: boolean;
};

const sessions = new Map<string, SessionLanguage>();

function stateFor(sessionId: string): SessionLanguage {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const created: SessionLanguage = {
    language: "en",
    echoTimer: undefined,
    suppressNextFinal: false,
  };
  sessions.set(sessionId, created);
  return created;
}

function replyFor(language: string): string {
  return REPLIES[language] ?? `Continuing in ${language}.`;
}

function logSwitch(sessionId: string, side: string, result: VoiceLanguageResult): void {
  if (!result.ok) {
    agentLog("warn", `setVoiceLanguage ${side} failed: ${result.reason ?? "unknown"}`);
    return;
  }
  const provider = side === "tts" ? result.ttsProvider : result.sttProvider;
  const model = side === "tts" ? result.voice : result.stt;
  agentLog(
    "info",
    `voice ${side} ${sessionId} ${result.language ?? ""} provider=${provider ?? "unchanged"} model=${model ?? "unchanged"}`,
  );
}

defineAgent({
  onSessionStart({ sessionId }) {
    stateFor(sessionId);
    agentLog("info", `language-switch session_start ${sessionId}`);
  },

  async onUserLanguage({ sessionId, language }) {
    const state = stateFor(sessionId);
    if (!language || language === state.language) return;

    if (state.echoTimer) {
      clearTimeout(state.echoTimer);
      state.echoTimer = undefined;
    } else {
      state.suppressNextFinal = true;
    }

    const tts = await setVoiceLanguage(sessionId, {
      scope: "tts",
      language,
      voice: language,
    });
    logSwitch(sessionId, "tts", tts);

    const stt = await setVoiceLanguage(sessionId, {
      scope: "stt",
      language,
      stt: language,
    });
    logSwitch(sessionId, "stt", stt);

    if (!tts.ok) {
      state.suppressNextFinal = false;
      return;
    }

    state.language = language;
    speak(sessionId, replyFor(language));
  },

  async onDataChannelMessage(ctx) {
    const text = parseChatText(ctx.message);
    if (!text) return;
    const [command, vendor, language] = text.trim().split(/\s+/);
    if (command === "/tts" && vendor === "sherpa" && language) {
      const result = await setVoiceLanguage(ctx.sessionId, {
        scope: "tts",
        language,
        ttsVendor: { provider: "local-sherpa", voice: language },
      });
      logSwitch(ctx.sessionId, "tts", result);
      if (result.ok) speak(ctx.sessionId, replyFor(language));
      return;
    }
    if (command === "/stt" && vendor === "sherpa" && language) {
      const result = await setVoiceLanguage(ctx.sessionId, {
        scope: "stt",
        language,
        sttVendor: { provider: "local-sherpa", model: language },
      });
      logSwitch(ctx.sessionId, "stt", result);
      return;
    }
    if (command === "/tts" && vendor === "elevenlabs") {
      const result = await setVoiceLanguage(ctx.sessionId, {
        scope: "tts",
        ttsVendor: { provider: "elevenlabs", model: "eleven_multilingual_v2" },
      });
      logSwitch(ctx.sessionId, "tts", result);
      if (result.ok) speak(ctx.sessionId, "Speaking with ElevenLabs.");
      return;
    }
    if (command === "/stt" && vendor === "deepgram") {
      const result = await setVoiceLanguage(ctx.sessionId, {
        scope: "stt",
        sttVendor: {
          provider: "deepgram",
          model: "nova-3",
          language: language || "en",
        },
      });
      logSwitch(ctx.sessionId, "stt", result);
    }
  },

  onUserSpeechFinal({ sessionId, text }) {
    const state = stateFor(sessionId);
    if (state.suppressNextFinal) {
      state.suppressNextFinal = false;
      return;
    }
    if (state.echoTimer) clearTimeout(state.echoTimer);
    state.echoTimer = setTimeout(() => {
      state.echoTimer = undefined;
      speak(sessionId, `${ECHO_PREFIX} ${text}`.trim());
    }, ECHO_WAIT_MS);
  },

  onSessionEnd({ sessionId }) {
    const state = sessions.get(sessionId);
    if (state?.echoTimer) clearTimeout(state.echoTimer);
    sessions.delete(sessionId);
  },
});
