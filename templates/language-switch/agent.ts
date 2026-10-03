/**
 * Change STT and TTS separately, including the vendor, while the call stays up.
 *
 * Two deployment modes (see README):
 *
 * (A) Project auto-switch off — this agent calls `setVoiceLanguage` from
 *     `onUserLanguage` when LID detects a new language.
 * (B) Project enables runner auto-switch — STT/TTS are runner-owned. The
 *     runner replays the utterance into the new language's STT, so the next
 *     final is the correctly recognized text. The agent never calls
 *     `setVoiceLanguage`; it remembers the language and answers each final
 *     right away with a short localized prefix ("Du hast gesagt: …").
 *
 * Chat commands change a single vendor mid-conversation:
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
  isRunnerLidAutoSwitchEnabled,
  parseChatText,
  setVoiceLanguage,
  speak,
  type VoiceLanguageResult,
} from "@voicethere/agent";

const ECHO_PREFIX = "you said:";
const ECHO_WAIT_MS = 4000;

/** Echo prefix per language for runner auto-switch mode. */
const ECHO_PREFIXES: Record<string, string> = {
  en: "you said:",
  de: "Du hast gesagt:",
  es: "Dijiste:",
  fr: "Tu as dit :",
  it: "Hai detto:",
  pt: "Você disse:",
  nl: "Je zei:",
  pl: "Powiedziałeś:",
  ru: "Вы сказали:",
};

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
  runnerAutoSwitch: boolean;
  echoTimer: ReturnType<typeof setTimeout> | undefined;
  suppressNextFinal: boolean;
};

const sessions = new Map<string, SessionLanguage>();

function stateFor(
  sessionId: string,
  env?: Record<string, string>,
): SessionLanguage {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const created: SessionLanguage = {
    language: "en",
    runnerAutoSwitch: env ? isRunnerLidAutoSwitchEnabled(env) : false,
    echoTimer: undefined,
    suppressNextFinal: false,
  };
  sessions.set(sessionId, created);
  return created;
}

function replyFor(language: string): string {
  return REPLIES[language] ?? `Continuing in ${language}.`;
}

function echoPrefixFor(language: string): string {
  return ECHO_PREFIXES[language] ?? ECHO_PREFIXES.en!;
}

function logSwitch(
  sessionId: string,
  side: string,
  result: VoiceLanguageResult,
): void {
  if (!result.ok) {
    agentLog(
      "warn",
      `setVoiceLanguage ${side} failed: ${result.reason ?? "unknown"}`,
    );
    return;
  }
  const provider = side === "tts" ? result.ttsProvider : result.sttProvider;
  const model = side === "tts" ? result.voice : result.stt;
  agentLog(
    "info",
    `voice ${side} ${sessionId} ${result.language ?? ""} provider=${provider ?? "unchanged"} model=${model ?? "unchanged"}`,
  );
}

function prepareLanguageTransition(state: SessionLanguage): void {
  if (state.echoTimer) {
    clearTimeout(state.echoTimer);
    state.echoTimer = undefined;
  } else {
    state.suppressNextFinal = true;
  }
}

defineAgent({
  onSessionStart({ sessionId, env }) {
    const state = stateFor(sessionId, env);
    if (state.runnerAutoSwitch) {
      agentLog(
        "info",
        `language-switch session_start ${sessionId} runner LID auto-switch owns STT/TTS`,
      );
    } else {
      agentLog(
        "info",
        `language-switch session_start ${sessionId} manual setVoiceLanguage`,
      );
    }
  },

  async onUserLanguage({ sessionId, language }) {
    const state = stateFor(sessionId);
    if (!language || language === state.language) return;

    if (state.runnerAutoSwitch) {
      // The runner switches STT/TTS and replays the utterance into the new
      // STT; the next final is the real utterance, so nothing is suppressed
      // and no fixed sentence is spoken.
      agentLog(
        "info",
        `LID detected ${language}; runner auto-switch applies STT/TTS — agent only remembers the language`,
      );
      state.language = language;
      return;
    }

    prepareLanguageTransition(state);

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

  async onVoiceLanguageChanged({ sessionId, language }) {
    const state = stateFor(sessionId);
    if (!state.runnerAutoSwitch || !language || language === state.language) {
      return;
    }
    agentLog(
      "info",
      `runner committed voice language ${language} for ${sessionId}`,
    );
    state.language = language;
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
    if (state.runnerAutoSwitch) {
      // Reply immediately: the runner already holds the final until LID has
      // decided, so no extra wait is needed to avoid a wrong-language echo.
      speak(sessionId, `${echoPrefixFor(state.language)} ${text}`.trim());
      return;
    }
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
