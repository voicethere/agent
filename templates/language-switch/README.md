# language-switch

Spoken-language detection tells the agent which ISO 639-1 code it heard. It does **not** change the TTS voice or the STT model. This template calls `setVoiceLanguage` from `onUserLanguage` with both the TTS voice and the STT model for that language, then speaks a short reply.

English finals are echoed as `you said: …` after a short wait, so a language event for the same utterance can cancel the echo. The revealing utterance is not spoken back as an English transcript.

`voice` and `stt` are catalog ids (`de`, `en-lessac`, `en-small`), listed in the spoken-language docs. Passing `stt` equal to the language switches listening to that model. Italian, Portuguese, Dutch, Polish, and Hindi have a TTS voice but no STT id equal to the language; those keep the current STT model and still switch TTS.

Entry: `templates/language-switch/agent.ts`.
