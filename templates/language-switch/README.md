# language-switch

Spoken-language detection tells the agent which ISO 639-1 code it heard. It does **not** change the TTS voice or the STT model by itself. This template shows how to react in two ways:

## Mode A — Manual switch (default)

Leave the project **spoken-language auto-switch** setting off. The agent runs the whole switch with three primitives, and the caller is not interrupted:

1. `onUserLanguage` fires while the caller is still talking. The agent calls `prepareVoiceLanguage` so the target voice and STT pools warm up, and waits.
2. The caller's next final is the switch utterance. The agent does not answer it. If the pools are ready it calls `setVoiceLanguage` at once. If not, it first speaks a holding message in the current voice that names the target language (`One moment, switching to German.`), awaits the pools, then swaps.
3. `replayLastUtterance` makes the runner run that utterance through the new STT. The replayed final arrives with `replay: true` and is answered in the new language.

One `prepareVoiceLanguage` attempt waits 20 seconds. If the pools did not start (`reason: "timeout"`), the agent logs `language_switch.retry`, speaks the holding message again once the first one has finished, and prepares once more at once. If the second attempt also times out, or `setVoiceLanguage` answers `language_unavailable`, the agent says in the current voice that the language isn't available (`Sorry, that language isn't available right now. Let's continue in English.`) and the call stays in the old language. That takes about 40 seconds in total. The runner makes `setVoiceLanguage` wait up to 2 x 20 seconds as well, so a pool that never starts ends in the same notice.

When the switch took at least `readyMessageMinMs` (default 2000) and no wait message was played, the agent speaks a short ready message in the new voice (`Okay, machen wir auf Deutsch weiter.`) before the replay. The project can also set `waitMessageMode`: `end_of_utterance` (default), `immediate` (wait message at detection, not interruptible) or `off`. The settings come from `getVoiceLanguageSwitchSettings`; without them (older runner) the defaults above apply.

The swap waits until the holding message has finished playing (at most 8 seconds). If the language is detected after the caller's last final is already unanswered, that final is the switch utterance and the switch starts at once. If prepare or the swap fails for any other reason, the agent speaks a short fallback in the old language and stays. If only the replay fails, the voice is already the new one, so the agent asks the caller in the new language to repeat (`REPEAT_MESSAGES`) and stays in it. A second language event during a switch is ignored.

The built-in speech vendor is VoiceThere (id `voicethere`). Edit `PROFILES` in `agent.ts` to apply other vendors per target language, for example Deepgram for listening and ElevenLabs for speaking; the file has a commented example. Keys stay in project secrets.

Texts, in order of precedence: the env override, the project settings (`waitMessages`, `readyMessages`), then the maps in `agent.ts` (`HOLDING_MESSAGES`, `READY_MESSAGES`, `FAILED_MESSAGES`, `UNAVAILABLE_MESSAGES`; en, de, es, fr, it, pt, nl, pl, ru, except the ready and unavailable maps, which have no ru). `WAIT_MESSAGES` is kept as another name for `HOLDING_MESSAGES`. In a holding message, `{language}` is replaced by the target language's name, written in the language being left (`Intl.DisplayNames`), so project texts and the env override can use it too. Override per language with a JSON object in the session env, keyed by ISO 639-1 code:

- `LANGUAGE_SWITCH_WAIT_MESSAGES_JSON` — holding message, for example `{"en":"Hold on, switching to {language}."}`
- `LANGUAGE_SWITCH_FAILED_MESSAGES_JSON` — fallback after a failed switch
- `LANGUAGE_SWITCH_UNAVAILABLE_MESSAGES_JSON` — notice when the language never became available

Invalid JSON or non-string values are ignored. A language without a text falls back to English.

Every step logs a `language_switch.<decision>` line with structured fields and never the caller's words: `session_start`, `detected`, `prepare`, `wait_message`, `retry`, `unavailable`, `swap`, `ready_message`, `replay`, `committed`, `failed`.

A VoiceThere language with no STT id (`it`, `pt`, `nl`, `pl`, `hi`) fails the STT call and still switches TTS.

## Mode B — Runner auto-switch

Enable auto-switch in the project voice settings (runner applies STT/TTS when LID detects a new language). When `session_start.env` includes a truthy `SHERPA_LID_AUTO_SWITCH`, this template **does not** call `setVoiceLanguage`. The runner replays the utterance into the new language's STT, so the next final is the recognized text in the new language. The agent remembers the language from `onUserLanguage` / `onVoiceLanguageChanged` and answers each final right away with a short localized prefix, for example `you said: …` in English and `Du hast gesagt: …` in German. Use `onVoiceLanguageChanged` when you need the committed language after the runner applies the change.

In this mode the runner owns the wait message and the agent speaks no wait or fallback text of its own.

Detection and chat commands are unchanged: `/tts` and `/stt` still call `setVoiceLanguage` for one vendor at a time.

Chat commands change one vendor while the session stays connected. API keys are project secrets on the running deploy, not arguments:

- `/tts voicethere de` — VoiceThere TTS only (`sherpa` also works)
- `/stt voicethere de` — VoiceThere STT only (`sherpa` also works)
- `/tts elevenlabs` — ElevenLabs TTS, current STT stays
- `/stt deepgram de` — Deepgram STT, current voice stays

In manual mode, finals are echoed as `you said: …` (in the current language) after a short wait, so a language event for the same utterance can cancel the echo. The switch utterance is not spoken back as an English transcript; its replay is answered in the new language.

The default profile asks for VoiceThere speech on both sides: `sttVendor: { provider: "voicethere", language }` and `ttsVendor: { provider: "voicethere", language }`. To pick a specific model or voice, set `sttVendor.model` (`de`, `en-small`) or `ttsVendor.voice` (`en-lessac`); the ids are listed in the spoken-language docs. Other vendor ids are `openai`, `deepgram`, `assemblyai`, `google`, `elevenlabs`, `cartesia`, `fishaudio`, `groq`, `azure`, and `aws`. A failed switch carries a `reason` and a `message` that says what to change.

Entry: `templates/language-switch/agent.ts`.
