# game-sync

Authoritative multi-object world sync for games and simulations. Live objects are capped at **25**. Clients register over JSON; the agent simulates at 60 Hz and broadcasts a **quantized binary** world frame at 30 Hz (every second sim tick) with `broadCastBinaryToClients`.

## Frame format

`u8 format (2) · u8 version (1) · u16le objectCount`, then one 18 B record per live object: `u16le objectId` and eight `i16le` values `[posX posY posZ posW dirX dirY dirZ dirW]`. Positions are bounded to the 1280 x 720 board and velocities to +-1024 px/s; `z`, `w`, `dirZ` and `dirW` are unit components stored as `round(v x 32767)`. A value outside its range is clamped and counted. A full frame of 25 objects is 454 B (the earlier Float32 snapshot was 900 B). The vectors in `templates/redis-sync/quantized-frames.vectors.json` (`gameSync`) pin the encoding, and `world-layout.ts` exports the encoder and decoder.

## Redis

When `AGENT_REDIS_URL` is set (Project Redis), the world blob (float32) lives at `game-sync:world` and is shared across runner workers. World writes (allocate, release, sim commit) take the `game-sync:sim-lock`, which holds a random per-attempt token: it is released by compare-and-delete and every write is conditional on the token, so a pod whose lock expired cannot overwrite a newer world. The world is stored with `game-sync:sim-at` (Redis clock, ms). A step advances by `now - sim-at` and is skipped when that is under one sim interval, so any number of pods simulate wall time once. When the lock is lost twice in a row, a register or unregister answers `{ type: "register_nack" | "unregister_nack", reason: "busy" }` and the client retries. Pods from before 0.37.0 use neither the token-conditional commit nor `game-sync:sim-at`, so do not run old and new game-sync pods side by side in one project; redeploy all pods.

Without Redis, state is per-worker in memory. The tick is allocation-free: live object ids go into a reusable `Int32Array`, tick bodies are module-level functions, and the broadcast is one call over a live session array.

This is the most advanced world-sync starter: Redis + quantized binary frames + server-side physics.

## Build

```bash
npx @voicethere/agent build --entry templates/game-sync/agent.ts --outfile dist/agent.js
```

## Sources

- `agent.ts` — `defineAgent` wiring, register/unregister, sim loop
- `protocol.ts` — JSON control messages
- `world-layout.ts` — Float32Array slot layout and the quantized frame encoder/decoder
- `quantize.ts` — int16 quantizer (same content as `redis-sync/quantize.ts`)
- `sim.ts` — wall bounce + collisions
- `redis.ts` — Lua allocate/release
