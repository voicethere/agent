# @voicethere/agent

VoiceThere **customer agent SDK** — TypeScript types and runtime helpers for sandboxed child bundles running inside [`voicethere/runner`](https://github.com/voicethere/runner).

**npm:** `@voicethere/agent`  
**Repo:** [`voicethere/agent`](https://github.com/voicethere/agent)

## Role

| Layer     | Package                                                     | Runs in                              |
| --------- | ----------------------------------------------------------- | ------------------------------------ |
| Parent    | [`voicethere/runner`](https://github.com/voicethere/runner) | Trusted Node + WebRTC + speech stack |
| **Child** | **`@voicethere/agent`**                                     | Sandboxed customer `agent.js` bundle |

The child receives speech lifecycle events over IPC (same shapes as `@node-webrtc-rust/sdk/voice`) and calls `speak()` to request TTS from the parent.

## Quick start

```bash
git clone https://github.com/voicethere/agent.git
cd agent
npm install
npm run build
```

Run with a local [runner](https://github.com/voicethere/runner) (clone that repo alongside this one):

```bash
cd ../runner
AGENT_BUNDLE_PATH=../agent/dist/agent.js npm run start
```

Open the runner URL in a browser, connect, and speak.

## Verify locally (sandbox, no WebRTC)

Before deploying to VoiceThere, confirm your bundle loads and responds under the **same Node sandbox** the runner uses:

```bash
npm run verify:local
```

| Script                    | When to use                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify:local`    | **Default** — `npm run build`, then fork `dist/agent.js` in the sandbox and assert a `speak` reply to `user_speech_final` |
| `npm run verify:local:only` | Re-run smoke after build; optional `AGENT_BUNDLE_PATH=./dist/agent.js` or `--bundle <path>`                               |

This checks bundle load, IPC, and Node permission flags. It does **not** replace a voice roundtrip — use [`voicethere/runner`](https://github.com/voicethere/runner) for mic/WebRTC E2E.

Harness: [`scripts/sandbox/`](./scripts/sandbox/) (aligned with [`voicethere/runner`](https://github.com/voicethere/runner) child launcher).

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
| `ParentToChildMessage` / `ChildToParentMessage` | IPC contract shared with [`voicethere/runner`](https://github.com/voicethere/runner)   |

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

**Recommended:** single ESM bundle (esbuild or similar):

```bash
npm install @voicethere/agent esbuild
npx esbuild agent.ts --bundle --platform=node --format=esm --outfile=dist/agent.js
```

Upload `dist/agent.js` (or point `AGENT_BUNDLE_PATH` at it locally). Inlining dependencies avoids runtime `node_modules` resolution inside the sandbox.

## Sandbox and security model

Customer code runs in a **forked child process**, separate from the trusted runner parent (Sherpa, WebRTC, TTS). Security is layered:

```text
┌──────────────────────────────────────────────────────────────┐
│  Runner parent (trusted) — full Node, WebRTC, speech stack   │
│    fork(loader-entry.js, execArgv: [--permission, …])       │
│         │ IPC (process.send / on('message'))                  │
│         ▼                                                     │
│  Customer child — Node Permission Model + stripped env      │
│    loader-entry.js → import(your agent.js)                   │
└──────────────────────────────────────────────────────────────┘
          │ same pod network namespace (K8s)
          ▼
   Cilium NetworkPolicy on runner pod (egress rules)
```

### Layer 1 — Process isolation

| Mechanism | What it means for your bundle |
| --------- | ----------------------------- |
| **Separate process** | Crash or `process.exit` in your bundle does not take down the parent voice stack |
| **IPC only** | Talk to the platform via `defineAgent` / `speak` / `agentLog` — not direct WebRTC or STT |
| **Stripped `process.env`** | Child receives only `NODE_ENV`, internal loader path, and allowlisted keys (`SESSION_ID`, `PROJECT_ID`, `BUILD_ID`) — not parent/kube secrets |
| **Console redirection** | `console.log` / `warn` / `error` → IPC logs; raw stdout is not forwarded to cluster logs |

### Layer 2 — Node `--permission` (runtime-enforced)

The parent starts the child with Node’s [Permission Model](https://nodejs.org/api/permissions.html) (Node **22+**). Capabilities are **deny-by-default**; only explicitly granted flags apply.

**Granted today** (via `execArgv` on `fork()`):

| Flag | Effect |
| ---- | ------ |
| `--permission` | Enables restriction mode |
| `--allow-fs-read=<loaderDir>` | Read files under the runner’s child loader directory |
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

### Layer 3 — Platform policy (documented; not all enforced in-process)

These are **unsupported** in customer bundles even if Node might not block them today:

| Capability | Enforcement |
| ---------- | ----------- |
| **Outbound network** (`fetch`, `http`, `net`, `dns`) | Not gated by `--permission`; child shares the **pod** network. Runner pods use **Cilium NetworkPolicy** (public egress; cluster/RFC1918 denied). **Do not** rely on network from child — use parent/platform APIs. |
| **`process.exit`** | Not blocked — kills your agent leg; parent may play crash TTS |
| **Direct WebRTC / mic / STT / TTS** | Parent only — use `speak()` and speech event handlers |

### Layer 4 — Kubernetes (runner pod)

On cluster deploy, the runner pod also has Helm hardening (non-root, read-only rootfs, dropped caps) and **NetworkPolicy** for egress. That applies to the whole pod (parent + child).

### What you should use in agent code

**Supported**

- `@voicethere/agent` (`defineAgent`, `speak`, `agentLog`, `onSpeechEvent`, …)
- Pure TypeScript/JavaScript logic and in-memory state
- Allowlisted env from `onSessionStart` (`SESSION_ID`, `PROJECT_ID`, `BUILD_ID`)
- `SPEECH_EVENT_TYPE` from `@node-webrtc-rust/sdk/voice` at build time (avoid bundling the full SDK runtime into the child when possible)

**Blocked or unsupported**

- Subprocesses, shells, `child_process`
- Arbitrary filesystem access outside your bundle deployment directory
- File writes
- Native Node addons (`.node`)
- `worker_threads` (not allowed)
- Direct media/network stack access

**Pre-publish checklist**

1. `npm run build` — produce `dist/agent.js`
2. `npm run verify:local` — sandbox + IPC smoke (same flags as production child)
3. Optional: voice E2E with [`voicethere/runner`](https://github.com/voicethere/runner)

## Build outputs

| Path            | Purpose                                                     |
| --------------- | ----------------------------------------------------------- |
| `dist/index.js` | Published npm library entry                                 |
| `dist/agent.js` | Example bundle (`examples/agent.ts`) for local runner / verify |

## Scripts

```bash
npm run build           # library + example bundle
npm run verify:local    # sandbox smoke (build + fork bundle)
npm run test:ci         # typecheck + vitest
```

## Release

See [`scripts/RELEASE.md`](./scripts/RELEASE.md) — tag `release/X.Y.Z` triggers npm publish (same workflow pattern as [`node-webrtc-rust`](https://github.com/akirilyuk/node-webrtc-rust)).

## Related

| Repo                                                                          | Purpose                                                       |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [`voicethere/runner`](https://github.com/voicethere/runner)                   | Session worker that hosts your `agent.js` bundle              |
| [`voicethere/cli`](https://github.com/voicethere/cli)                         | CLI for the VoiceThere platform (projects, deploys, sessions) |
| [`akirilyuk/node-webrtc-rust`](https://github.com/akirilyuk/node-webrtc-rust) | WebRTC + voice SDK (`SpeechEvent` types)                      |
