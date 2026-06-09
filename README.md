# agent

VoiceThere **customer agent SDK** — TypeScript types and runtime helpers for sandboxed child bundles running inside [`voicethere/runner`](https://github.com/voicethere/runner).

**npm:** `@voicethere/agent` (private until publish)  
**Repo:** [`voicethere/agent`](https://github.com/voicethere/agent)

## Role

| Layer | Package | Runs in |
|-------|---------|---------|
| Parent | `runner` | Trusted Node + WebRTC + Sherpa |
| **Child** | **`@voicethere/agent`** | Sandboxed customer `agent.js` bundle |

The child receives speech lifecycle events over IPC (mirroring `@node-webrtc-rust/sdk/voice`) and calls `speak()` to request TTS from the parent.

## Quick start

```bash
cd agent
npm install
npm run build
```

Use the example echo bundle with a local runner:

```bash
cd ../runner
AGENT_BUNDLE_PATH=../agent/dist/agent.js npm run start
```

## API

```typescript
import { agentLog, defineAgent, speak, type SpeechEvent } from '@voicethere/agent'
import { SPEECH_EVENT_TYPE } from '@node-webrtc-rust/sdk/voice'

defineAgent({
  onSessionStart({ sessionId }) {
    speak(sessionId, 'Hello!')
  },
  onUserSpeechFinal({ sessionId, text }) {
    speak(sessionId, `You said: ${text}`)
  },
  onSpeechEvent({ sessionId }, speech: SpeechEvent) {
    if (speech.type === SPEECH_EVENT_TYPE.bargeIn) {
      agentLog('info', `User interrupted on ${sessionId}`)
    }
  },
})
```

| Export | Purpose |
|--------|---------|
| `defineAgent` | Register `onSessionStart`, `onSpeechEvent`, `onUserSpeechFinal`, `onSessionEnd` |
| `SpeechEvent`, `SpeechEventType` | Re-exported **types** from `@node-webrtc-rust/sdk/voice` |
| `SPEECH_EVENT_TYPE` | Import from `@node-webrtc-rust/sdk/voice` (runtime constants; not bundled into child) |
| `speak` | Request parent TTS |
| `agentLog` | Forward structured logs to parent |
| `ParentToChildMessage` / `ChildToParentMessage` | IPC contract (mirrors `runner/src/child/protocol.ts`) |

### Speech events (parent → child)

Forwarded from the runner voice pipeline as SDK `SpeechEvent` payloads on `speech_event.event` (`event.type`, optional `text` / `error`):

| Event | Typical use in custom agent |
|-------|----------------------------|
| `user_speaking_start` / `user_speaking_end` | UI state, turn-taking |
| `user_speech_partial` | Live captions, early barge-in logic |
| `user_speech_final` | Primary turn boundary (`onUserSpeechFinal` convenience) |
| `agent_speaking_start` / `agent_speaking_end` | Know when TTS playback starts/stops |
| `barge_in` | User interrupted agent playback |
| `vad_triggered`, `stt_stream_*`, `user_stt_*` | Low-level pipeline hooks |
| `error` | Vendor or pipeline failure |

Copy [`templates/agent.ts`](./templates/agent.ts) as a starting point — exhaustive `switch` over all 14 `SpeechEvent` types with per-peer state stubs and `agentLog` tracing.

## Sandbox policy

Customer bundles run in an isolated child process. **Do not import or use:**

- `node:fs`, `node:child_process`, `node:net`, `node:dns`, `node:cluster`
- `process.exit`, spawning subprocesses, or raw network clients

Allowed: pure logic, `@voicethere/agent`, and allowlisted env (`SESSION_ID`, `PROJECT_ID`, `BUILD_ID`). Runner enforces `fs` and `child_process` via Node `--permission` on the child process.

## Build outputs

| Path | Purpose |
|------|---------|
| `dist/index.js` | Published library entry |
| `dist/agent.js` | Example bundle entry (`examples/agent.ts`) for local runner |

## Scripts

```bash
npm run build      # library + example bundle
npm run test:ci    # typecheck + vitest
```

## Roadmap (M1)

- [x] Repo + IPC types matching runner
- [x] `defineAgent` / `speak` helpers
- [x] Example bundle + template
- [ ] npm publish `@voicethere/agent@0.1`
- [ ] Runner loads `AGENT_BUNDLE_PATH` (M1.2)

See [runner POC plan M1](https://github.com/voicethere/development/blob/main/webrtc-cloud/plans/2026-06-03-runner-poc-execution.md).
