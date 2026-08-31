# Agent templates

`@voicethere/agent` is the single source of truth for starter templates. Import the registry from `@voicethere/agent/templates`:

```typescript
import {
  listTemplates,
  getTemplate,
  resolveTemplateEntryPath,
  loadTemplateSources,
  loadTemplateBundle,
  hasSeedBundle,
} from "@voicethere/agent/templates";
```

## Product vs e2e

| Kind        | Dashboard create                                                                                                           | Prebuilt seed bundle                 | Typical consumer        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------- |
| **product** | Yes (`echo`, `echo-dc`, `voice-starter`, `game-sync`, `voice-showcase`, `recording-consent`, `webhooks`, `webhooks-redis`) | Yes — `dist/templates/<id>/agent.js` | Platform project create |
| **e2e**     | No                                                                                                                         | No — build from sources at test time | `voicethere/e2e` smokes |

Product templates always set `seedOnCreate: true`. CI fails if a product template is missing its prebuilt bundle after `npm run build`.

## Sources vs prebuilt

- **Sources** live under `templates/` in the published package (editable TypeScript).
- **Prebuilt** bundles are derived artifacts at `dist/templates/<id>/agent.js` for product templates only.
- `loadTemplateSources(id)` returns `{ path, content }[]` — the canonical tree for a future web editor.
- `loadTemplateBundle(id)` returns prebuilt bytes for platform seed/deploy (runner-ready `agent.js`).

Build a template locally:

```bash
npx @voicethere/agent build --entry templates/echo.ts --outfile dist/agent.js
```

Prebuild all product seed bundles (also runs in `npm run build`):

```bash
npm run build:templates
```

## Product templates

### `echo.ts` (`echo`)

Full echo debug agent for the VoiceThere dashboard — speaks **"you said: …"** on voice finals and text chat, relays speech events over DataChannel, and echoes chat replies on DC.

### `echo-dc.ts` (`echo-dc`)

Data-channel-only echo — relays speech events and chat text over DC without TTS.

### `agent.ts` (`voice-starter`)

Full starter bundle covering every speech event from `@node-webrtc-rust/sdk/voice`. Customize `onUserSpeechFinal` for your LLM/tools.

### `game-sync.ts` (`game-sync`)

Authoritative multi-object sync sample for real-time games/simulations (register, simulate, binary world snapshots). Live objects are capped at **25** per world; clients can send `{ type: "unregister" }` (or `{ type: "remove", objectId?: number }`) to release owned objects. Protocol helpers live in `game-sync-protocol.ts`.

When `AGENT_REDIS_URL` is set (project Redis), the world blob is stored at `game-sync:world` and shared across runner workers — Lua atomic allocate/release enforces the global cap; one worker holds a sim lock per tick. Without Redis, the template falls back to per-worker in-memory state (local live-test stack).

### `voice-showcase/` (`voice-showcase`)

Conversational voice demo for landing and dashboard previews — greets the user, asks for a name, then offers a menu: weather (Open-Meteo, no API key), count 1–10, short recipes, and rotating fun facts. Typed chat and voice finals share the same handler. Sends structured `menu` payloads plus `chat_reply` for the chat log.

Sources: `voice-showcase/agent.ts` (defineAgent wiring), `conversation.ts` (pure state machine), `weather.ts`, `recipes.ts`, `fun-facts.ts`.

### `recording-consent/` (`recording-consent`)

Demonstrates conversation recording consent on connect: asks whether recording is OK when the project has recording enabled, pauses capture while collecting name and date of birth, then resumes only if the customer consented. When project recording is off, logs a warning and never calls `startRecording`. Voice finals and typed chat share the same handler.

Sources: `recording-consent/agent.ts` (defineAgent wiring), `conversation.ts` (pure state machine).

### `webhooks.ts` (`webhooks`)

Inbound HTTP webhook sample — verifies `x-agent-webhook-signature` HMAC on the **raw body** with `AGENT_WEBHOOK_SIGNING_SECRET`, then `JSON.parse` and fans out to connected sessions via DataChannel + `speak`.

### `webhooks-redis.ts` (`webhooks-redis`)

Same HMAC verify path plus an atomic Redis counter (`AGENT_REDIS_URL`) before DataChannel fan-out. Fan-out to sessions does not require Redis; Redis is for shared cross-pod state.

## E2e templates

These mirror former `e2e/fixtures/*` sources. E2E resolves entries from the package, builds into ephemeral workdirs, and uploads `dist/agent.js`.

| Id                | Source                                    | Purpose                                       |
| ----------------- | ----------------------------------------- | --------------------------------------------- |
| `echo-smoke`      | `echo-smoke.ts`                           | voice-smoke, agent-smoke, cli-smoke           |
| `crash`           | `crash.ts`                                | session-errors-smoke, crash-policy smokes     |
| `game-sync-smoke` | `game-sync-smoke.ts`                      | deploy-smoke, shared-child, idle smokes       |
| `redis-sync`      | `redis-sync/agent.ts` + `world-layout.ts` | redis-sync-smoke (project Redis world buffer) |

**Note:** Product `echo` is not the same as e2e `echo-smoke` — keep both ids.

## Verify sandbox (no WebRTC)

```bash
npx @voicethere/agent verify
```
