/**
 * Change STT and TTS separately, including the vendor, while the call stays up.
 *
 * Two deployment modes (see README):
 *
 * (A) Project auto-switch off — this agent calls `setVoiceLanguage` from
 *     `onUserLanguage` when LID detects a new language. The runner plays
 *     nothing for manual switches and the target pools may be cold for
 *     several seconds, so the agent first speaks a wait message in the
 *     language being left (current voice), waits for `agent_speaking_end`
 *     (at most WAIT_SPEECH_TIMEOUT_MS) so the runner does not swap the voice
 *     mid-sentence, then switches TTS and STT, then replies in the new
 *     language. If the switch fails it speaks a short
 *     fallback in the old language and stays. Texts live in WAIT_MESSAGES /
 *     FAILED_MESSAGES and can be overridden per language with the session env
 *     vars LANGUAGE_SWITCH_WAIT_MESSAGES_JSON and
 *     LANGUAGE_SWITCH_FAILED_MESSAGES_JSON (JSON object, ISO 639-1 -> text).
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

/** Spoken in the language being left, before a manual switch starts. */
export const WAIT_MESSAGES: Record<string, string> = {
  en: "One moment please, I'm switching to your language.",
  de: "Einen Moment bitte, ich wechsle zu Ihrer Sprache.",
  es: "Un momento, por favor, estoy cambiando a su idioma.",
  fr: "Un instant, je passe dans votre langue.",
  it: "Un momento, per favore, sto passando alla tua lingua.",
  pt: "Um momento, por favor, estou mudando para o seu idioma.",
  nl: "Een moment alstublieft, ik schakel over naar uw taal.",
  pl: "Chwileczkę, przełączam się na Twój język.",
  ru: "Одну минуту, я перехожу на ваш язык.",
};

/** Spoken in the old language when the switch fails and the agent stays. */
export const FAILED_MESSAGES: Record<string, string> = {
  en: "Sorry, I couldn't switch languages. I'll keep going in English.",
  de: "Entschuldigung, der Sprachwechsel hat nicht geklappt. Ich bleibe bei Deutsch.",
  es: "Lo siento, no pude cambiar de idioma. Sigo en español.",
  fr: "Désolé, je n'ai pas pu changer de langue. Je continue en français.",
  it: "Mi dispiace, non sono riuscito a cambiare lingua. Continuo in italiano.",
  pt: "Desculpe, não consegui mudar de idioma. Continuo em português.",
  nl: "Sorry, het wisselen van taal is niet gelukt. Ik blijf Nederlands spreken.",
  pl: "Przepraszam, nie udało się zmienić języka. Zostaję przy polskim.",
  ru: "Извините, не удалось сменить язык. Продолжаю по-русски.",
};

export const WAIT_MESSAGES_ENV = "LANGUAGE_SWITCH_WAIT_MESSAGES_JSON";
export const FAILED_MESSAGES_ENV = "LANGUAGE_SWITCH_FAILED_MESSAGES_JSON";

/**
 * Parse a per-language override from a session env var. Accepts a JSON object
 * of language code -> non-empty string; anything else yields no overrides.
 */
export function parseMessageOverrides(
  raw: string | undefined,
): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value.trim()) {
      out[key.trim().toLowerCase()] = value.trim();
    }
  }
  return out;
}

/** Message for `language`: override, then default, then English default. */
export function pickMessage(
  defaults: Record<string, string>,
  overrides: Record<string, string>,
  language: string,
): string {
  return (
    overrides[language] ?? defaults[language] ?? overrides.en ?? defaults.en!
  );
}

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
  pendingSwitch:
    | {
        language: string;
        previous: string;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  switching: boolean;
  waitOverrides: Record<string, string>;
  failedOverrides: Record<string, string>;
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
    pendingSwitch: undefined,
    switching: false,
    waitOverrides: parseMessageOverrides(env?.[WAIT_MESSAGES_ENV]),
    failedOverrides: parseMessageOverrides(env?.[FAILED_MESSAGES_ENV]),
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

/** Upper bound for waiting on the wait message before switching anyway. */
export const WAIT_SPEECH_TIMEOUT_MS = 8000;

/** Consume the pending switch (once) and run it without blocking handlers. */
function startSwitch(sessionId: string, state: SessionLanguage): void {
  const pending = state.pendingSwitch;
  if (!pending) return;
  clearTimeout(pending.timer);
  state.pendingSwitch = undefined;
  state.switching = true;
  void runSwitch(sessionId, state, pending.language, pending.previous)
    .catch((error: unknown) => {
      state.suppressNextFinal = false;
      agentLog("warn", `language-switch ${sessionId} failed: ${String(error)}`);
    })
    .finally(() => {
      state.switching = false;
    });
}

async function runSwitch(
  sessionId: string,
  state: SessionLanguage,
  language: string,
  previous: string,
): Promise<void> {
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
    // Switch failed (for example a timeout): the voice is unchanged, so
    // apologise in the old language and stay.
    speak(
      sessionId,
      pickMessage(FAILED_MESSAGES, state.failedOverrides, previous),
    );
    return;
  }

  state.language = language;
  speak(sessionId, replyFor(language));
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

    // A switch is already waiting for the wait message or in flight.
    if (state.pendingSwitch || state.switching) return;

    prepareLanguageTransition(state);

    // The runner plays nothing for manual switches and the target pools may be
    // cold, so tell the user first, in the language being left. Early LID can
    // fire while the caller is still talking, so the wait message must not be
    // cut by barge-in.
    const previous = state.language;
    speak(
      sessionId,
      pickMessage(WAIT_MESSAGES, state.waitOverrides, previous),
      {
        interruptible: false,
      },
    );

    // `speak` is fire-and-forget and the runner swaps the TTS without draining
    // it, so the switch must wait until the wait message has been spoken
    // (`agent_speaking_end`, delivered to onSpeechEvent). Inbound handlers of
    // one session run strictly in order, so this handler must return instead
    // of awaiting that event. The bounded timer covers a missing event.
    const timer = setTimeout(() => {
      agentLog(
        "warn",
        `language-switch ${sessionId} no agent_speaking_end within ${WAIT_SPEECH_TIMEOUT_MS}ms; switching anyway`,
      );
      startSwitch(sessionId, state);
    }, WAIT_SPEECH_TIMEOUT_MS);
    state.pendingSwitch = { language, previous, timer };
  },

  onSpeechEvent({ sessionId }, event) {
    if (event.type !== "agent_speaking_end") return;
    const state = sessions.get(sessionId);
    if (state?.pendingSwitch) startSwitch(sessionId, state);
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
    if (state?.pendingSwitch) clearTimeout(state.pendingSwitch.timer);
    sessions.delete(sessionId);
  },
});
