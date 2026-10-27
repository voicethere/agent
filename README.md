# @voicethere/agent

VoiceThere **customer agent SDK** — TypeScript types and runtime helpers for sandboxed child bundles running inside the **VoiceThere agent runner** (session worker).

**Website:** [voicethere.io](https://voicethere.io)  
**npm:** `@voicethere/agent`  
**Repo:** [`voicethere/agent`](https://github.com/voicethere/agent)

## Role

| Layer     | Package                 | Runs in                              |
| --------- | ----------------------- | ------------------------------------ |
| Parent    | VoiceThere agent runner | Trusted Node + WebRTC + speech stack |
| **Child** | **`@voicethere/agent`** | Sandboxed customer `agent.js` bundle |

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

This runs a short checklist: Node version, bundle build, bundle presence, `defineAgent(...)` registration, and at least one supported callback (`onSpeechEvent`, `onUserSpeechFinal`, `onUserLanguage`, `onDataChannelMessage`, or `onDataChannelBinary`).

For sandbox startup validation (without full voice/WebRTC E2E), use:

```bash
npx @voicethere/agent verify-start --no-build --bundle ./dist/agent.js
```

`verify-start` launches the bundle in the sandboxed child with restricted Node flags (`--permission` + fs-read allowlist), sends `session_start`, and requires `session_start_ack`.

| Command                                                                  | When to use                                                                  |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `npx @voicethere/agent verify`                                           | **Default** — build `agent.ts` → `dist/agent.js`, then run all static checks |
| `npx @voicethere/agent verify --no-build`                                | Re-run checks on an existing bundle                                          |
| `npx @voicethere/agent verify --no-build --bundle ./dist/agent.js`       | Verify a specific bundle path                                                |
| `npx @voicethere/agent verify-start --no-build --bundle ./dist/agent.js` | Verify sandbox startup + restricted Node flags on a specific bundle          |

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
- `VOICE_TTS_PROVIDER` (`openai` | `elevenlabs` | `cartesia` | `fishaudio` | `google`)
- provider API keys (`OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `ASSEMBLYAI_API_KEY`, `ELEVENLABS_API_KEY`, `CARTESIA_API_KEY`, `FISH_API_KEY`, `GOOGLE_API_KEY`)
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
} from "@voicethere/agent";
import { SPEECH_EVENT_TYPE } from "@node-webrtc-rust/sdk/voice";

defineAgent({
  async onAgentStart({ env }) {
    // When project Redis is enabled, VoiceThere injects AGENT_REDIS_URL.
    // Depend on `ioredis` in your agent package and connect here (once per child).
    const redisUrl = env.AGENT_REDIS_URL; // or process.env.AGENT_REDIS_URL
    if (redisUrl) {
      // const Redis = (await import('ioredis')).default
      // globalThis.redis = new Redis(redisUrl)
    }
  },
  onSessionStart({ sessionId }) {
    speak(sessionId, "Hello!");
  },
  onUserSpeechFinal({ sessionId, text }) {
    speak(sessionId, `You said: ${text}`);
  },
  onSpeechEvent({ sessionId }, speech: SpeechEvent) {
    if (speech.type === SPEECH_EVENT_TYPE.bargeIn) {
      agentLog("info", `User interrupted on ${sessionId}`);
    }
  },
});
```

### Shared Redis (project-scoped)

On plans that include project Redis, the runner injects **`AGENT_REDIS_URL`** into the child environment and grants scoped `--allow-net` for that host. Add **`ioredis`** as a dependency of your agent, bundle it with the CLI, and open the client in **`onAgentStart`** so it is ready before any `onSessionStart` / session IPC.

For inbound HTTP webhooks, configure **`AGENT_WEBHOOK_SIGNING_SECRET`** in project settings. The runner forwards the exact request bytes on process-wide **`onWebhook`** IPC (not session-queued). Verify HMAC on `ctx.body` before `JSON.parse` — VoiceThere does not verify signatures in the SDK. See [`templates/webhooks/agent.ts`](./templates/webhooks/agent.ts).

| Export                                                                                       | Purpose                                                                                                              |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `defineAgent`                                                                                | Register handlers including `onUserLanguage`, `onVoiceLanguageChanged`, `onSessionStart`, …                          |
| `SpeechEvent`, `SpeechEventType`                                                             | Re-exported **types** from `@node-webrtc-rust/sdk/voice` (includes `voice_language_changed`, …)                      |
| `SPEECH_EVENT_TYPE`                                                                          | Import from `@node-webrtc-rust/sdk/voice` (runtime constants; not bundled into child)                                |
| `speak`                                                                                      | Request parent TTS; `speak(sessionId, text, { interruptible: false })` keeps caller speech from cutting it           |
| `setVoiceLanguage`                                                                           | Change STT, TTS, or the vendor for one live session (`scope`, VoiceThere catalog ids, cloud vendors).                |
| `prepareVoiceLanguage`                                                                       | Warm the pools for a language without switching; resolves `{ ok, ready, reason }` (50 s timeout on older runners).   |
| `replayLastUtterance`                                                                        | Run the caller's last utterance through the current STT again; the final arrives with `replay: true` (10 s timeout). |
| `getVoiceLanguageSwitchSettings`                                                             | Project wait/ready messages and timing from `session_start`; `undefined` on older runners.                           |
| `getVoiceLanguage`                                                                           | Last known ISO 639-1 from a successful switch ack or LID / `voice_language_changed` events.                          |
| `isVoiceLanguageSwitchAvailable`                                                             | `true` when `session_start.voiceLanguageSwitchAvailable` was set (runner supports agent IPC).                        |
| `isRunnerLidAutoSwitchEnabled`                                                               | `true` when `session_start.env.SHERPA_LID_AUTO_SWITCH` is truthy (runner auto-switch; optional in env).              |
| `startRecording` / `pauseRecording` / `resumeRecording` / `stopRecording`                    | Request parent conversation recording control                                                                        |
| `setConversationHistoryEnabled` / `enableConversationHistory` / `disableConversationHistory` | Stop or resume conversation history storage for one session                                                          |
| `agentLog`                                                                                   | Forward structured logs to parent                                                                                    |
| `ParentToChildMessage` / `ChildToParentMessage`                                              | IPC contract shared with the VoiceThere agent runner                                                                 |

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

| Event                                                                                  | Typical use in custom agent                                                                                                                  |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_speaking_start` / `user_speaking_end`                                            | UI state, turn-taking                                                                                                                        |
| `user_speech_partial`                                                                  | Live captions, early barge-in logic                                                                                                          |
| `user_speech_final`                                                                    | Primary turn boundary (`onUserSpeechFinal` convenience)                                                                                      |
| `user_language`                                                                        | Detected ISO 639-1 (`onUserLanguage`). Does not change STT/TTS unless you call `setVoiceLanguage` or the project enables runner auto-switch. |
| `voice_language_switching` / `voice_language_changed` / `voice_language_switch_failed` | Runner language switch lifecycle; `onVoiceLanguageChanged` on `voice_language_changed`.                                                      |
| `agent_speaking_start` / `agent_speaking_end`                                          | Know when TTS playback starts/stops                                                                                                          |
| `barge_in`                                                                             | User interrupted agent playback                                                                                                              |
| `vad_triggered`, `stt_stream_*`, `user_stt_*`                                          | Low-level pipeline hooks                                                                                                                     |
| `error`                                                                                | Vendor or pipeline failure                                                                                                                   |

`voice_language_switch_failed` carries `from`, `to`, `reason`, `error`, `fallbackLanguage` and `attempts`. When the new language's speech models do not start in time (two attempts of about 20 s), `reason` is `"language_unavailable"`, `error` holds the underlying cause (`pool_timeout` or `pool_unavailable`) and the session continues in `fallbackLanguage`. The event arrives before the caller's held speech is transcribed in the previous language. `setVoiceLanguage` resolves `{ ok: false, reason: "language_unavailable" }` in the same case.

Copy [`templates/voice-starter/agent.ts`](./templates/voice-starter/agent.ts) as a starting point — exhaustive `switch` over speech event types with per-peer state stubs and `agentLog` tracing.

### Spoken-language switching

The built-in speech vendor is VoiceThere (id `voicethere`). Its voice and STT catalog ids (for example `de`, `en-lessac`, `en-small`) are documented on VoiceThere at `/docs/spoken-language`.

`setVoiceLanguage(sessionId, options)` and `prepareVoiceLanguage(sessionId, options)` take the same request:

| Field          | Type                                      | Meaning                                                                                   |
| -------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `language`     | string                                    | ISO 639-1 code such as `de`. Optional when you only change a cloud vendor.                |
| `scope`        | `"stt"`, `"tts"` or `"both"`              | Which side changes. Omit it to infer the side from the vendor objects you pass.           |
| `sttVendor`    | `{ provider, model?, language? }`         | Replaces the STT vendor. `provider` is required.                                          |
| `ttsVendor`    | `{ provider, model?, voice?, language? }` | Replaces the TTS vendor. `provider` is required; `language` only works with `voicethere`. |
| `voice`, `stt` | string                                    | Deprecated. Use `ttsVendor.voice` and `sttVendor.model`.                                  |

STT providers are `voicethere`, `openai`, `deepgram`, `assemblyai`, `google`, `elevenlabs`, `fishaudio`, `groq`, `azure` and `aws`. TTS providers are `voicethere`, `openai`, `elevenlabs`, `cartesia`, `fishaudio`, `google`, `deepgram`, `groq`, `azure` and `aws`. Cloud providers read their keys from project secrets, such as `AGENT_OPENAI_API_KEY`; a `missing_credentials` failure names the exact secret. Never put a key in the request.

A model, voice or language you leave out falls back to that vendor's default for `vendor.language ?? language ?? the session's current language`. For `voicethere`, `model` is the STT catalog id (`en`, `en-small`) and `voice` is the TTS catalog id (`en-lessac`).

```ts
// VoiceThere speech on both sides, in German
await setVoiceLanguage(sessionId, {
  scope: "both",
  language: "de",
  sttVendor: { provider: "voicethere", language: "de" },
  ttsVendor: { provider: "voicethere", language: "de" },
});

// Cloud STT only
await setVoiceLanguage(sessionId, {
  scope: "stt",
  sttVendor: { provider: "deepgram", model: "nova-3", language: "de" },
});

// Cloud TTS only
await setVoiceLanguage(sessionId, {
  scope: "tts",
  ttsVendor: { provider: "openai", model: "tts-1", voice: "alloy" },
});

// VoiceThere STT with ElevenLabs TTS
await setVoiceLanguage(sessionId, {
  scope: "both",
  language: "de",
  sttVendor: { provider: "voicethere" },
  ttsVendor: { provider: "elevenlabs" },
});
```

The SDK checks the request before it sends anything, so a bad request fails the same way on every runtime version. A failed call resolves `{ ok: false, reason, message }`; `message` says what to change.

| `reason`               | `message`                                                                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_request`      | `setVoiceLanguage options must be an object; language, scope, voice and stt are strings; sttVendor and ttsVendor are objects.`                                                            |
| `invalid_scope`        | `scope must be "stt", "tts" or "both".`                                                                                                                                                   |
| `missing_provider`     | `sttVendor.provider is required.` or `ttsVendor.provider is required.`                                                                                                                    |
| `conflicting_fields`   | `Pass the STT model as sttVendor.model, not stt, when sttVendor is set.` or `Pass the voice as ttsVendor.voice, not voice, when ttsVendor is set.`                                        |
| `scope_mismatch`       | `scope "tts" cannot change sttVendor; use scope "both" or drop sttVendor.` or the same for `scope "stt"` and `ttsVendor`                                                                  |
| `unsupported_field`    | `sttVendor has no voice field; set the voice with ttsVendor.voice.` or `ttsVendor.language only applies to provider "voicethere"; choose a voice for that language with ttsVendor.voice.` |
| `nothing_to_apply`     | `Pass sttVendor, ttsVendor or language.`                                                                                                                                                  |
| `unknown_vendor`       | Built by the runtime: `Unknown provider "<id>". STT providers: <list>. TTS providers: <list>.`                                                                                            |
| `unsupported_vendor`   | Built by the runtime: `"<id>" cannot be used for stt.` or `… for tts.`                                                                                                                    |
| `unknown_stt`          | `No VoiceThere STT model matches sttVendor.model or the language; use a catalog id such as "en" or "en-small".`                                                                           |
| `unknown_voice`        | `No VoiceThere voice matches ttsVendor.voice or the language; use a catalog id such as "en-lessac".`                                                                                      |
| `invalid_language`     | `language must be an ISO 639-1 code such as "en" or "de".`                                                                                                                                |
| `language_unavailable` | `The models for this language did not start; try again later or pick another language.`                                                                                                   |
| `unavailable`          | `Voice switching is not available for this session.`                                                                                                                                      |
| `timeout`              | `The voice switch did not finish in time; try again.`                                                                                                                                     |
| `missing_credentials`  | Built by the runtime: `Add the AGENT_<VENDOR>_API_KEY project secret for provider "<id>".`                                                                                                |

The top-level `voice` and `stt` fields and the provider ids `local-sherpa` and `cluster-sherpa` still work, but they are deprecated. Use `ttsVendor.voice`, `sttVendor.model` and `voicethere`. Results show the built-in speech as `voicethere` in `sttProvider` and `ttsProvider`.

| Approach                | Who changes STT/TTS                                                   | Agent hooks                                                                                                       |
| ----------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Manual (default)**    | Your code calls `setVoiceLanguage` per side or vendor                 | `onUserLanguage` → `setVoiceLanguage`; use `isVoiceLanguageSwitchAvailable` before relying on IPC                 |
| **Project auto-switch** | Runner when LID detects a new language (opt-in project voice setting) | `onUserLanguage` / `onVoiceLanguageChanged` for prompts; do not double-call `setVoiceLanguage` on every detection |

#### Switching without interrupting the caller

Three primitives let your agent run the whole switch while the caller keeps talking. `prepareVoiceLanguage(sessionId, options)` takes the same options as `setVoiceLanguage`, warms the target pools, and resolves `{ ok, ready, reason, message? }` without changing anything. `setVoiceLanguage` then swaps the voices. `replayLastUtterance(sessionId)` runs the caller's last utterance through the new STT, and the result reaches `onUserSpeechFinal` with `replay: true`.

```ts
onUserLanguage: async ({ sessionId, language }) => {
  const profile = {
    scope: "both",
    language,
    sttVendor: { provider: "voicethere", language },
    ttsVendor: { provider: "voicethere", language },
  } as const;
  const prepare = prepareVoiceLanguage(sessionId, profile); // start early, while the caller talks
  // ... when the caller's utterance is final:
  const ready = await prepare;
  if (ready.ok && ready.ready) {
    await setVoiceLanguage(sessionId, profile);
    await replayLastUtterance(sessionId);
  }
},
```

`getVoiceLanguageSwitchSettings(sessionId)` returns the project's `waitMessageMode` (`end_of_utterance`, `immediate` or `off`), wait messages, ready messages and `readyMessageMinMs`. `profile` can name other vendors with `sttVendor` / `ttsVendor`. Older runners never answer `prepareVoiceLanguage` or `replayLastUtterance`, so both resolve with `reason: "timeout"` (50 s and 10 s) and `getVoiceLanguageSwitchSettings` returns `undefined`; fall back to your own texts and call `setVoiceLanguage` directly.

See [`templates/language-switch`](./templates/language-switch/README.md) for both modes.

## Controlling agent speech

`speak()` returns a handle. `done` never rejects and tells you how the utterance ended.

```ts
import { defineAgent, speak, announce, cancelSpeech } from "@voicethere/agent";

defineAgent({
  onUserSpeechFinal: async ({ sessionId, text }) => {
    const first = speak(sessionId, "Let me check that for you.", {
      turnId: "reply-1",
    });
    const second = speak(sessionId, "Your order ships tomorrow.", {
      turnId: "reply-1",
    });
    const result = await second.done;
    // result.status: "played" | "interrupted" | "cancelled" | "failed" | "unsupported"
    // result.playedMs: how much of the utterance the caller heard
    if (result.status === "interrupted") first.cancel();

    // Never cut by the caller, never dropped from the queue.
    announce(sessionId, "This call may be recorded.");

    // Cancel by request, by turn, or everything pending for the session.
    cancelSpeech(sessionId, { turnId: "reply-1" });
  },
});
```

`turnId` groups several speaks into one reply. `inReplyTo` names the caller turn the reply answers.

### Barge-in control

```ts
import { setBargeIn, withoutBargeIn, speak } from "@voicethere/agent";

await setBargeIn(sessionId, false); // { ok, reason }
await setBargeIn(sessionId, true);

// Barge-in is switched back on even when the body throws.
await withoutBargeIn(sessionId, async () => {
  await speak(sessionId, "Please hold while I read the terms.").done;
});
```

### Knowing what the caller heard

When the caller cuts in, the runner sends one report per interruption, in session order before the next final transcript. `playedText` is estimated from timing unless `playedTextExact` is true.

```ts
import { defineAgent } from "@voicethere/agent";

const heard = new Map<string, string>();

defineAgent({
  onAgentInterrupted: ({ sessionId, playedText, unplayedText }) => {
    heard.set(
      sessionId,
      `You said "${playedText}" and were cut off before "${unplayedText}".`,
    );
  },
  onUserSpeechFinal: async ({ sessionId, text }) => {
    const note = heard.get(sessionId);
    heard.delete(sessionId);
    const prompt = note ? `${note}\n${text}` : text;
    // pass `prompt` to your model
  },
});
```

### Agent state

```ts
import { setAgentState } from "@voicethere/agent";

setAgentState(sessionId, "tool_call", { detail: "order lookup" }); // detail is cut to 64 characters
```

Keep customer content out of `detail`.

### Older runners

Runners that do not advertise speak control (`isSpeakControlAvailable(ctx)` is `false`) keep the old behaviour. `speak()` still plays, its result is `unsupported`, and `cancelSpeech`, `setAgentState` and `onAgentInterrupted` do nothing. `setBargeIn` resolves `{ ok: false, reason: "unsupported" }`. A warning is logged once per session.

### Host logic (`@voicethere/agent/host`)

`SessionSpeakController` implements the parent-side rules: speak results, cancellation, flushing queued speaks on barge-in, and the interruption report. It has no transport, so the VoiceThere runner and local tooling both drive it with the same code.

## Embeddings (`@voicethere/agent/llm`)

`createLlmEmbedder` returns an embedder for providers that publish an embeddings API: `openai`, `openrouter` and `gemini`. `anthropic` throws `LLM_EMBEDDINGS_UNSUPPORTED` (Anthropic has no embeddings API). Calls are bounded: 15 s per attempt, two retries on rate limits, 5xx and timeouts, 96 inputs per request. Returned vectors are L2-normalized (unit length) for every provider, so cosine similarity and inner product give the same ranking. Error messages never contain the input text.

```ts
import {
  createLlmEmbedder,
  DEFAULT_EMBEDDING_DIMS,
  DEFAULT_EMBEDDING_MODEL,
} from "@voicethere/agent/llm";
import { openai } from "@voicethere/agent/llm/openai";

const embedder = createLlmEmbedder({ provider: "openai", apiKey }, [openai]);
const { vectors } = await embedder.embed({
  model: DEFAULT_EMBEDDING_MODEL.openai,
  inputs: ["hello"],
  dimensions: DEFAULT_EMBEDDING_DIMS, // 512
});
```

## Knowledge base (RAG) on Project Redis (`@voicethere/agent/llm`)

`createRedisKnowledgeBase` indexes Markdown documents in the project's Redis (Redis 8 Query Engine, HNSW vector index, cosine) and returns the chunks closest to a question. It needs `ioredis` in your agent and an embedder from `createLlmEmbedder`. Redis 7 has no vector search: the call fails with `KB_REDIS_ERROR`.

```ts
import {
  createLlmEmbedder,
  createRedisKnowledgeBase,
  DEFAULT_EMBEDDING_DIMS,
  DEFAULT_EMBEDDING_MODEL,
} from "@voicethere/agent/llm";
import { openai } from "@voicethere/agent/llm/openai";
import pricing from "./knowledge/pricing.md";

const kb = createRedisKnowledgeBase({
  redisUrl: process.env.AGENT_REDIS_URL,
  documents: [{ id: "pricing.md", text: pricing }],
  embedder: createLlmEmbedder({ provider: "openai", apiKey }, [openai]),
  model: DEFAULT_EMBEDDING_MODEL.openai,
  dims: DEFAULT_EMBEDDING_DIMS,
});
await kb.ensureIndexed(); // embeds only when the documents, model or dims changed
const hits = await kb.search("how much is the starter plan?", 4);
// [{ text, title: "Pricing › Plans", source: "pricing.md", score }]
```

- Documents are split on `#`..`###` headings into chunks of about 300 words with 50 words of overlap. The same content (documents, model, dimensions) is not embedded twice, also across workers: one worker builds, the others wait and report `built-by-other-worker`.
- Vectors have no TTL, so `maxmemory-policy volatile-lru` never evicts them. The index refuses to grow past 80 % of `maxmemory` (`KB_MEMORY_LIMIT`). Plan on about 3.5 KB per chunk at 512 dimensions, which puts roughly 55,000 chunks in 200 MB; this is an estimate until measured on a real project.
- Use a namespace per knowledge set (`namespace` option). Keys are `kb:<namespace>:...`.
- Log lines carry the namespace, chunk count and durations, never chunk or query text.

## Multiplayer / shared state

Each end-user connection must call **`startSession()`** once — one orchestrator session id per client (one signaling room per client). Do **not** join multiple browsers to the same session credentials.

When the VoiceThere project has **`shared_child_per_session`** enabled, every session on a runner pod shares **one** sandboxed `agent.js` process. Your handlers receive `sessionId` equal to the orchestrator session id (see `onClientJoin` / `onSessionStart`). Use that id with `speak`, `sendToClient`, and `broadcastToClients` to target the right WebRTC client.

The runtime processes parent IPC **in order per `sessionId`** while different sessions run independently — safe for greet-on-join and load with many concurrent connections.

For isolated voice agents (default), leave **`shared_child_per_session`** disabled — each session gets its own child process.

See [`templates/game-sync/agent.ts`](./templates/game-sync/agent.ts) for a data-only authoritative server example (60Hz server-side movement + collisions, client render-only). Start simpler with [`templates/world-sync`](./templates/world-sync) (JSON) or [`templates/world-sync-binary`](./templates/world-sync-binary) (`ArrayBuffer` poses).

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

| Mechanism                  | What it means for your bundle                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Separate process**       | Crash or `process.exit` in your bundle does not take down the parent voice stack                                                         |
| **IPC only for media**     | WebRTC, mic, STT, and TTS go through the parent — use `defineAgent`, `speak`, and speech events                                          |
| **Stripped `process.env`** | Child receives only `NODE_ENV`, internal loader path, and allowlisted keys (`SESSION_ID`, `PROJECT_ID`, `BUILD_ID`) — not parent secrets |
| **Console redirection**    | `console.log` / `warn` / `error` → IPC logs                                                                                              |

### Layer 2 — Node `--permission` (runtime-enforced)

The parent starts the child with Node’s [Permission Model](https://nodejs.org/api/permissions.html) (Node **26+** on VoiceThere runners). Capabilities are **deny-by-default**; only explicitly granted flags apply.

**Granted today** (via `execArgv` on `fork()`):

| Flag                                | Effect                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `--permission`                      | Enables restriction mode                                                          |
| `--allow-fs-read=<loaderDir>`       | Read files under the child loader directory                                       |
| `--allow-fs-read=<bundleParentDir>` | Read files under the **directory containing your `agent.js`** (see below)         |
| `--allow-net`                       | Outbound network (HTTPS/fetch, TCP) for customer LLM and tool APIs (Node **26+**) |
| `--allow-net=<host>`                | Reserved for project Redis host entries when Node supports host-scoped net ACLs   |

**Not granted → blocked at runtime:**

| Missing flag                     | What fails                                                   |
| -------------------------------- | ------------------------------------------------------------ |
| No `--allow-child-process`       | `child_process`, `exec`, `spawn`, `fork`                     |
| No `--allow-fs-write`            | Any file write (`writeFile`, logs to disk, etc.)             |
| No extra `--allow-fs-read` paths | Reading `/etc/passwd`, parent files, etc. outside bundle dir |
| No `--allow-addons`              | Native `.node` addons (`bcrypt`, `sharp`, …)                 |
| No `--allow-worker-threads`      | `worker_threads`                                             |
| No `--allow-wasi`                | WASI modules                                                 |

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

| Artifact in bundle dir                            | Works?                                                       |
| ------------------------------------------------- | ------------------------------------------------------------ |
| Single bundled `agent.js` (recommended)           | Yes                                                          |
| Extra pure `.js` / `.json` siblings               | Usually yes (same allowed tree)                              |
| `node_modules/` with **JavaScript-only** packages | Often yes (Node resolves imports by reading under that tree) |
| **Native** npm packages (`.node` binaries)        | **No** — requires `--allow-addons` (not enabled)             |
| Packages that **spawn subprocesses**              | **No** — no `--allow-child-process`                          |

Prefer **one esbuild bundle** so production behavior matches `npm run verify:local`.

### Layer 3 — Platform policy

| Capability                                      | Behavior                                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Outbound network** (`fetch`, `http`, `https`) | **Public internet:** allowed — typical for LLM/tool calls from your agent code. **Internal platform / private network:** blocked on hosted sessions. |
| **`process.exit`**                              | Not blocked — kills your agent leg; parent may play crash TTS                                                                                        |
| **Direct WebRTC / mic / STT / TTS**             | Parent only — use `speak()` and speech event handlers                                                                                                |

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

| Path            | Purpose                                                        |
| --------------- | -------------------------------------------------------------- |
| `dist/index.js` | Published npm library entry                                    |
| `dist/agent.js` | Example bundle (`examples/agent.ts`) for local runner / verify |

## Scripts

```bash
npm run build           # compile SDK + example bundle (repo dev)
npm run build:lib       # compile SDK only (tsc → dist/)
npm run verify:local    # repo dev: build example + static verify
npm run test            # vitest (Redis Lua tests skip without a server)
npm run test:ci         # typecheck + vitest
npm run test:redis      # Lua + game-sync Redis agent tests (needs Redis)
```

World-sync coverage: JSON / binary / game-sync / redis-sync handler tests always run in memory. Lua allocate/release/slot-patch and the game-sync Redis agent path run against a real Redis when available:

1. `AGENT_TEST_REDIS_URL` or `REDIS_URL` (db defaults to 15 if omitted)
2. `redis://127.0.0.1:6379/15` if a server is already up
3. `redis-server` on PATH (ephemeral port)
4. `docker run redis:7-alpine` (disable with `AGENT_TEST_REDIS_DOCKER=0`)

CI starts a Redis service and sets `AGENT_TEST_REDIS_URL`. Mini-redis is only a PING mock for sandbox allow-net tests — it cannot run `EVAL`.

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
