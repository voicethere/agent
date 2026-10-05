# language-switch

Spoken-language detection tells the agent which ISO 639-1 code it heard. It does **not** change the TTS voice or the STT model by itself. This template shows how to react in two ways:

## Mode A — Manual switch (default)

Leave the project **spoken-language auto-switch** setting off. The agent runs the whole switch with three primitives, and the caller is not interrupted:

1. `onUserLanguage` fires while the caller is still talking. The agent calls `prepareVoiceLanguage` so the target voice and STT pools warm up, and waits.
2. The caller's next final is the switch utterance. The agent does not answer it. If the pools are ready it calls `setVoiceLanguage` at once. If not, it first speaks a wait message in the current voice (`One moment please, I'm switching to your language.`), awaits the pools, then swaps.
3. `replayLastUtterance` makes the runner run that utterance through the new STT. The replayed final arrives with `replay: true` and is answered in the new language.

When the switch took at least `readyMessageMinMs` (default 2000) and no wait message was played, the agent speaks a short ready message in the new voice (`Okay, machen wir auf Deutsch weiter.`) before the replay. The project can also set `waitMessageMode`: `end_of_utterance` (default), `immediate` (wait message at detection, not interruptible) or `off`. The settings come from `getVoiceLanguageSwitchSettings`; without them (older runner) the defaults above apply.

If anything fails (prepare, swap or replay), the agent speaks a short fallback in the old language and stays. A second language event during a switch is ignored.

The built-in speech vendor is VoiceThere (id `local-sherpa`). Edit `PROFILES` in `agent.ts` to apply other vendors per target language, for example Deepgram for listening and ElevenLabs for speaking; the file has a commented example. Keys stay in project secrets.

Texts, in order of precedence: the env override, the project settings (`waitMessages`, `readyMessages`), then the maps in `agent.ts` (`WAIT_MESSAGES`, `READY_MESSAGES`, `FAILED_MESSAGES`; en, de, es, fr, it, pt, nl, pl, ru). Override per language with a JSON object in the session env, keyed by ISO 639-1 code:

- `LANGUAGE_SWITCH_WAIT_MESSAGES_JSON` — wait message, for example `{"en":"Hold on, switching languages."}`
- `LANGUAGE_SWITCH_FAILED_MESSAGES_JSON` — fallback after a failed switch

Invalid JSON or non-string values are ignored. A language without a text falls back to English.

Every step logs a `language_switch.<decision>` line with structured fields and never the caller's words: `session_start`, `detected`, `prepare`, `wait_message`, `swap`, `ready_message`, `replay`, `committed`, `failed`.

A VoiceThere language with no STT id (`it`, `pt`, `nl`, `pl`, `hi`) fails the STT call and still switches TTS.

## Mode B — Runner auto-switch

Enable auto-switch in the project voice settings (runner applies STT/TTS when LID detects a new language). When `session_start.env` includes a truthy `SHERPA_LID_AUTO_SWITCH`, this template **does not** call `setVoiceLanguage`. The runner replays the utterance into the new language's STT, so the next final is the recognized text in the new language. The agent remembers the language from `onUserLanguage` / `onVoiceLanguageChanged` and answers each final right away with a short localized prefix, for example `you said: …` in English and `Du hast gesagt: …` in German. Use `onVoiceLanguageChanged` when you need the committed language after the runner applies the change.

In this mode the runner owns the wait message and the agent speaks no wait or fallback text of its own.

Detection and chat commands are unchanged: `/tts` and `/stt` still call `setVoiceLanguage` for one vendor at a time.

Chat commands change one vendor while the session stays connected. API keys are project secrets on the running deploy, not arguments:

- `/tts sherpa de` — VoiceThere TTS only
- `/stt sherpa de` — VoiceThere STT only
- `/tts elevenlabs` — ElevenLabs TTS, current STT stays
- `/stt deepgram de` — Deepgram STT, current voice stays

In manual mode, finals are echoed as `you said: …` (in the current language) after a short wait, so a language event for the same utterance can cancel the echo. The switch utterance is not spoken back as an English transcript; its replay is answered in the new language.

`voice` and `stt` are VoiceThere catalog ids (`de`, `en-lessac`, `en-small`), listed in the spoken-language docs. Vendor ids are `local-sherpa`, `openai`, `deepgram`, `assemblyai`, `google`, `elevenlabs`, and `cartesia`.

Entry: `templates/language-switch/agent.ts`.
