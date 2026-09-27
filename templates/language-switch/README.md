# language-switch

Spoken-language detection tells the agent which ISO 639-1 code it heard. It does **not** change the TTS voice. This template calls `setVoiceLanguage` from `onUserLanguage` and then speaks a short reply in that language.

English finals are echoed as `you said: …` after a short wait, so a language event for the same utterance can cancel the echo. The revealing utterance is not spoken back as an English transcript.

`voice` and `stt` are catalog ids (`de`, `en-lessac`, `en-small`), listed in the spoken-language docs.

Entry: `templates/language-switch/agent.ts`.
