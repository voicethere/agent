/**
 * Switch the speaking voice when spoken-language detection changes.
 *
 * The runner reports `user_language` and does not change TTS by itself.
 * This agent calls `setVoiceLanguage`, then speaks in the new language.
 * The revealing utterance is not echoed (the English STT transcript of a
 * German sentence is not what we want to say back).
 *
 * `voice` and `stt` are catalog ids. See /docs/spoken-language.
 */
import {
  agentLog,
  defineAgent,
  setVoiceLanguage,
  speak,
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

    const result = await setVoiceLanguage(sessionId, {
      language,
      voice: language,
      stt: language,
    });
    if (!result.ok) {
      state.suppressNextFinal = false;
      agentLog(
        "warn",
        `setVoiceLanguage ${language} failed: ${result.reason ?? "unknown"}`,
      );
      return;
    }

    state.language = language;
    agentLog("info", `voice language ${sessionId} ${language} voice=${result.voice}`);
    speak(sessionId, replyFor(language));
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
