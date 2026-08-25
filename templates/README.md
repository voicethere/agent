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

| Kind | Dashboard create | Prebuilt seed bundle | Typical consumer |
| --- | --- | --- | --- |
| **product** | Yes (`echo`, `echo-dc`, `voice-starter`, `game-sync`, `webhooks`, `webhooks-redis`) | Yes — `dist/templates/<id>/agent.js` | Platform project create |
| **e2e** | No | No — build from sources at test time | `voicethere/e2e` smokes |

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

Authoritative multi-object sync sample for real-time games/simulations (register, simulate, binary world snapshots).

### `webhooks.ts` (`webhooks`)

Inbound HTTP webhook sample — verifies `x-agent-webhook-signature` HMAC on the **raw body** with `AGENT_WEBHOOK_SIGNING_SECRET`, then `JSON.parse` and fans out to connected sessions via DataChannel + `speak`.

### `webhooks-redis.ts` (`webhooks-redis`)

Same HMAC verify path plus an atomic Redis counter (`AGENT_REDIS_URL`) before DataChannel fan-out. Fan-out to sessions does not require Redis; Redis is for shared cross-pod state.

## E2e templates

These mirror former `e2e/fixtures/*` sources. E2E resolves entries from the package, builds into ephemeral workdirs, and uploads `dist/agent.js`.

| Id | Source | Purpose |
| --- | --- | --- |
| `echo-smoke` | `echo-smoke.ts` | voice-smoke, agent-smoke, cli-smoke |
| `crash` | `crash.ts` | session-errors-smoke, crash-policy smokes |
| `game-sync-smoke` | `game-sync-smoke.ts` | deploy-smoke, shared-child, idle smokes |
| `redis-sync` | `redis-sync/agent.ts` + `world-layout.ts` | redis-sync-smoke (project Redis world buffer) |

**Note:** Product `echo` is not the same as e2e `echo-smoke` — keep both ids.

## Verify sandbox (no WebRTC)

```bash
npx @voicethere/agent verify
```
