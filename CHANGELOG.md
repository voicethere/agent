# Changelog

All notable changes to `@voicethere/agent` are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/). Versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.0] - 2026-08-25

### Added

- **`onWebhook`** — process-wide inbound HTTP webhook handler (`WebhookMessage` / `WebhookContext`). The runtime delivers the **raw body** as a `Buffer` plus inbound headers so you can verify HMAC (or any signature) **before** `JSON.parse`.
- **`webhooks` template** — verifies `x-agent-webhook-signature` (hex HMAC-SHA256 of the raw body) using `AGENT_WEBHOOK_SIGNING_SECRET`, then broadcasts `webhook_event` to connected sessions.
- **`webhooks-redis` template** — same verification, with project Redis for cross-pod session fan-out.
- **`webhook_handled` IPC** — child reports handler duration after `onWebhook` completes (parent metrics).

## [0.4.0] - 2026-08-23

### Added

- **Conversation recording controls** — `startRecording`, `pauseRecording`, `resumeRecording`, and `stopRecording` (`RecordingControlMessage` IPC) return `Promise<RecordingControlResult>` and await a parent `recording_control_ack` (`requestId` correlation).
- **`recordingAvailable` on `session_start`** — runner advertises when conversation recording is enabled for the project; exposed on `SessionContext` (defaults to `false` on older runners).
- **`local_mock` fast path** — when the agent is not a forked IPC child, recording helpers resolve immediately with `{ ok: true, reason: "local_mock" }` so local verify runs never block on a parent ACK.
- **`isRecordingAvailable(ctx)`** helper for consent gating before `startRecording`.

## [0.3.0] - 2026-08-02

### Added

- **`@voicethere/agent/templates`** — registry API (`listTemplates`, `getTemplate`, `resolveTemplateEntryPath`, `loadTemplateSources`, `loadTemplateBundle`, `hasSeedBundle`).
- Product seed-on-create templates with prebuilt `dist/templates/<id>/agent.js`: `echo`, `echo-dc`, `voice-starter`, `game-sync`.
- E2E template sources: `echo-smoke`, `crash`, `game-sync-smoke`, `redis-sync` (+ `./templates/redis-sync/world-layout` export).

## [0.2.17] - 2026-07-31

### Changed

- **Deps** — `@node-webrtc-rust/{helpers,sdk,signaling}` **0.7.0** (Opus SDP omits `maxaveragebitrate` unless env set; encode default 400 kbps).

## [0.2.16] - 2026-07-30

### Changed

- Bump `@node-webrtc-rust/{helpers,sdk,signaling}` to **0.6.24**.
- Sync Sherpa STT/TTS catalogs used by live-test model selection scripts.

## [0.2.15] - 2026-07-29

### Changed

- Bump `@node-webrtc-rust/{helpers,sdk,signaling}` to **0.6.21** (VoiceAgentSessionHost waits for voice-control DataChannel open before starting VoiceAgent).

## [0.2.14] - 2026-07-28

### Fixed

- **`SessionSerialQueue`** — keep the per-session row while connected (`pending === 0` no longer deletes it). Idle-delete made `isLive` false between inbound handlers and silently dropped timer/`sendBinaryToClient` fan-out (redis-sync world broadcast). Rows are removed only by `clear` (`session_end`); the leave-hook generation is cleared after the end handler finishes.
- **Outbound guards** — detached sends again require a registered live session that has not received `session_end` (not “a handler is currently running”).

## [0.2.13] - 2026-07-28

### Fixed

- **`SessionSerialQueue`** — generation-safe clear/reuse so stale handlers cannot mutate a later session generation; no per-session tombstone maps left at idle.
- **`session_end`** — invalidate/abort the live queue immediately on message arrival, then process end on a fresh generation.
- **Outbound guards** — generation-aware execution context blocks speak/send after clear or reuse.

## [0.2.12] - 2026-07-25

### Fixed

- **`SessionSerialQueue`** — task rejections are contained at the queue tail so they do not surface as process `unhandledRejection` events; pending state clears and later same-session tasks still run.
- **`defineAgent`** — installs a once-per-process `unhandledRejection` guard for detached customer promises, reporting a single `agent_error` (with active session id when AsyncLocalStorage context is available). Awaited handler failures remain reported only by the existing try/catch path. Does not install a non-fatal `uncaughtException` listener.

## [0.2.11] - 2026-07-20

### Added

- **Structured `agentLog`** — levels `debug|info|warn|error`, optional `fields` JSON, and `ts` on IPC `{ type: "log" }` payloads (backward-compatible sessionId argument).
- **Sandbox console overrides** — `console.debug/log/info/warn/error` send structured log IPC (object first-arg with `message`/`fields` supported).

## [0.2.10] - 2026-07-17

### Fixed

- **Sandbox IPC** — `startSandboxedChild` now forks with `serialization: "advanced"` so `sendBinaryToClient` payloads remain real `Buffer`s across parent/child IPC (default JSON serialization turned them into `{ type: "Buffer", data: [...] }` and broke WebRTC binary fan-out).

## [0.2.9] - 2026-07-17

### Changed

- **Node 26+** — CI, `engines`, and `verify` require Node **26+** because sandbox `--allow-net` is only enforced on Node 26. Runner images use Node 26 as well.
- **Sandbox network** — `buildChildExecArgv` always emits boolean `--allow-net` (opt out with `allowInternet: false`) so customer agents can `fetch` LLM APIs under `--permission`.

### Added

- **`test/fetch-sandbox.test.ts`** — sandboxed child can `fetch` `https://www.google.com/` with production execArgv flags.
- **`test/ioredis-bundle-sandbox.test.ts`** — builds an `ioredis` agent bundle and verifies `onAgentStart` can PING Redis under production sandbox flags.

### Fixed

- **`build` / `buildAgentBundle`** — bundle banner injects `createRequire` so inlined CJS deps (e.g. `ioredis`) can load Node built-ins (`events`, `net`, `stream`) without `Dynamic require of "events" is not supported`; stubs optional `supports-color` so debug code does not escape the sandbox fs allowlist.

## [0.2.8] - 2026-07-17

### Added

- **`onAgentStart`** — optional one-shot hook on `defineAgent` that runs before any session IPC is handled. Use it to open process-wide resources (for example an `ioredis` client via `process.env.AGENT_REDIS_URL` / `ctx.env.AGENT_REDIS_URL`). Errors are logged and reported as `agent_error`; session IPC is still accepted afterward so the child does not hang.
- **Sandbox `allowNetHosts`** — `buildChildExecArgv({ allowNetHosts })` emits scoped `--allow-net=<host>` flags so sandboxed children can reach project Redis while still denying `child_process`, fs writes, and addons.

### Docs

- Prefer depending on **`ioredis`** in your agent bundle and connecting inside `onAgentStart` when VoiceThere injects `AGENT_REDIS_URL`.

## [0.2.7] - 2026-07-17

### Changed

- **Dev tooling** — align `@node-webrtc-rust/helpers` to `^0.6.10` and matching `sdk` / `signaling` `0.6.9` for live-test `SessionPod` typing (no published runtime API change).

## [0.2.6] - 2026-07-13

### Fixed

- **`onIdleTimeout` TypeScript narrowing** — bind optional handler to a local before `await` so `tsc` accepts the call after the early-return path.

### Added

- **Idle timeout IPC logging** — `agentLog` lines when `idle_timeout` is received and when `idle_timeout_done` is sent (visible in runner Loki as `source: agent-child`).

## [0.2.5] - 2026-07-13

### Fixed

- **Idle timeout without `onIdleTimeout`** — when the agent bundle does not define `onIdleTimeout`, the child now sends `idle_timeout_done` immediately instead of going through the hook path (avoids an extra runner callback grace wait when no customer handler exists).

## [0.2.4] - 2026-06-30

### Added

- **`verify-start` command** — new `npx @voicethere/agent verify-start` runs a sandbox startup check that launches the bundle in the restricted child process, validates sandbox permission flags, and requires `session_start_ack`.

## [0.2.3] - 2026-06-30

### Changed

- **Static-only bundle verification** — `npx @voicethere/agent verify` no longer executes or imports customer bundle code; verification now performs static checks only.
- **Verification callback criteria** — replaced the `speak()` runtime requirement with callback coverage checks; bundles pass when they register `defineAgent(...)` and define at least one of: `onSpeechEvent`, `onUserSpeechFinal`, `onDataChannelMessage`, `onDataChannelBinary`.
- **Game/data-only compatibility** — game-only servers without `speak()` usage now pass verification when valid callback handlers are present.

## [0.2.2] - 2026-06-28

### Added

- **Configurable session start init delay** — runtime now supports `AGENT_SESSION_START_INIT_DELAY_ENABLED` (default `true`) and `AGENT_SESSION_START_INIT_DELAY_MS` (default `500`) to control startup stabilization wait before `onSessionStart`.
- **Runner export for queue utility** — `SessionSerialQueue` is now exported from `@voicethere/agent/runner`.
- **Queue pending-state API** — added `SessionSerialQueue.hasPending(sessionId)` for per-session queue state checks.

### Changed

- **Runtime tests** — added coverage for default/custom/disabled session-start delay behavior.

## [0.2.1] - 2026-06-28

### Added

- **Server-authoritative game live test page** — added `examples/live-test/game-sync.html` with room bootstrap, binary world render, per-client ownership colors, and incoming server sync-rate metrics.
- **Dedicated game stack command** — added `live-test:stack:game` for one-command data-only runs using `templates/game-sync.ts` and the game page.

### Changed

- **`templates/game-sync.ts` behavior** — switched to server-authoritative 60Hz simulation with wall/object collision bounce; client binary state writes are ignored by default.
- **Game template docs** — expanded `templates/README.md` and root/live-test docs to describe server-authoritative sync flow and usage.
- **Live-test binary robustness** — improved starter/runtime handling for binary payload forwarding across IPC/DataChannel boundaries.

## [0.2.0] - 2026-06-28

### Added

- **Standalone local live-test stack in `agent`** — added a self-contained starter and browser page (`scripts/live-test-starter.*`, `examples/live-test`) to run signaling + sandboxed agent bundle locally without runner-repo coupling.
- **Public runner runtime surface** — added `@voicethere/agent/runner` export and runtime entry (`src/runner.ts`) for shared sandbox child startup and bundle resolution logic.
- **Sherpa local model tooling in `agent`** — added standalone model catalogs (`scripts/sherpa-*.json`) and interactive selector (`scripts/select-sherpa-models.sh`) that downloads models into `agent/.models` and writes live-test env settings.

### Changed

- **Live-test scripts and docs** — moved local live testing to agent-only workflows (`live-test:starter`, `live-test:stack`), updated README/live-test docs, and added `.env.live-test.example`.
- **Protocol/runtime ergonomics** — re-exported `SpeechEvent` from `protocol.ts` for consistent type imports from `@voicethere/agent`.

## [0.1.14] - 2026-06-28

### Added

- **`agentLog` session context** — `sessionId` is now automatically attached to `AgentLogMessage` IPC; the runtime injects the active orchestrator session from handler context so `agentLog(level, message)` keeps its two-arg signature.

### Changed

- **Peer dependency** — `@node-webrtc-rust/sdk` `>=0.6.5` (aligns with latest SDK release).

## [0.1.13] - 2026-06-23

### Fixed

- **`speak()` after `session_end`** — no-op when the session is already ended (avoids errors from late TTS in teardown races).

### Changed

- **Peer dependency** — `@node-webrtc-rust/sdk` `>=0.6.2` (aligns with inbound STT finalize and post-utterance silence).

## [0.1.12] - 2026-06-20

### Added

- **`session_start_ack` IPC** — child confirms `session_start` handling completed so the parent can gate `speech_event` / data-channel messages until startup finishes.

### Fixed

- **Session serial queue tail cleanup** — compare the settled promise when removing per-session queue tails (avoids stale tail references under overlapping handlers).

## [0.1.11] - 2026-06-20

### Fixed

- **Shared child IPC ordering** — `defineAgent` serializes inbound parent messages per `sessionId` (FIFO) so `session_start` handlers (e.g. greet `speak`) complete before `session_end` for the same session under `shared_child_per_session` load.

## [0.1.10] - 2026-06-18

### Fixed

- **Sandbox bundle path** — `realpathSync` on bundle file for ESM `import()` under Node `--permission`; allowlist includes canonical bundle path (parity with runner child fork).

## [0.1.9] - 2026-06-16

### Fixed

- **`package.json` exports** — add `default` and `require` conditions for `.` and `./verify` so Node/tsx CJS resolution works (fixes `ERR_PACKAGE_PATH_NOT_EXPORTED` in platform workers and scripts).

## [0.1.8] - 2026-06-16

### Added

- Binary DataChannel IPC: `data_channel_binary` (parent→child) and `send_binary_to_client` (child→parent).
- `DataChannelContext.rawBinary`, optional `raw`, and `channel` (`control` | `sync`).
- `sendBinaryToClient(sessionId, data, channel?)` helper.

### Changed

- Peer dependency `@node-webrtc-rust/sdk` **>=0.5.4** (ArrayBuffer send/receive on data channels).

## [0.1.7] - 2026-06-15

### Added

- **`templates/echo.ts`** — full echo agent: TTS **"you said: …"** on voice finals and typed chat, plus DataChannel speech events and `chat_reply` (for platform **Echo (voice + chat)** template).
- **`AGENT_ECHO_PREFIX`** env override for the spoken/chat prefix (default `you said:`).

### Changed

- **`templates/README.md`** — documents `echo.ts` vs `echo-dc.ts`.

## [0.1.6] - 2026-06-15

### Added

- **`sendToClient(sessionId, payload)`** — send JSON to the browser over DataChannel from agent handlers.
- **`onDataChannelMessage`** handler on `defineAgent` for inbound client messages.
- **`templates/echo-dc.ts`** — starter template that echoes DataChannel chat (for dashboard debug chat).

## [0.1.5] - 2026-06-15

### Changed

- MIT license (A KIRILYUK LLC)

## [0.1.4] - 2026-06-09

### Added

- `./verify` package export — `runAgentVerify` for server-side bundle validation (`@voicethere/agent/verify`)

### Changed

- `@node-webrtc-rust/sdk` is **peerDependency only** (removed from `dependencies`) so consumers like the platform control plane can install verify without pulling native WebRTC bindings

## [0.1.3] - 2026-06-09

### Added

- `npx @voicethere/agent verify` — build (optional) and run sandbox checks on customer bundles; prints failing checks with details

### Changed

- CLI shows help when invoked with no subcommand (explicit `build` or `verify` required)
- Sandbox verify harness ships in the npm package (`src/sandbox`, `src/verify`)

## [0.1.2] - 2026-06-09

### Added

- `npx @voicethere/agent build` — bundle customer `agent.ts` to `dist/agent.js` (esbuild included; no separate devDependency)

## [0.1.1] - 2026-06-09

### Changed

- README and customer-facing docs: replace public runner repo links with VoiceThere agent runner (platform or internal deployment)
- Sandbox documentation: clarify that `fetch` / HTTP(S) to public APIs is supported on hosted sessions; trim internal infra details

## [0.1.0] - 2026-06-09

### Added

- Initial `@voicethere/agent` SDK: IPC protocol, `defineAgent`, `speak`, `agentLog`
- Re-exported `SpeechEvent` types from `@node-webrtc-rust/sdk/voice`
- `onSpeechEvent` handler and starter template covering all 14 `SpeechEvent` types
- Speech event IPC (`speech_event.event` with SDK `SpeechEvent` shapes)
- Local sandbox verify harness (`npm run verify:local`) aligned with runner child launcher
- Example bundle (`dist/agent.js`) and [`templates/agent.ts`](./templates/agent.ts)
- npm release workflow (`release/*` tags) — see [`scripts/RELEASE.md`](./scripts/RELEASE.md)
