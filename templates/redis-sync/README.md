# redis-sync

Redis-backed world buffer sync for redis-sync-smoke (Advanced tier + project Redis). Not seeded on project create.

Clients publish a 12-byte `Float32Array([clientIndex, x, y])` on `voicethere-sync`. Each tick's Redis GET is copied into one `Float32Array` in place and every broadcast is one `broadCastBinaryToClients` call with the same persistent `Buffer` view over a live session array. Slot patches reuse one 16-byte scratch buffer.

## Protocol

- **Inbound (12 bytes):** little-endian `float32` `[clientIndex, x, y]` via `onDataChannelBinary`
- **Outbound:** full world blob (`MAX_PEERS` slots × `[clientIndex, x, y, active]`)
- **Redis:** key `e2e:redis-sync:world`, Lua `LUA_PATCH_PEER_SLOT`

Reuse one `Float32Array(3)` on the client (`sendSyncBinary`).

## Build

```bash
npx @voicethere/agent build --entry templates/redis-sync/agent.ts --outfile dist/agent.js
```

## Sources

- `agent.ts`, `world-layout.ts`
