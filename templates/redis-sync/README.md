# redis-sync

Redis-backed world buffer sync for redis-sync-smoke (Advanced tier + project Redis). Not seeded on project create.

One `Float32Array` holds the world per pod; each tick's Redis GET is copied into it in place and every broadcast is one `broadCastBinaryToClients` call with the same persistent `Buffer` view over a live session array. Slot patches reuse one 16-byte scratch buffer.

## Build

```bash
npx @voicethere/agent build --entry templates/redis-sync/agent.ts --outfile dist/agent.js
```

## Sources

- `agent.ts`, `world-layout.ts`
