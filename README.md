# @voicethere/agent

VoiceThere **customer agent SDK** — TypeScript types and runtime helpers for sandboxed child bundles running inside the **VoiceThere agent runner** (session worker).

**npm:** `@voicethere/agent`  
**Repo:** [`voicethere/agent`](https://github.com/voicethere/agent)

## Role

| Layer     | Package                                                     | Runs in                              |
| --------- | ----------------------------------------------------------- | ------------------------------------ |
| Parent    | VoiceThere agent runner                                     | Trusted Node + WebRTC + speech stack |
| **Child** | **`@voicethere/agent`**                                     | Sandboxed customer `agent.js` bundle |

The child receives speech lifecycle events over IPC (same shapes as `@node-webrtc-rust/sdk/voice`) and calls `speak()` to request TTS from the parent.

## Quick start

```bash
git clone https://github.com/voicethere/agent.git
cd agent
npm install
npm run build
```

## Verify locally (sandbox, no WebRTC)

Before deploying to VoiceThere, build your bundle and run sandbox checks (same Node `--permission` flags as production):

```bash
npx @voicethere/agent verify
```

This runs a short checklist: Node version, bundle build, sandbox load, IPC `session_start`, `user_speech_final` → `speak`, and no `agent_error`. Failures print which check failed and why.

| Command | When to use |
| ------- | ----------- |
| `npx @voicethere/agent verify` | **Default** — build `agent.ts` → `dist/agent.js`, then run all checks |
| `npx @voicethere/agent verify --no-build` | Re-run checks on an existing bundle |
| `npx @voicethere/agent verify --no-build --bundle ./dist/agent.js` | Verify a specific bundle path |

Optional flags: `--entry` / `-e`, `--outfile` / `-o` (same as `build`).

This does **not** replace a voice roundtrip with mic/WebRTC — deploy to the VoiceThere platform for full E2E.

## API

```typescript
import {
  agentLog,
  defineAgent,
  speak,
  type SpeechEvent,
} from '@voicethere/agent'
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

| Export                                          | Purpose                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `defineAgent`                                   | Register `onSessionStart`, `onSpeechEvent`, `onUserSpeechFinal`, `onSessionEnd`       |
| `SpeechEvent`, `SpeechEventType`                | Re-exported **types** from `@node-webrtc-rust/sdk/voice`                              |
| `SPEECH_EVENT_TYPE`                             | Import from `@node-webrtc-rust/sdk/voice` (runtime constants; not bundled into child) |
| `speak`                                         | Request parent TTS                                                                    |
| `agentLog`                                      | Forward structured logs to parent                                                     |
| `ParentToChildMessage` / `ChildToParentMessage` | IPC contract shared with the VoiceThere agent runner                                   |

### Speech events (parent → child)

Forwarded from the runner voice pipeline as SDK `SpeechEvent` payloads on `speech_event.event` (`event.type`, optional `text` / `error`):

| Event                                         | Typical use in custom agent                             |
| --------------------------------------------- | ------------------------------------------------------- |
| `user_speaking_start` / `user_speaking_end`   | UI state, turn-taking                                   |
| `user_speech_partial`                         | Live captions, early barge-in logic                     |
| `user_speech_final`                           | Primary turn boundary (`onUserSpeechFinal` convenience) |
| `agent_speaking_start` / `agent_speaking_end` | Know when TTS playback starts/stops                     |
| `barge_in`                                    | User interrupted agent playback                         |
| `vad_triggered`, `stt_stream_*`, `user_stt_*` | Low-level pipeline hooks                                |
| `error`                                       | Vendor or pipeline failure                              |

Copy [`templates/agent.ts`](./templates/agent.ts) as a starting point — exhaustive `switch` over all 14 `SpeechEvent` types with per-peer state stubs and `agentLog` tracing.

## Building your agent bundle

**Recommended:** bundle with the package CLI (same esbuild settings VoiceThere uses in production):

```bash
npm install @voicethere/agent
npx @voicethere/agent build
# or: npx @voicethere/agent build --entry src/agent.ts --outfile dist/agent.js
```

Defaults: entry `agent.ts`, output `dist/agent.js`. Upload the bundle (or point `AGENT_BUNDLE_PATH` at it locally). Inlining dependencies avoids runtime `node_modules` resolution inside the sandbox.

## Sandbox and security model

Customer code runs in a **forked child process**, separate from the trusted agent runner parent (WebRTC, speech stack, TTS). Security is layered:

```text
┌──────────────────────────────────────────────────────────────┐
│  Agent runner parent (trusted) — WebRTC, speech stack, TTS   │
│    fork(loader-entry.js, execArgv: [--permission, …])       │
│         │ IPC (process.send / on('message'))                  │
│         ▼                                                     │
│  Customer child — Node Permission Model + stripped env      │
│    loader-entry.js → import(your agent.js)                   │
└──────────────────────────────────────────────────────────────┘
```

### Layer 1 — Process isolation

| Mechanism | What it means for your bundle |
| --------- | ----------------------------- |
| **Separate process** | Crash or `process.exit` in your bundle does not take down the parent voice stack |
| **IPC only for media** | WebRTC, mic, STT, and TTS go through the parent — use `defineAgent`, `speak`, and speech events |
| **Stripped `process.env`** | Child receives only `NODE_ENV`, internal loader path, and allowlisted keys (`SESSION_ID`, `PROJECT_ID`, `BUILD_ID`) — not parent secrets |
| **Console redirection** | `console.log` / `warn` / `error` → IPC logs |

### Layer 2 — Node `--permission` (runtime-enforced)

The parent starts the child with Node’s [Permission Model](https://nodejs.org/api/permissions.html) (Node **22+**). Capabilities are **deny-by-default**; only explicitly granted flags apply.

**Granted today** (via `execArgv` on `fork()`):

| Flag | Effect |
| ---- | ------ |
| `--permission` | Enables restriction mode |
| `--allow-fs-read=<loaderDir>` | Read files under the child loader directory |
| `--allow-fs-read=<bundleParentDir>` | Read files under the **directory containing your `agent.js`** (see below) |

**Not granted → blocked at runtime:**

| Missing flag | What fails |
| ------------ | ---------- |
| No `--allow-child-process` | `child_process`, `exec`, `spawn`, `fork` |
| No `--allow-fs-write` | Any file write (`writeFile`, logs to disk, etc.) |
| No extra `--allow-fs-read` paths | Reading `/etc/passwd`, parent files, etc. outside bundle dir |
| No `--allow-addons` | Native `.node` addons (`bcrypt`, `sharp`, …) |
| No `--allow-worker-threads` | `worker_threads` |
| No `--allow-wasi` | WASI modules |

This is **not** an import allowlist — Node gates **capability classes**, not package names. Using `node:fs` inside the allowed read tree can work; using it on `/etc/passwd` does not.

**Network is not gated by `--permission`.** `fetch`, `http`, `https`, and other outbound calls use the same network namespace as the parent. On VoiceThere-hosted sessions, **public internet egress is allowed** (e.g. calling your LLM or tool APIs). **Private cluster / internal platform addresses are not reachable** from the child — use the parent IPC surface for voice, not in-cluster services.

### Bundle directory vs single file

`--allow-fs-read` is applied to **`dirname(bundlePath)`**, not only the `.js` file:

```text
/app/agents/my-build/
  agent.js          ← entry (AGENT_BUNDLE_PATH)
  helper.js         ← importable if your bundle references it
  data.json         ← readable via fs if you import/read it
  node_modules/     ← JS-only deps may resolve; native addons still blocked
```

| Artifact in bundle dir | Works? |
| ---------------------- | ------ |
| Single bundled `agent.js` (recommended) | Yes |
| Extra pure `.js` / `.json` siblings | Usually yes (same allowed tree) |
| `node_modules/` with **JavaScript-only** packages | Often yes (Node resolves imports by reading under that tree) |
| **Native** npm packages (`.node` binaries) | **No** — requires `--allow-addons` (not enabled) |
| Packages that **spawn subprocesses** | **No** — no `--allow-child-process` |

Prefer **one esbuild bundle** so production behavior matches `npm run verify:local`.

### Layer 3 — Platform policy

| Capability | Behavior |
| ---------- | -------- |
| **Outbound network** (`fetch`, `http`, `https`) | **Public internet:** allowed — typical for LLM/tool calls from your agent code. **Internal platform / private network:** blocked on hosted sessions. |
| **`process.exit`** | Not blocked — kills your agent leg; parent may play crash TTS |
| **Direct WebRTC / mic / STT / TTS** | Parent only — use `speak()` and speech event handlers |

### What you should use in agent code

**Supported**

- `@voicethere/agent` (`defineAgent`, `speak`, `agentLog`, `onSpeechEvent`, …)
- Pure TypeScript/JavaScript logic and in-memory state
- **`fetch` / HTTP(S) to public APIs** (LLMs, tools, your backends on the internet)
- Allowlisted env from `onSessionStart` (`SESSION_ID`, `PROJECT_ID`, `BUILD_ID`)
- `SPEECH_EVENT_TYPE` from `@node-webrtc-rust/sdk/voice` at build time (avoid bundling the full SDK runtime into the child when possible)

**Blocked or unsupported**

- Subprocesses, shells, `child_process`
- Arbitrary filesystem access outside your bundle deployment directory
- File writes
- Native Node addons (`.node`)
- `worker_threads` (not allowed)
- Direct WebRTC / mic / STT / TTS (use parent IPC)
- Reachability to internal platform addresses from hosted sessions

**Pre-publish checklist**

1. `npx @voicethere/agent verify` — build your bundle and run sandbox checks
2. Deploy the bundle to VoiceThere (platform upload or CLI when available)

For iterative work: `npx @voicethere/agent build` then `npx @voicethere/agent verify --no-build`.

## Build outputs

| Path            | Purpose                                                     |
| --------------- | ----------------------------------------------------------- |
| `dist/index.js` | Published npm library entry                                 |
| `dist/agent.js` | Example bundle (`examples/agent.ts`) for local runner / verify |

## Scripts

```bash
npm run build           # compile SDK + example bundle (repo dev)
npm run build:lib       # compile SDK only (tsc → dist/)
npm run verify:local    # repo dev: build example + sandbox verify
npm run test:ci         # typecheck + vitest
```

Customer project:

```bash
npx @voicethere/agent build    # bundle agent.ts → dist/agent.js
npx @voicethere/agent verify   # build + sandbox checks
```

## Release

See [`scripts/RELEASE.md`](./scripts/RELEASE.md) — tag `release/X.Y.Z` triggers npm publish (same workflow pattern as [`node-webrtc-rust`](https://github.com/akirilyuk/node-webrtc-rust)).

## Related

| Repo                                                                          | Purpose                                                       |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| VoiceThere agent runner (internal session worker)                             | Hosts your `agent.js` bundle in production and local E2E      |
| [`voicethere/cli`](https://github.com/voicethere/cli)                         | CLI for the VoiceThere platform (projects, deploys, sessions) |
| [`akirilyuk/node-webrtc-rust`](https://github.com/akirilyuk/node-webrtc-rust) | WebRTC + voice SDK (`SpeechEvent` types)                      |

## License

MIT — see [LICENSE](./LICENSE).
