# Agent templates

## `agent.ts`

Full starter bundle covering every speech event from `@node-webrtc-rust/sdk/voice`:

| Group       | Events                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------- |
| User VAD    | `user_speaking_start`, `user_speaking_end`, `vad_triggered`                                  |
| STT stream  | `stt_stream_start`, `stt_stream_end`, `user_stt_start`, `user_stt_end`, `user_stt_not_found` |
| Transcripts | `user_speech_partial`, `user_speech_final`                                                   |
| Agent TTS   | `agent_speaking_start`, `agent_speaking_end`, `barge_in`                                     |
| Failures    | `error`                                                                                      |

**Customize:** replace `onUserSpeechFinal` body with your LLM/tools; extend `PeerState` or swap `handleSpeechEvent` for your architecture.

**Build:**

```bash
npm install @voicethere/agent esbuild
npx esbuild agent.ts --bundle --platform=node --format=esm --outfile=dist/agent.js
```
