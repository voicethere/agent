# Live browser test page

Manual voice test harness for local/dev sessions with dual visualizers:

- **Mic visualizer** (local input)
- **Incoming visualizer** (remote/agent audio)
- **Data channel chat** send/echo (`{ type: "chat", text }`)
- **Game sync canvas** (`game-sync.html`) for server-authoritative binary world sync + collisions

## Run (agent-only local stack)

The test page requires only the agent starter + your built bundle.

1. Prepare agent live-test env (optional overrides used by helper scripts):

```bash
cd agent
cp .env.live-test.example .env.live-test
```

Voice config notes:

- default `.env.live-test` can use `local-sherpa` (`SHERPA_STT_MODEL_PATH`, `SHERPA_TTS_MODEL_PATH`)
- you can switch providers via `VOICE_STT_PROVIDER` / `VOICE_TTS_PROVIDER`
- set matching API keys in `agent/.env.live-test` (for example `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, etc.)
- local-sherpa model bundles live under `agent/.models`
- easiest setup from `agent/`: `npm run live-test:models` (interactive menu + download + env export)
- `npm run live-test:models` writes SHERPA_* values into `agent/.env.live-test`
- vendor env setup reference: https://github.com/akirilyuk/node-webrtc-rust#stttts-vendors-and-config

2. From `agent/`, start one of the predefined stacks:

```bash
npm install
npm run live-test:stack:echo   # voice echo template (examples/agent.ts)
npm run live-test:stack:game   # data-only, server-authoritative game sync (templates/game-sync.ts)
```

Open:

`http://127.0.0.1:8080/examples/live-test/index.html`

Game sync page:

`http://127.0.0.1:8080/examples/live-test/game-sync.html`

Each command rebuilds the selected bundle on start. You can still override entry/mode manually:

```bash
export LIVE_TEST_AGENT_ENTRY=templates/game-sync.ts
export LIVE_TEST_SESSION_MODE=data-only
npm run live-test:stack
```

`live-test:stack` starts one process that serves both signaling and this page.

## Inputs

- **Signaling URL** (local default: `ws://127.0.0.1:8080/ws`)
- **Session ID / Room ID** (local default: `local-dev`)
- **Join token** (local default: `local-dev`, ignored by local starter)

For cloud/provisioned sessions, paste the values from session credentials.
