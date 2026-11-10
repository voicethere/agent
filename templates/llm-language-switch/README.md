# llm-language-switch

A small travel-help assistant that follows the caller when they change language in the middle of the call. Speak English, then start speaking German, Spanish or French: the runner detects the language, switches speech-to-text and the voice, and replays the utterance, and the LLM answers in the new language in the new voice. Source: `templates/llm-language-switch/agent.ts` and `language.ts`.

## What you need

- A project secret named `AGENT_OPENROUTER_API_KEY` (a key from openrouter.ai).
- These project settings. Without them the call stays in English and the agent logs `language_switch.auto_off`:
  - voice language settings: language identification on and `autoSwitch` on, with replay of the switching utterance and voice switching on;
  - VoiceThere speech-to-text and text-to-speech on both sides (auto-switch needs both);
  - `voice.allowedLanguages` set to `["en", "de", "es", "fr"]`.

## How it works

The runner owns the switch. The agent never calls `setVoiceLanguage`.

- `onVoiceLanguageChanged` records the committed language and sends `{ "type": "language", "language": "de" }` to the client. Only a committed language changes what the LLM is told. The agent appends one line ("The caller now speaks German (de). Reply only in German.") to a copy of the last caller message on every LLM call, so it never piles up in the history.
- `onUserLanguage` only reports what was heard: `{ "type": "language_detected", "language": "it", "supported": false }`. The runner may still reject a detection, so the LLM note does not change on it.
- When the detected language is not in `SUPPORTED_LANGUAGES`, the runner does not switch and the transcript comes from the wrong language's speech model. The agent skips the LLM for that utterance and says, in the current language, "I heard Italian. I can talk with you in English, German, Spanish or French." That notice is not added to the LLM history.
- Typed chat messages are answered in the language they are written in (the prompt says so); chat does not change the voice.

## Files

- `agent.ts` wires `createLlmAgent` into `languageSwitchAgent`.
- `language.ts` holds `SUPPORTED_LANGUAGES`, the language note and the unsupported-language notice. Keep `SUPPORTED_LANGUAGES` equal to the project's `voice.allowedLanguages`.
- `voicethere.llm.json` holds the model, greeting and limits.
- `prompt.md` is the system prompt.
- `md.d.ts` lets TypeScript accept `import x from "./x.md"`.

## Cost

Measured on VoiceThere's demo: see the use-case page.
