# language-switch

Spoken-language detection tells the agent which ISO 639-1 code it heard. It does **not** change the TTS voice or the STT model. This template changes the two sides separately with `setVoiceLanguage`:

- `scope: "tts"` switches only the speaking voice
- `scope: "stt"` switches only the listening model

A Sherpa language with no STT id (`it`, `pt`, `nl`, `pl`, `hi`) fails the STT call and still switches TTS.

Chat commands change one vendor while the session stays connected. API keys are project secrets on the running deploy, not arguments:

- `/tts sherpa de` — Sherpa TTS only
- `/stt sherpa de` — Sherpa STT only
- `/tts elevenlabs` — ElevenLabs TTS, current STT stays
- `/stt deepgram de` — Deepgram STT, current voice stays

English finals are echoed as `you said: …` after a short wait, so a language event for the same utterance can cancel the echo. The revealing utterance is not spoken back as an English transcript.

`voice` and `stt` are Sherpa catalog ids (`de`, `en-lessac`, `en-small`), listed in the spoken-language docs. Vendor ids are `local-sherpa`, `openai`, `deepgram`, `assemblyai`, `google`, `elevenlabs`, and `cartesia`.

Entry: `templates/language-switch/agent.ts`.
