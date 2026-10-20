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
 *        it speaks a holding message in the current voice that names the
 *        target language ("One moment, switching to German.") and awaits the
 *        pools. One `prepareVoiceLanguage` attempt waits 20 s. When it times
 *        out the agent logs `language_switch.retry`, repeats the holding
 *        message (after the first one finished) and prepares once more at
 *        once. If the second attempt also times out, or `setVoiceLanguage`
 *        answers `language_unavailable`, the agent says in the current voice
 *        that the language isn't available and the call stays in the old
 *        language (about 40 s in total).
 *     3. `replayLastUtterance` runs that utterance through the new STT. The
 *        replayed final (`replay: true`) is answered in the new language.
 *     A slow switch plays a ready message in the new voice; any other failure
 *     speaks a short apology in the old language. Texts come from the project
 *     settings (`getVoiceLanguageSwitchSettings`), then HOLDING_MESSAGES
 *     (`{language}` is replaced by the target's name) / READY_MESSAGES /
 *     FAILED_MESSAGES / UNAVAILABLE_MESSAGES, and env vars
 *     LANGUAGE_SWITCH_WAIT_MESSAGES_JSON / LANGUAGE_SWITCH_FAILED_MESSAGES_JSON /
 *     LANGUAGE_SWITCH_UNAVAILABLE_MESSAGES_JSON (JSON object, ISO 639-1 ->
 *     text) win. The built-in vendor is VoiceThere (id `voicethere`); edit
 *     PROFILES to use other vendors.
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
 * - `/tts voicethere de` — VoiceThere TTS only (`sherpa` also works)
 * - `/stt voicethere de` — VoiceThere STT only (`sherpa` also works)
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
 * vendor (`voicethere`): voice and STT model chosen for the language. A
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
      sttVendor: { provider: "voicethere", language },
      ttsVendor: { provider: "voicethere", language },
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

/**
 * Spoken in the language being left, when the target pools are not ready at
 * the end of the switch utterance. `{language}` is replaced by the target
 * language's name, written in the language being left.
 */
export const HOLDING_MESSAGES: Record<string, string> = {
  en: "One moment, switching to {language}.",
  de: "Einen Moment bitte, ich wechsle auf {language}.",
  es: "Un momento, por favor, cambio al {language}.",
  fr: "Un instant, je passe en {language}.",
  it: "Un momento, cambio lingua: {language}.",
  pt: "Um momento, vou mudar para {language}.",
  nl: "Een moment, ik schakel over naar het {language}.",
  pl: "Chwileczkę, przełączam na język: {language}.",
  ru: "Одну минуту, переключаюсь на {language}.",
};

/** Same map under its former name. */
export const WAIT_MESSAGES = HOLDING_MESSAGES;

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

/**
 * Spoken in the old language when the target pools never started (two
 * attempts, about 40 s) and the agent stays in the old language.
 */
export const UNAVAILABLE_MESSAGES: Record<string, string> = {
  en: "Sorry, that language isn't available right now. Let's continue in English.",
  de: "Entschuldigung, diese Sprache ist gerade nicht verfügbar. Machen wir auf Deutsch weiter.",
  es: "Lo siento, ese idioma no está disponible ahora mismo. Sigamos en español.",
  fr: "Désolé, cette langue n'est pas disponible pour le moment. Continuons en français.",
  it: "Mi dispiace, questa lingua non è disponibile al momento. Continuiamo in italiano.",
  pt: "Desculpe, esse idioma não está disponível agora. Vamos continuar em português.",
  nl: "Sorry, die taal is nu niet beschikbaar. We gaan verder in het Nederlands.",
  pl: "Przepraszam, ten język jest teraz niedostępny. Kontynuujmy po polsku.",
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

/** Spoken in the new voice when the replay fails after the swap. */
export const REPEAT_MESSAGES: Record<string, string> = {
  en: "Sorry, could you say that again?",
  de: "Entschuldigung, können Sie das bitte wiederholen?",
  es: "Perdón, ¿puede repetirlo?",
  fr: "Pardon, pouvez-vous répéter ?",
  it: "Scusi, può ripetere?",
  pt: "Desculpe, pode repetir?",
  nl: "Sorry, kunt u dat herhalen?",
  pl: "Przepraszam, czy może Pan/Pani powtórzyć?",
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
export const UNAVAILABLE_MESSAGES_ENV =
  "LANGUAGE_SWITCH_UNAVAILABLE_MESSAGES_JSON";

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
  /** Set once the wait message finished (`agent_speaking_end`). */
  waitSpeechEnded: boolean;
  /** `awaiting_utterance` until the caller's next final starts the swap. */
  phase: "awaiting_utterance" | "running";
};

type SessionLanguage = {
  language: string;
  runnerAutoSwitch: boolean;
  echoTimer: ReturnType<typeof setTimeout> | undefined;
  /** When the final behind `echoTimer` arrived (an unanswered final). */
  pendingFinalAtMs: number | undefined;
  active: SwitchInFlight | undefined;
  speechWaiter:
    { resolve: () => void; timer: ReturnType<typeof setTimeout> } | undefined;
  waitOverrides: Record<string, string>;
  failedOverrides: Record<string, string>;
  unavailableOverrides: Record<string, string>;
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
    pendingFinalAtMs: undefined,
    active: undefined,
    speechWaiter: undefined,
    waitOverrides: parseMessageOverrides(env?.[WAIT_MESSAGES_ENV]),
    failedOverrides: parseMessageOverrides(env?.[FAILED_MESSAGES_ENV]),
    unavailableOverrides: parseMessageOverrides(
      env?.[UNAVAILABLE_MESSAGES_ENV],
    ),
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
      `setVoiceLanguage ${side} failed: ${result.reason ?? "unknown"}${result.message ? ` - ${result.message}` : ""}`,
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

/** The target language's name, written in the language being left. */
function languageNameFor(from: string, to: string): string {
  try {
    const name = new Intl.DisplayNames([from], { type: "language" }).of(to);
    if (name && name !== to) return name;
  } catch {
    // Unknown locale or code: use the English name below.
  }
  return LANGUAGE_NAMES[to] ?? to;
}

/** Holding message in the current voice, naming the target language. */
export function holdingMessageFor(
  state: Pick<SessionLanguage, "waitOverrides">,
  from: string,
  to: string,
  fromSettings: Record<string, string> | undefined,
): string {
  const overrides = { ...fromSettings, ...state.waitOverrides };
  const text = pickMessage(HOLDING_MESSAGES, overrides, from);
  const known = from in overrides || from in HOLDING_MESSAGES;
  const name = languageNameFor(known ? from : "en", to);
  return text.replace(/\{language\}/g, () => name);
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
 * The target pools never started: say so in the old language and stay. Handles
 * the unanswered switch utterance the same way `failSwitch` does.
 */
function unavailableSwitch(
  sessionId: string,
  state: SessionLanguage,
  sw: SwitchInFlight,
  attempts: number,
  reason: string,
): void {
  if (state.active === sw) state.active = undefined;
  agentLog(
    "warn",
    "language_switch.unavailable",
    { from: sw.from, to: sw.to, attempts, reason },
    sessionId,
  );
  speak(
    sessionId,
    pickMessage(UNAVAILABLE_MESSAGES, state.unavailableOverrides, sw.from),
  );
}

/** Replay failed after the swap: stay in the new language and ask to repeat. */
function failReplay(
  sessionId: string,
  sw: SwitchInFlight,
  reason: string,
): void {
  agentLog(
    "warn",
    "language_switch.failed",
    {
      from: sw.from,
      to: sw.to,
      step: "replay",
      reason,
      recovered: "asked_to_repeat",
    },
    sessionId,
  );
  speak(sessionId, REPEAT_MESSAGES[sw.to] ?? REPEAT_MESSAGES.en!, {
    interruptible: false,
  });
}

/** `prepareVoiceLanguage` timed out (20 s on the runner, 50 s on older ones). */
function isPrepareTimeout(result: VoiceLanguagePrepareResult): boolean {
  return !result.ready && result.reason === "timeout";
}

/** One prepare attempt; logs `language_switch.prepare` when it settles. */
function runPrepare(
  sessionId: string,
  sw: SwitchInFlight,
  attempt: number,
): Promise<VoiceLanguagePrepareResult> {
  const startedAtMs = attempt === 1 ? sw.detectedAtMs : Date.now();
  return prepareVoiceLanguage(sessionId, sw.profile).then((result) => {
    agentLog(
      "info",
      "language_switch.prepare",
      {
        to: sw.to,
        ok: result.ok,
        ready: result.ready,
        reason: result.reason,
        attempt,
        afterMs: Date.now() - startedAtMs,
      },
      sessionId,
    );
    return result;
  });
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
  let attempt = 1;
  if (!prepared) {
    // Not ready when the caller stopped: tell them, in the voice they hear now.
    if (mode !== "off" && !sw.waitMessagePlayed) {
      speak(
        sessionId,
        holdingMessageFor(state, sw.from, sw.to, settings?.waitMessages),
      );
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
  if (isPrepareTimeout(prepared)) {
    // One attempt waits 20 s. Prepare again at once and repeat the holding
    // message, but never over the first one.
    attempt = 2;
    agentLog(
      "info",
      "language_switch.retry",
      { from: sw.from, to: sw.to, attempt, reason: prepared.reason },
      sessionId,
    );
    const retry = runPrepare(sessionId, sw, attempt);
    if (mode !== "off") {
      if (sw.waitMessagePlayed && !sw.waitSpeechEnded) {
        await waitForSpeechEnd(state);
        if (!alive()) return;
      }
      speak(
        sessionId,
        holdingMessageFor(state, sw.from, sw.to, settings?.waitMessages),
      );
      sw.waitMessagePlayed = true;
      sw.waitSpeechEnded = false;
      agentLog(
        "info",
        "language_switch.wait_message",
        { played: true, reason: "retry", language: sw.from },
        sessionId,
      );
    }
    prepared = await retry;
    if (!alive()) return;
  }
  if (!prepared.ok || !prepared.ready) {
    if (attempt === 2) {
      unavailableSwitch(
        sessionId,
        state,
        sw,
        attempt,
        prepared.reason || "not_ready",
      );
      return;
    }
    failSwitch(
      sessionId,
      state,
      sw,
      "prepare",
      prepared.ok ? "not_ready" : prepared.reason,
    );
    return;
  }

  // The runner swaps the voice without draining it, so let the wait message
  // finish first.
  if (sw.waitMessagePlayed) {
    const waitStart = Date.now();
    if (!sw.waitSpeechEnded) await waitForSpeechEnd(state);
    if (!alive()) return;
    agentLog(
      "info",
      "language_switch.wait_message",
      {
        played: true,
        reason: "finished",
        language: sw.from,
        waitedMs: Date.now() - waitStart,
      },
      sessionId,
    );
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
    if (swapped.reason === "language_unavailable") {
      // The runner already retried once (2 x 20 s) before giving up.
      unavailableSwitch(sessionId, state, sw, 2, swapped.reason);
      return;
    }
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
    failReplay(sessionId, sw, replay.reason);
    return;
  }
  agentLog(
    "info",
    "language_switch.committed",
    { from: sw.from, to: sw.to, totalMs: Date.now() - sw.detectedAtMs },
    sessionId,
  );
}

/** Run the switch without blocking the inbound handler. */
function startRun(
  sessionId: string,
  state: SessionLanguage,
  sw: SwitchInFlight,
  finalAtMs: number,
): void {
  void runSwitch(sessionId, state, sw, finalAtMs).catch((error: unknown) => {
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
  });
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

    const unansweredFinalAtMs = state.echoTimer
      ? state.pendingFinalAtMs
      : undefined;
    if (state.echoTimer) {
      clearTimeout(state.echoTimer);
      state.echoTimer = undefined;
      state.pendingFinalAtMs = undefined;
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
      waitSpeechEnded: false,
      phase: "awaiting_utterance",
    };
    sw.prepare = runPrepare(sessionId, sw, 1).then((result) => {
      sw.prepareResult = result;
      return result;
    });
    state.active = sw;
    agentLog(
      "info",
      "language_switch.detected",
      {
        from,
        to: language,
        ...(unansweredFinalAtMs !== undefined ? { afterFinal: true } : {}),
      },
      sessionId,
    );

    const settings = getVoiceLanguageSwitchSettings(sessionId);
    if (settings?.waitMessageMode === "immediate") {
      // Not interruptible: the caller is still talking when this plays.
      speak(
        sessionId,
        holdingMessageFor(state, from, language, settings.waitMessages),
        { interruptible: false },
      );
      sw.waitMessagePlayed = true;
      agentLog(
        "info",
        "language_switch.wait_message",
        { played: true, reason: "immediate", language: from },
        sessionId,
      );
    }

    // The caller's last final is still unanswered: it is the switch utterance.
    if (unansweredFinalAtMs !== undefined) {
      sw.phase = "running";
      startRun(sessionId, state, sw, unansweredFinalAtMs);
    }
  },

  onSpeechEvent({ sessionId }, event) {
    if (event.type !== "agent_speaking_end") return;
    const state = sessions.get(sessionId);
    if (!state) return;
    const sw = state.active;
    if (sw?.waitMessagePlayed) sw.waitSpeechEnded = true;
    state.speechWaiter?.resolve();
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
    const builtIn = vendor === "voicethere" || vendor === "sherpa";
    if (command === "/tts" && builtIn && language) {
      const result = await setVoiceLanguage(ctx.sessionId, {
        scope: "tts",
        language,
        ttsVendor: { provider: "voicethere", language },
      });
      logSwitch(ctx.sessionId, "tts", result);
      if (result.ok) speak(ctx.sessionId, replyFor(language));
      return;
    }
    if (command === "/stt" && builtIn && language) {
      const result = await setVoiceLanguage(ctx.sessionId, {
        scope: "stt",
        language,
        sttVendor: { provider: "voicethere", language },
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
      startRun(sessionId, state, sw, Date.now());
      return;
    }
    if (replay) {
      // Replayed switch utterance: the language is decided, answer now.
      speak(sessionId, `${echoPrefixFor(state.language)} ${text}`.trim());
      return;
    }
    if (state.echoTimer) clearTimeout(state.echoTimer);
    state.pendingFinalAtMs = Date.now();
    state.echoTimer = setTimeout(() => {
      state.echoTimer = undefined;
      state.pendingFinalAtMs = undefined;
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
