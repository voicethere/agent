# Agent templates

`@voicethere/agent` is the single source of truth for starter templates. Each template lives in its own folder under `templates/<id>/` with a `README.md` and an `agent.ts` entry.

Import the registry from `@voicethere/agent/templates`:

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

| Kind        | Dashboard create                                                                                                                                                                 | Prebuilt seed bundle                 | Typical consumer        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------- |
| **product** | Yes (`echo`, `echo-dc`, `voice-starter`, `world-sync`, `world-sync-binary`, `game-sync`, `voice-showcase`, `recording-consent`, `positional-tts`, `spatial-showcase`, `webhooks`, `webhooks-redis`) | Yes — `dist/templates/<id>/agent.js` | Platform project create |
| **e2e**     | No                                                                                                                                                                               | No — build from sources at test time | `voicethere/e2e` smokes |

Product templates always set `seedOnCreate: true`. CI fails if a product template is missing its prebuilt bundle after `npm run build`.

## Sources vs prebuilt

- **Sources** live under `templates/<id>/` in the published package (editable TypeScript plus a README).
- **Prebuilt** bundles are derived artifacts at `dist/templates/<id>/agent.js` for product templates only.
- `loadTemplateSources(id)` returns `{ path, content }[]` — the canonical tree for a future web editor.
- `loadTemplateBundle(id)` returns prebuilt bytes for platform seed/deploy (runner-ready `agent.js`).

Build a template locally:

```bash
npx @voicethere/agent build --entry templates/echo/agent.ts --outfile dist/agent.js
```

Prebuild all product seed bundles (also runs in `npm run build`):

```bash
npm run build:templates
```

## World sync (data-only)

Three product templates cover positional / world sync, from JSON to Redis:

| Id                   | Channel                         | State                         |
| -------------------- | ------------------------------- | ----------------------------- |
| `world-sync`         | `onDataChannelMessage` (JSON)   | One agent, in-memory, no Redis |
| `world-sync-binary`  | `onDataChannelBinary` + `broadCastBinaryToClients` (`ArrayBuffer`) | One agent, in-memory, no Redis |
| `game-sync`          | JSON control + binary world snapshots | Redis when `AGENT_REDIS_URL` is set |

See each folder README for the wire format.

## Product templates

Each folder has its own README. Summary:

| Id | Folder | Summary |
| -- | ------ | ------- |
| `echo` | `echo/` | Voice + chat echo |
| `echo-dc` | `echo-dc/` | Data-channel echo, no TTS |
| `voice-starter` | `voice-starter/` | Every speech event |
| `world-sync` | `world-sync/` | JSON pose broadcast |
| `world-sync-binary` | `world-sync-binary/` | Binary pose `ArrayBuffer` |
| `game-sync` | `game-sync/` | Authoritative sim, Redis + binary snapshots |
| `voice-showcase` | `voice-showcase/` | Conversational landing demo |
| `recording-consent` | `recording-consent/` | Recording consent flow |
| `positional-tts` | `positional-tts/` | Orbiting TTS |
| `spatial-showcase` | `spatial-showcase/` | Orbit / soundboard / proximity |
| `webhooks` | `webhooks/` | Inbound HMAC webhooks |
| `webhooks-redis` | `webhooks-redis/` | Webhooks plus Redis counter |

## E2e templates

These mirror former `e2e/fixtures/*` sources. E2E resolves entries from the package, builds into ephemeral workdirs, and uploads `dist/agent.js`.

| Id                | Source                                         | Purpose                                       |
| ----------------- | ---------------------------------------------- | --------------------------------------------- |
| `echo-smoke`      | `echo-smoke/agent.ts`                          | voice-smoke, agent-smoke, cli-smoke           |
| `crash`           | `crash/agent.ts`                               | session-errors-smoke, crash-policy smokes     |
| `game-sync-smoke` | `game-sync-smoke/agent.ts`                     | deploy-smoke, shared-child, idle smokes       |
| `redis-sync`      | `redis-sync/agent.ts` + `world-layout.ts`      | redis-sync-smoke (project Redis world buffer) |
| `mix-smoke`       | `mix-smoke/agent.ts`                           | voice-data-mix-smoke                          |

**Note:** Product `echo` is not the same as e2e `echo-smoke` — keep both ids.

## Verify sandbox (no WebRTC)

```bash
npx @voicethere/agent verify
```
