# agent

VoiceThere **customer agent SDK** — TypeScript types and runtime helpers for sandboxed child bundles running inside [`voicethere/runner`](https://github.com/voicethere/runner).

**npm:** `@voicethere/agent` (private until publish)  
**Repo:** [`voicethere/agent`](https://github.com/voicethere/agent)

## Role

| Layer | Package | Runs in |
|-------|---------|---------|
| Parent | `runner` | Trusted Node + WebRTC + Sherpa |
| **Child** | **`@voicethere/agent`** | Sandboxed customer `agent.js` bundle |

The child receives `user_speech_final` over IPC and calls `speak()` to request TTS from the parent.

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
import { defineAgent, speak } from '@voicethere/agent'

defineAgent({
  onSessionStart({ sessionId }) {
    speak(sessionId, 'Hello!')
  },
  onUserSpeechFinal({ sessionId, text }) {
    speak(sessionId, `You said: ${text}`)
  },
})
```

| Export | Purpose |
|--------|---------|
| `defineAgent` | Register `onSessionStart`, `onUserSpeechFinal`, `onSessionEnd` |
| `speak` | Request parent TTS |
| `agentLog` | Forward structured logs to parent |
| `ParentToChildMessage` / `ChildToParentMessage` | IPC contract (mirrors `runner/src/child/protocol.ts`) |

Copy [`templates/agent.ts`](./templates/agent.ts) as a starting point.

## Sandbox policy

Customer bundles run in an isolated child process. **Do not import or use:**

- `node:fs`, `node:child_process`, `node:net`, `node:dns`, `node:cluster`
- `process.exit`, spawning subprocesses, or raw network clients

Allowed: pure logic, `@voicethere/agent`, and allowlisted env (`SESSION_ID`, `PROJECT_ID`, `BUILD_ID`). Full enforcement lands in runner P1.4.

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
