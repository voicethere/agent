# world-sync

Super-simple positional sync for a **data-only** project. One in-memory agent (no Redis) stores the latest `{ x, y, z }` per session and broadcasts a JSON world snapshot.

Use this when you want `onDataChannelMessage` plus `sendToClient` and nothing else.

## Protocol

- **Inbound:** `{ "type": "pose", "x": 1, "y": 0, "z": -2 }` (or `{ "x", "y", "z" }`)
- **Outbound:** `{ "type": "world", "poses": { "<sessionId>": { "x", "y", "z" } } }`

## Build

```bash
npx @voicethere/agent build --entry templates/world-sync/agent.ts --outfile dist/agent.js
```

## Sources

- `agent.ts` — `defineAgent` wiring and pose parse helper
