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

## Verify locally (static checks, no runtime execution)

Before deploying to VoiceThere, build your bundle and run static checks:

```bash
npx @voicethere/agent verify
```

This runs a short checklist: Node version, bundle build, bundle presence, `defineAgent(...)` registration, and at least one supported callback (`onSpeechEvent`, `onUserSpeechFinal`, `onDataChannelMessage`, or `onDataChannelBinary`).

For sandbox startup validation (without full voice/WebRTC E2E), use:

```bash
npx @voicethere/agent verify-start --no-build --bundle ./dist/agent.js
```

`verify-start` launches the bundle in the sandboxed child with restricted Node flags (`--permission` + fs-read allowlist), sends `session_start`, and requires `session_start_ack`.

| Command | When to use |
| ------- | ----------- |
| `npx @voicethere/agent verify` | **Default** — build `agent.ts` → `dist/agent.js`, then run all static checks |
| `npx @voicethere/agent verify --no-build` | Re-run checks on an existing bundle |
| `npx @voicethere/agent verify --no-build --bundle ./dist/agent.js` | Verify a specific bundle path |
| `npx @voicethere/agent verify-start --no-build --bundle ./dist/agent.js` | Verify sandbox startup + restricted Node flags on a specific bundle |

Optional flags: `--entry` / `-e`, `--outfile` / `-o` (same as `build`).

This does **not** replace a voice roundtrip with mic/WebRTC — deploy to the VoiceThere platform for full E2E.

For repository-local verify scripts, `dist/cli.js` is generated from `src/cli.ts` by `npm run build:lib`.
That is the package-local `@voicethere/agent` CLI artifact (not `@voicethere/cli`).

## Live browser test page (local stack)

The live harness runs fully from the `agent` repo:

1. local starter (`node-webrtc-rust` signaling + voice pipeline + sandboxed child bundle)
2. built child bundle (`dist/agent.js`)
3. browser page (`examples/live-test/index.html`, served by the starter)

### One-time setup

```bash
# 1) agent live-test config (optional overrides for scripts)
cd agent
cp .env.live-test.example .env.live-test
```

### Configure STT/TTS for local live testing

The starter reads env in this order: shell env → `agent/.env.live-test`.

For local Sherpa, at minimum ensure:

- `SHERPA_STT_MODEL_PATH`
- `SHERPA_TTS_MODEL_PATH`
- optional: `SHERPA_STT_LANGUAGE`, `SHERPA_TTS_SPEAKER`

Where the paths come from:

- Sherpa bundles are downloaded into:
  - `agent/.models/`
- Catalog/source list:
  - `agent/scripts/sherpa-stt-catalog.json` (STT)
  - `agent/scripts/sherpa-tts-catalog.json` (TTS)

Use the agent helper to select models, download if missing, and emit absolute env exports:

```bash
npm run live-test:models
```

The script writes selected values into `agent/.env.live-test`.

To use hosted providers instead of local Sherpa, set in `agent/.env.live-test`:

- `VOICE_STT_PROVIDER` (`openai` | `deepgram` | `assemblyai` | `google`)
- `VOICE_TTS_PROVIDER` (`openai` | `elevenlabs` | `cartesia` | `google`)
- provider API keys (`OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `ASSEMBLYAI_API_KEY`, `ELEVENLABS_API_KEY`, `CARTESIA_API_KEY`, `GOOGLE_API_KEY`)
- optional model/voice overrides: `VOICE_STT_MODEL`, `VOICE_TTS_MODEL`, `VOICE_TTS_VOICE`, `VOICE_STT_LANGUAGE`

Vendor setup reference: https://github.com/akirilyuk/node-webrtc-rust#stttts-vendors-and-config

### Start local stack

From `agent/`:

```bash
npm install
npm run live-test:models   # select/download sherpa models and export env values
npm run live-test:stack:echo  # voice echo template
# or
npm run live-test:stack:game  # data-only game-sync template
```

This starts the local starter with your sandboxed bundle and serves the page.

Live-test scripts load optional overrides from `agent/.env.live-test` (or `LIVE_TEST_ENV_FILE`).

Open:

`http://127.0.0.1:8080/examples/live-test/index.html`

If you prefer separate terminals:

```bash
# Terminal A (agent starter + bundle + signaling)
npm run live-test:starter
```

The page uses `@voicethere/client/browser` (loaded via esm.sh) and renders two visualizers:

- local microphone input
- incoming remote/agent audio

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
  async onAgentStart({ env }) {
    // When project Redis is enabled, VoiceThere injects AGENT_REDIS_URL.
    // Depend on `ioredis` in your agent package and connect here (once per child).
    const redisUrl = env.AGENT_REDIS_URL // or process.env.AGENT_REDIS_URL
    if (redisUrl) {
      // const Redis = (await import('ioredis')).default
      // globalThis.redis = new Redis(redisUrl)
    }
  },
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

### Shared Redis (project-scoped)

On plans that include project Redis, the runner injects **`AGENT_REDIS_URL`** into the child environment and grants scoped `--allow-net` for that host. Add **`ioredis`** as a dependency of your agent, bundle it with the CLI, and open the client in **`onAgentStart`** so it is ready before any `onSessionStart` / session IPC.

| Export                                          | Purpose                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `defineAgent`                                   | Register `onAgentStart`, `onSessionStart`, `onSpeechEvent`, `onUserSpeechFinal`, `onSessionEnd` |
| `SpeechEvent`, `SpeechEventType`                | Re-exported **types** from `@node-webrtc-rust/sdk/voice`                              |
| `SPEECH_EVENT_TYPE`                             | Import from `@node-webrtc-rust/sdk/voice` (runtime constants; not bundled into child) |
| `speak`                                         | Request parent TTS                                                                    |
| `agentLog`                                      | Forward structured logs to parent                                                     |
| `ParentToChildMessage` / `ChildToParentMessage` | IPC contract shared with the VoiceThere agent runner                                   |

### Runner runtime subpath (minimal shared sandbox API)

For runner-side child bootstrap reuse, `@voicethere/agent` exposes:

```ts
import {
  buildChildExecArgv,
  collectAllowFsReadDirs,
  resolveBundlePath,
  startSandboxedChild,
} from "@voicethere/agent/runner";
```

This subpath is intentionally narrow: sandbox/startup primitives only. Runner-specific
session orchestration and crash policy remain in the runner codebase.

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

## Multiplayer / shared state

Each end-user connection must call **`startSession()`** once — one orchestrator session id per client (one signaling room per client). Do **not** join multiple browsers to the same session credentials.

When the VoiceThere project has **`shared_child_per_session`** enabled, every session on a runner pod shares **one** sandboxed `agent.js` process. Your handlers receive `sessionId` equal to the orchestrator session id (see `onClientJoin` / `onSessionStart`). Use that id with `speak`, `sendToClient`, and `broadcastToClients` to target the right WebRTC client.

The runtime processes parent IPC **in order per `sessionId`** while different sessions run independently — safe for greet-on-join and load with many concurrent connections.

For isolated voice agents (default), leave **`shared_child_per_session`** disabled — each session gets its own child process.

See [`templates/game-sync.ts`](./templates/game-sync.ts) for a data-only authoritative server example (60Hz server-side movement + collisions, client render-only).

### Game servers + parent/child IPC payload size guidance

For game-server style agents, state updates are sent back and forth between the trusted parent and sandboxed child over IPC (`process.send` / `process.on("message")`) using Node V8 serialization.

Current guidance:

- V8 serialization is fast enough for typical real-time sync payloads up to about **64kB**
- That is roughly **16,000 `float32` values** (4 bytes each)

If you need larger/faster transfers, we can support an alternative transport strategy, for example:

- direct process-to-process streaming over `stdin`/`stdout`
- shared-memory IPC between processes via a dedicated package

If you require this, please open an issue in this repository and we will prioritize implementation accordingly.

## Building your agent bundle

**Recommended:** bundle with the package CLI (same esbuild settings VoiceThere uses in production):

```bash
npm install @voicethere/agent
npx @voicethere/agent build
# or: npx @voicethere/agent build --entry src/agent.ts --outfile dist/agent.js
```

Defaults: entry `agent.ts`, output `dist/agent.js`. Upload the bundle (or point `AGENT_BUNDLE_PATH` at it locally). The CLI inlines npm dependencies (e.g. `ioredis`) into one file and wires `createRequire` for Node built-ins (`events`, `net`, `stream`, …) so the sandbox child does not need `node_modules` on disk.

After building, run **`npx @voicethere/agent verify-start --no-build --bundle dist/agent.js`** to confirm the bundle loads under production `--permission` flags (catches errors like `Dynamic require of "events" is not supported`).

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

The parent starts the child with Node’s [Permission Model](https://nodejs.org/api/permissions.html) (Node **26+** on VoiceThere runners). Capabilities are **deny-by-default**; only explicitly granted flags apply.

**Granted today** (via `execArgv` on `fork()`):

| Flag | Effect |
| ---- | ------ |
| `--permission` | Enables restriction mode |
| `--allow-fs-read=<loaderDir>` | Read files under the child loader directory |
| `--allow-fs-read=<bundleParentDir>` | Read files under the **directory containing your `agent.js`** (see below) |
| `--allow-net` | Outbound network (HTTPS/fetch, TCP) for customer LLM and tool APIs (Node **26+**) |
| `--allow-net=<host>` | Reserved for project Redis host entries when Node supports host-scoped net ACLs |

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

**Network under `--permission` (Node 26+).** Outbound network is blocked unless boolean `--allow-net` is passed. VoiceThere runners always grant `--allow-net` so sandboxed agents can `fetch` LLM and tool APIs. When `AGENT_REDIS_URL` is set, the runner also emits `--allow-net=<redis-host>` entries (forward-compatible with future host-scoped ACLs). **Private cluster addresses** remain unreachable from the child via platform network isolation — use IPC for voice, not in-cluster HTTP.

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

1. `npx @voicethere/agent verify` — build your bundle and run static checks
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
npm run verify:local    # repo dev: build example + static verify
npm run test:ci         # typecheck + vitest
```

Customer project:

```bash
npx @voicethere/agent build    # bundle agent.ts → dist/agent.js
npx @voicethere/agent verify   # build + static checks
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
