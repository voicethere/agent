# Changelog

All notable changes to `@voicethere/agent` are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/). Versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
