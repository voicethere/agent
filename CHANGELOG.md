# Changelog

All notable changes to `@voicethere/agent` are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/). Versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
