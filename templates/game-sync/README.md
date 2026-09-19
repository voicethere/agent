# game-sync

Authoritative multi-object world sync for games and simulations. Live objects are capped at **25**. Clients register over JSON; the agent simulates at 60 Hz and broadcasts a **binary** `Float32Array` world snapshot with `sendBinaryToClient`.

When `AGENT_REDIS_URL` is set (Project Redis), the world blob lives at `game-sync:world` and is shared across runner workers. Redis GET bytes are copied into the one in-memory `Float32Array` (the GET reply is the only per-tick allocation); sim, broadcast, and Redis `SET` all use one persistent `Buffer` view of that array. The tick itself is allocation-free: live object ids are collected into a reusable `Int32Array`, tick bodies are module-level functions (no per-tick closures or option objects), and the broadcast is a single `broadCastBinaryToClients` call over a live session array. Without Redis, state is per-worker in memory.

This is the most advanced world-sync starter: Redis + binary snapshots + server-side physics.

## Build

```bash
npx @voicethere/agent build --entry templates/game-sync/agent.ts --outfile dist/agent.js
```

## Sources

- `agent.ts` — `defineAgent` wiring, register/unregister, sim loop
- `protocol.ts` — JSON control messages
- `world-layout.ts` — Float32Array slot layout
- `sim.ts` — wall bounce + collisions
- `redis.ts` — Lua allocate/release
