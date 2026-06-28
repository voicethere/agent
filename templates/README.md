# Agent templates

## `echo.ts`

Full echo debug agent for the VoiceThere dashboard — speaks **"you said: …"** on voice finals and text chat, relays speech events over DataChannel, and echoes chat replies on DC.

**Build:**

```bash
npm install @voicethere/agent
npx @voicethere/agent build --entry templates/echo.ts
```

Platform auto-seeds the built bundle when a project is created with the **Echo (voice + chat)** template.

## `echo-dc.ts`

Data-channel-only echo — relays speech events and chat text over DC without TTS. Use when debugging the dashboard chat panel without agent playback.

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
npm install @voicethere/agent
npx @voicethere/agent build
# optional: --entry agent.ts --outfile dist/agent.js
```

**Verify sandbox (no WebRTC):**

```bash
npx @voicethere/agent verify
```

**Voice E2E:** host with the VoiceThere agent runner (platform or internal deployment) — set `AGENT_BUNDLE_PATH` to your built `dist/agent.js`.

## `game-sync.ts`

Authoritative multi-object sync sample for real-time games/simulations:

- register tracked objects via control DC (`{ type: "register" }`)
- receive `register_ack` + `object_registered` ownership notifications
- run server-authoritative simulation (position + velocity) at 60Hz
- resolve wall bounce + object-object collisions on the server
- broadcast world-state snapshots to clients over binary sync channel (9-float records)
- ignore client binary writes by default (safe base for adding intent/input messages later)
- reuse freed slots on leave to keep world state compact

Build:

```bash
npx @voicethere/agent build --entry templates/game-sync.ts
```
