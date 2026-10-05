/**
 * Change STT and TTS separately, including the vendor, while the call stays up.
 *
 * Two deployment modes (see README):
 *
 * (A) Project auto-switch off (manual mode) — this agent runs the whole switch
 *     flow with three runner primitives, and the caller is never interrupted:
 *     1. `onUserLanguage` sees a new language: start `prepareVoiceLanguage`
 *        (warms the target pools) and wait for the caller to finish.
 *     2. The next final is the switch utterance. The agent does not answer it.
 *        If the pools are ready it calls `setVoiceLanguage` at once; otherwise
 *        it speaks a wait message in the current voice and awaits the pools.
 *     3. `replayLastUtterance` runs that utterance through the new STT. The
 *        replayed final (`replay: true`) is answered in the new language.
 *     A slow switch plays a ready message in the new voice; any failure speaks
 *     a short apology in the old language. Texts come from the project
 *     settings (`getVoiceLanguageSwitchSettings`), then WAIT_MESSAGES /
 *     READY_MESSAGES / FAILED_MESSAGES, and env vars
 *     LANGUAGE_SWITCH_WAIT_MESSAGES_JSON / LANGUAGE_SWITCH_FAILED_MESSAGES_JSON
 *     (JSON object, ISO 639-1 -> text) win. The built-in vendor is
 *     VoiceThere (id `local-sherpa`); edit PROFILES to use other vendors.
 * (B) Project enables runner auto-switch — STT/TTS are runner-owned. The
 *     runner replays the utterance into the new language's STT, so the next
 *     final is the correctly recognized text. The agent never calls
 *     `setVoiceLanguage`; it remembers the language and answers each final
 *     right away with a short localized prefix ("Du hast gesagt: …").
 *
 * Every step logs a `language_switch.<decision>` line with structured fields
 * (languages, timings, reasons; never the caller's words).
 *
 * Chat commands change a single vendor mid-conversation:
 *
 * - `/tts sherpa de` — VoiceThere TTS only
 * - `/stt sherpa de` — VoiceThere STT only
 * - `/tts elevenlabs` — ElevenLabs TTS, current STT stays
 * - `/stt deepgram de` — Deepgram STT, current voice stays
 *
 * Vendor API keys are project secrets already on the running deploy. Do not
 * put keys in this file. See /docs/spoken-language.
 */
import {
  agentLog,
  defineAgent,
  getVoiceLanguageSwitchSettings,
  isRunnerLidAutoSwitchEnabled,
  parseChatText,
  prepareVoiceLanguage,
  replayLastUtterance,
  setVoiceLanguage,
  speak,
  type SetVoiceLanguageOptions,
  type VoiceLanguagePrepareResult,
  type VoiceLanguageResult,
} from "@voicethere/agent";

/**
 * What to apply per target language. The default is the built-in VoiceThere
 * vendor (`local-sherpa`): voice and STT model named after the language. A
 * profile can name other vendors; keys stay in project secrets. Example:
 *
 *   de: {
 *     scope: "both",
 *     language: "de",
 *     sttVendor: { provider: "deepgram", model: "nova-3", language: "de" },
 *     ttsVendor: { provider: "elevenlabs", model: "eleven_multilingual_v2" },
 *   },
 */
export const PROFILES: Record<string, SetVoiceLanguageOptions> = {};

export function profileFor(language: string): SetVoiceLanguageOptions {
  return (
    PROFILES[language] ?? {
      scope: "both",
      language,
      voice: language,
      stt: language,
    }
  );
}

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

/** Spoken in the new voice when the switch was slow. */
export const READY_MESSAGES: Record<string, string> = {
  en: "Okay, let's continue in English.",
  de: "Okay, machen wir auf Deutsch weiter.",
  es: "Vale, sigamos en español.",
  fr: "D'accord, continuons en français.",
  it: "Va bene, continuiamo in italiano.",
  pt: "Certo, vamos continuar em português.",
  nl: "Oké, we gaan verder in het Nederlands.",
  pl: "Dobrze, kontynuujmy po polsku.",
};

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  de: "German",
  es: "Spanish",
  fr: "French",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  pl: "Polish",
  ru: "Russian",
  hi: "Hindi",
};

/** Used when the project settings carry no ready-message timing. */
export const DEFAULT_READY_MESSAGE_MIN_MS = 2000;

/** Ready message: project setting, then built-in text, then an English template. */
export function readyMessageFor(
  language: string,
  fromSettings: Record<string, string> | undefined,
): string {
  return (
    fromSettings?.[language] ??
    READY_MESSAGES[language] ??
    `Okay, let's continue in ${LANGUAGE_NAMES[language] ?? language}.`
  );
}

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

type SwitchInFlight = {
  from: string;
  to: string;
  profile: SetVoiceLanguageOptions;
  detectedAtMs: number;
  prepare: Promise<VoiceLanguagePrepareResult>;
  /** Set when the prepare call settled; undefined while the pools are warming. */
  prepareResult: VoiceLanguagePrepareResult | undefined;
  waitMessagePlayed: boolean;
  /** `awaiting_utterance` until the caller's next final starts the swap. */
  phase: "awaiting_utterance" | "running";
};

type SessionLanguage = {
  language: string;
  runnerAutoSwitch: boolean;
  echoTimer: ReturnType<typeof setTimeout> | undefined;
  active: SwitchInFlight | undefined;
  speechWaiter:
    { resolve: () => void; timer: ReturnType<typeof setTimeout> } | undefined;
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
    active: undefined,
    speechWaiter: undefined,
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

/** Upper bound for waiting on a protected message before moving on. */
export const WAIT_SPEECH_TIMEOUT_MS = 8000;

/** Resolves on the next `agent_speaking_end` (see onSpeechEvent) or after the bound. */
function waitForSpeechEnd(state: SessionLanguage): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      state.speechWaiter = undefined;
      resolve();
    }, WAIT_SPEECH_TIMEOUT_MS);
    state.speechWaiter = {
      resolve: () => {
        clearTimeout(timer);
        state.speechWaiter = undefined;
        resolve();
      },
      timer,
    };
  });
}

function waitMessageFor(
  state: SessionLanguage,
  language: string,
  fromSettings: Record<string, string> | undefined,
): string {
  return pickMessage(
    WAIT_MESSAGES,
    { ...fromSettings, ...state.waitOverrides },
    language,
  );
}

/** Apologise in the old language and stay; logs the failed step. */
function failSwitch(
  sessionId: string,
  state: SessionLanguage,
  sw: SwitchInFlight,
  step: string,
  reason: string,
): void {
  if (state.active === sw) state.active = undefined;
  agentLog(
    "warn",
    "language_switch.failed",
    { from: sw.from, to: sw.to, step, reason },
    sessionId,
  );
  speak(
    sessionId,
    pickMessage(FAILED_MESSAGES, state.failedOverrides, sw.from),
  );
}

/**
 * The caller finished the switch utterance. Swap the voices (waiting for the
 * pools if needed), then have the runner replay the utterance in the new
 * language. Runs outside the inbound handler: events such as
 * `agent_speaking_end` are delivered through the same ordered queue.
 */
async function runSwitch(
  sessionId: string,
  state: SessionLanguage,
  sw: SwitchInFlight,
  finalAtMs: number,
): Promise<void> {
  const settings = getVoiceLanguageSwitchSettings(sessionId);
  const mode = settings?.waitMessageMode ?? "end_of_utterance";
  const readyMinMs =
    settings?.readyMessageMinMs ?? DEFAULT_READY_MESSAGE_MIN_MS;
  const alive = () => sessions.get(sessionId) === state;

  let prepared = sw.prepareResult;
  if (!prepared) {
    // Not ready when the caller stopped: tell them, in the voice they hear now.
    if (mode !== "off" && !sw.waitMessagePlayed) {
      speak(sessionId, waitMessageFor(state, sw.from, settings?.waitMessages));
      sw.waitMessagePlayed = true;
      agentLog(
        "info",
        "language_switch.wait_message",
        {
          played: true,
          reason: "not_ready_at_end_of_utterance",
          language: sw.from,
        },
        sessionId,
      );
    } else if (!sw.waitMessagePlayed) {
      agentLog(
        "info",
        "language_switch.wait_message",
        { played: false, reason: "off", language: sw.from },
        sessionId,
      );
    }
    prepared = await sw.prepare;
    if (!alive()) return;
  }
  if (!prepared.ok || !prepared.ready) {
    failSwitch(
      sessionId,
      state,
      sw,
      "prepare",
      prepared.ok ? "not_ready" : prepared.reason,
    );
    return;
  }

  const swapped = await setVoiceLanguage(sessionId, sw.profile);
  if (!alive()) return;
  agentLog(
    "info",
    "language_switch.swap",
    {
      from: sw.from,
      to: sw.to,
      ok: swapped.ok,
      ...(swapped.ttsProvider ? { ttsProvider: swapped.ttsProvider } : {}),
      ...(swapped.sttProvider ? { sttProvider: swapped.sttProvider } : {}),
      ...(swapped.ok ? {} : { reason: swapped.reason ?? "unknown" }),
    },
    sessionId,
  );
  if (!swapped.ok) {
    failSwitch(sessionId, state, sw, "swap", swapped.reason ?? "unknown");
    return;
  }
  state.language = sw.to;

  // A slow switch with no wait message gets a short note in the new voice.
  const elapsedMs = finalAtMs - sw.detectedAtMs;
  let skipReason: string | undefined;
  if (sw.waitMessagePlayed) skipReason = "wait_message_played";
  else if (readyMinMs <= 0) skipReason = "disabled";
  else if (elapsedMs < readyMinMs) skipReason = "fast";
  if (skipReason) {
    agentLog(
      "info",
      "language_switch.ready_message",
      { played: false, reason: skipReason, to: sw.to, elapsedMs },
      sessionId,
    );
  } else {
    speak(sessionId, readyMessageFor(sw.to, settings?.readyMessages), {
      interruptible: false,
    });
    agentLog(
      "info",
      "language_switch.ready_message",
      { played: true, to: sw.to, elapsedMs },
      sessionId,
    );
    await waitForSpeechEnd(state);
    if (!alive()) return;
  }

  // From here the replayed final is a normal utterance.
  if (state.active === sw) state.active = undefined;
  const replay = await replayLastUtterance(sessionId);
  if (!alive()) return;
  agentLog(
    "info",
    "language_switch.replay",
    { ok: replay.ok, reason: replay.reason },
    sessionId,
  );
  if (!replay.ok) {
    failSwitch(sessionId, state, sw, "replay", replay.reason);
    return;
  }
  agentLog(
    "info",
    "language_switch.committed",
    { from: sw.from, to: sw.to, totalMs: Date.now() - sw.detectedAtMs },
    sessionId,
  );
}

defineAgent({
  onSessionStart({ sessionId, env }) {
    const state = stateFor(sessionId, env);
    if (state.runnerAutoSwitch) {
      agentLog(
        "info",
        "language_switch.session_start",
        { mode: "runner_auto_switch" },
        sessionId,
      );
    } else {
      agentLog(
        "info",
        "language_switch.session_start",
        { mode: "manual" },
        sessionId,
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
        "language_switch.detected",
        { from: state.language, to: language, mode: "runner_auto_switch" },
        sessionId,
      );
      state.language = language;
      return;
    }

    // A switch is already in flight.
    if (state.active) return;

    if (state.echoTimer) {
      clearTimeout(state.echoTimer);
      state.echoTimer = undefined;
    }

    // Warm the target pools now, while the caller is still talking. Nothing is
    // spoken until they stop, unless the project asks for the wait message at
    // detection time.
    const from = state.language;
    const profile = profileFor(language);
    const sw: SwitchInFlight = {
      from,
      to: language,
      profile,
      detectedAtMs: Date.now(),
      prepare: undefined as unknown as Promise<VoiceLanguagePrepareResult>,
      prepareResult: undefined,
      waitMessagePlayed: false,
      phase: "awaiting_utterance",
    };
    sw.prepare = prepareVoiceLanguage(sessionId, profile).then((result) => {
      sw.prepareResult = result;
      agentLog(
        "info",
        "language_switch.prepare",
        {
          to: language,
          ok: result.ok,
          ready: result.ready,
          reason: result.reason,
          afterMs: Date.now() - sw.detectedAtMs,
        },
        sessionId,
      );
      return result;
    });
    state.active = sw;
    agentLog(
      "info",
      "language_switch.detected",
      { from, to: language },
      sessionId,
    );

    const settings = getVoiceLanguageSwitchSettings(sessionId);
    if (settings?.waitMessageMode === "immediate") {
      // Not interruptible: the caller is still talking when this plays.
      speak(sessionId, waitMessageFor(state, from, settings.waitMessages), {
        interruptible: false,
      });
      sw.waitMessagePlayed = true;
      agentLog(
        "info",
        "language_switch.wait_message",
        { played: true, reason: "immediate", language: from },
        sessionId,
      );
    }
  },

  onSpeechEvent({ sessionId }, event) {
    if (event.type !== "agent_speaking_end") return;
    sessions.get(sessionId)?.speechWaiter?.resolve();
  },

  async onVoiceLanguageChanged({ sessionId, language }) {
    const state = stateFor(sessionId);
    if (!state.runnerAutoSwitch || !language || language === state.language) {
      return;
    }
    agentLog(
      "info",
      "language_switch.committed",
      { from: state.language, to: language, mode: "runner_auto_switch" },
      sessionId,
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

  onUserSpeechFinal({ sessionId, text, replay }) {
    const state = stateFor(sessionId);
    if (state.runnerAutoSwitch) {
      // Reply immediately: the runner already holds the final until LID has
      // decided, so no extra wait is needed to avoid a wrong-language echo.
      speak(sessionId, `${echoPrefixFor(state.language)} ${text}`.trim());
      return;
    }
    const sw = state.active;
    if (sw && sw.phase === "awaiting_utterance" && !replay) {
      // The switch utterance: do not answer it. The runner replays it through
      // the new STT once the swap is done.
      sw.phase = "running";
      const finalAtMs = Date.now();
      void runSwitch(sessionId, state, sw, finalAtMs).catch(
        (error: unknown) => {
          if (state.active === sw) state.active = undefined;
          agentLog(
            "warn",
            "language_switch.failed",
            {
              from: sw.from,
              to: sw.to,
              step: "unexpected",
              reason: String(error),
            },
            sessionId,
          );
        },
      );
      return;
    }
    if (replay) {
      // Replayed switch utterance: the language is decided, answer now.
      speak(sessionId, `${echoPrefixFor(state.language)} ${text}`.trim());
      return;
    }
    if (state.echoTimer) clearTimeout(state.echoTimer);
    state.echoTimer = setTimeout(() => {
      state.echoTimer = undefined;
      speak(sessionId, `${echoPrefixFor(state.language)} ${text}`.trim());
    }, ECHO_WAIT_MS);
  },

  onSessionEnd({ sessionId }) {
    const state = sessions.get(sessionId);
    if (state?.echoTimer) clearTimeout(state.echoTimer);
    if (state?.speechWaiter) clearTimeout(state.speechWaiter.timer);
    sessions.delete(sessionId);
  },
});
