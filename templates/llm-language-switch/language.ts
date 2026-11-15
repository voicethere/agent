import {
  agentLog,
  isRunnerLidAutoSwitchEnabled,
  sendToClient,
  speak,
  type AgentHandlers,
} from "@voicethere/agent";
import type { LlmAgentHooks, LlmMessage } from "@voicethere/agent/llm";

/**
 * Languages the call switches to. Keep this equal to the project's
 * `voice.allowedLanguages`: the runner does not switch to any other detected
 * language, and this agent then tells the caller what it heard.
 */
export const SUPPORTED_LANGUAGES: readonly string[] = ["en", "de", "es", "fr"];

/** The language a session starts in (the project's voice language). */
export const DEFAULT_LANGUAGE = "en";

/** Lower-case ISO 639-1 code from `de`, `DE` or `de-DE`. */
export function normalizeLanguage(code: string): string {
  return code.trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

export function isSupported(code: string): boolean {
  return SUPPORTED_LANGUAGES.includes(normalizeLanguage(code));
}

/** The language's name written in `inLanguage`, or the code when unknown. */
export function languageName(code: string, inLanguage: string): string {
  try {
    const names = new Intl.DisplayNames([inLanguage], { type: "language" });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The one line that tells the LLM which language the caller speaks now. */
export function languageNote(code: string): string {
  const name = languageName(code, "en");
  return `The caller now speaks ${name} (${code}). Reply only in ${name}.`;
}

interface NoticeText {
  heard: (language: string) => string;
  can: (list: string) => string;
  or: string;
}

const NOTICE: Record<string, NoticeText> = {
  en: {
    heard: (l) => `I heard ${l}.`,
    can: (list) => `I can talk with you in ${list}.`,
    or: "or",
  },
  de: {
    heard: (l) => `Ich habe ${l} gehört.`,
    can: (list) => `Ich kann mit dir in diesen Sprachen sprechen: ${list}.`,
    or: "oder",
  },
  es: {
    heard: (l) => `Escuché ${l}.`,
    can: (list) => `Puedo hablar contigo en ${list}.`,
    or: "o",
  },
  fr: {
    heard: (l) => `J'ai entendu ${l}.`,
    can: (list) => `Je peux parler avec vous en ${list}.`,
    or: "ou",
  },
};

/**
 * What the agent says when the caller spoke a language it cannot switch to:
 * in the session's current language, naming the heard language and the
 * supported ones ("I heard Italian. I can talk with you in English, German,
 * Spanish or French.").
 */
export function unsupportedNotice(heard: string, current: string): string {
  const lang = isSupported(current)
    ? normalizeLanguage(current)
    : DEFAULT_LANGUAGE;
  const text = NOTICE[lang]!;
  const names = SUPPORTED_LANGUAGES.map((c) => languageName(c, lang));
  const list =
    names.length > 1
      ? `${names.slice(0, -1).join(", ")} ${text.or} ${names[names.length - 1]}`
      : (names[0] ?? "");
  return `${text.heard(languageName(heard, lang))} ${text.can(list)}`;
}

/**
 * Appends the language note to a copy of the last caller message, so the
 * model sees it last on every call and it never stacks in the history. The
 * LLM message type has no system role; the stored history is not touched.
 */
export function withLanguageNote(
  messages: LlmMessage[],
  code: string,
): LlmMessage[] {
  return withNote(messages, languageNote(code));
}

/** The fallback line when the language of a typed message is not clear. */
export const CHAT_NOTE =
  "Reply in the language this message is written in, even if the earlier conversation used another language.";

/** Common words per language; ambiguous ones (`de`, `la`, `en`, `a`) are left out. */
const STOPWORDS: Record<string, readonly string[]> = {
  en: "the is are what where how can you your i my to of and for with from this that it do does please".split(
    " ",
  ),
  de: "der die das ist sind wo wie kann ich du sie ein eine und nicht mit von zu bitte wann welche auf nach".split(
    " ",
  ),
  es: "el los las es son dónde donde cómo como puedo puede yo tú un una y no con por para hola desde al qué que cuál".split(
    " ",
  ),
  fr: "le les est sont où ou comment puis je tu vous un une et pas avec pour bonjour depuis au quel quelle que qu'est-ce".split(
    " ",
  ),
};

/** Characters that mark one language among the supported ones. */
const MARKS: Record<string, string> = {
  es: "¿¡ñ",
  de: "ßäöü",
  fr: "çàèùêîôû",
};

/**
 * Guesses the language of a typed message from stopwords and marks, limited
 * to `SUPPORTED_LANGUAGES`. Returns a code only when the best language has at
 * least 2 hits and leads the next one by at least 2; short, mixed or unknown
 * text returns undefined. A guess only words the chat note: it never changes
 * the session language or the voice.
 */
export function guessChatLanguage(text: string): string | undefined {
  const words = text.toLowerCase().match(/[\p{L}'-]+/gu) ?? [];
  const scores = SUPPORTED_LANGUAGES.map((code) => {
    const stop = new Set(STOPWORDS[code] ?? []);
    let hits = words.filter((w) => stop.has(w)).length;
    for (const mark of MARKS[code] ?? "") {
      if (text.toLowerCase().includes(mark)) hits += 1;
    }
    return { code, hits };
  }).sort((a, b) => b.hits - a.hits);
  const best = scores[0];
  const next = scores[1];
  if (!best || best.hits < 2 || best.hits - (next?.hits ?? 0) < 2) {
    return undefined;
  }
  return best.code;
}

/** The chat note naming the language of a typed message. */
export function chatLanguageNote(code: string): string {
  const name = languageName(code, "en");
  return `The caller typed this message in ${name} (${code}). Reply only in ${name}.`;
}

const INTERRUPTION_NOTE =
  /^\(The caller interrupted your previous reply after: [\s\S]*?\.\)\n/;

/**
 * Same as `withLanguageNote`, for a typed chat message: names the guessed
 * language, or falls back to `CHAT_NOTE` when the guess is not clear.
 */
export function withChatNote(messages: LlmMessage[]): LlmMessage[] {
  const last = [...messages].reverse().find((m) => m.role === "user");
  // The runtime may put its English interruption note before the message;
  // it is not the caller's text and must not count towards the guess.
  const typed = last?.text.replace(INTERRUPTION_NOTE, "");
  const code = typed ? guessChatLanguage(typed) : undefined;
  return withNote(messages, code ? chatLanguageNote(code) : CHAT_NOTE);
}

function withNote(messages: LlmMessage[], note: string): LlmMessage[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === "user") {
      const copy = messages.slice();
      copy[i] = { role: "user", text: `${m.text}\n\n(${note})` };
      return copy;
    }
  }
  return messages;
}

/** Turn id prefix of the unsupported-language notice (not an LLM reply). */
const NOTICE_TURN_PREFIX = "lang-notice-";

interface SessionLanguage {
  /** Committed by the runner (`voice_language_changed`), never a guess. */
  current: string;
  /** Detected language outside the list, waiting for its final. */
  unsupported?: string;
  /** Last detected language in the list, until it is committed. */
  detected?: string;
  /**
   * Language of the turn the LLM is answering now. Set by a replayed final:
   * the runner replays only after it has swapped to the detected language,
   * and it sends `voice_language_changed` after the replay, so the commit can
   * arrive after the LLM call starts.
   */
  turn?: string;
}

/** The language the LLM is told for the current turn. */
function replyLanguage(state: SessionLanguage | undefined): string {
  return state?.turn ?? state?.current ?? DEFAULT_LANGUAGE;
}

/**
 * Wraps an LLM agent so it follows the runner's language switch. `create`
 * receives the hooks to pass to `createLlmAgent`.
 */
export function languageSwitchAgent(
  create: (hooks: LlmAgentHooks) => AgentHandlers,
): AgentHandlers {
  const sessions = new Map<string, SessionLanguage>();

  const llm = create({
    onBeforeLlmCall(messages, ctx) {
      // Typed chat is answered in the language it is written in, not the
      // call's voice language (the history may be in another language).
      if (ctx.source === "chat") return withChatNote(messages);
      return withLanguageNote(
        messages,
        replyLanguage(sessions.get(ctx.sessionId)),
      );
    },
  });

  return {
    ...llm,

    onSessionStart(ctx) {
      sessions.set(ctx.sessionId, { current: DEFAULT_LANGUAGE });
      if (!isRunnerLidAutoSwitchEnabled(ctx.env)) {
        agentLog(
          "warn",
          "language_switch.auto_off",
          { detail: "project auto-switch is off; the call stays in English" },
          ctx.sessionId,
        );
      }
      return llm.onSessionStart?.(ctx);
    },

    // A detection is not a switch: the runner may still reject it
    // (not_allowed, dwell, confirm). Only tell the client, and remember an
    // unsupported language for the final that follows.
    onUserLanguage(ctx) {
      const language = normalizeLanguage(ctx.language);
      if (!language) return;
      const supported = isSupported(language);
      sendToClient(ctx.sessionId, {
        type: "language_detected",
        language,
        supported,
      });
      const state = sessions.get(ctx.sessionId);
      if (state) {
        state.unsupported = supported ? undefined : language;
        state.detected = supported ? language : undefined;
      }
    },

    onVoiceLanguageChanged(ctx) {
      const language = normalizeLanguage(ctx.language);
      if (!language) return;
      const state = sessions.get(ctx.sessionId);
      if (state) {
        state.current = language;
        state.unsupported = undefined;
        state.detected = undefined;
        state.turn = undefined;
      }
      sendToClient(ctx.sessionId, { type: "language", language });
    },

    onUserSpeechFinal(ctx) {
      const state = sessions.get(ctx.sessionId);
      if (state) {
        // A replayed final is the switching utterance re-decoded by the new
        // language's STT; the commit follows it. Any other final is answered
        // in the committed language.
        state.turn = ctx.replay ? (state.detected ?? state.current) : undefined;
      }
      if (state?.unsupported && !ctx.replay) {
        // The transcript came from the wrong language's STT: do not ask the
        // LLM, say what was heard in the current language instead.
        const text = unsupportedNotice(state.unsupported, state.current);
        state.unsupported = undefined;
        const turnId = `${NOTICE_TURN_PREFIX}${ctx.utteranceId ?? Date.now()}`;
        sendToClient(ctx.sessionId, {
          type: "assistant_delta",
          turnId,
          text,
          spoken: true,
        });
        sendToClient(ctx.sessionId, {
          type: "assistant_done",
          turnId,
          text,
          spoken: true,
          status: "completed",
        });
        speak(ctx.sessionId, text, { turnId });
        return;
      }
      return llm.onUserSpeechFinal?.(ctx);
    },

    onAgentInterrupted(ctx) {
      // The notice is not an LLM reply: no interruption note for it.
      if (ctx.turnId?.startsWith(NOTICE_TURN_PREFIX)) return;
      return llm.onAgentInterrupted?.(ctx);
    },

    onSessionEnd(ctx) {
      sessions.delete(ctx.sessionId);
      return llm.onSessionEnd?.(ctx);
    },
  };
}
