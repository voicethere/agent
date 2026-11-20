# redis-sync

Redis-backed world buffer sync for redis-sync-smoke (Advanced tier + project Redis). Not seeded on project create.

Clients publish a 12-byte `Float32Array([clientIndex, x, y])` on `voicethere-sync`. The agent quantizes the pose once (int16 over the board, see `BOARD_MIN`/`BOARD_MAX`) and writes only that slot to Redis with `SETRANGE`. Each pod ticks at 20 Hz: one Redis GET, a diff against the world it last broadcast, and one `broadCastBinaryToClients` call with the changed slots. An empty delta is not sent. Buffers are allocated once per pod.

## Protocol

- **Inbound (12 bytes):** little-endian `float32` `[clientIndex, x, y]` via `onDataChannelBinary`. Non-finite values and an index of 128 or more are dropped and counted.
- **Outbound frame:** `u8 kind (1 keyframe, 2 delta) · u8 version (1) · u16le slotCount`, then `slotCount` x 6 B slots: `u8 clientIndex · u8 active · i16le x · i16le y`. A keyframe carries every active slot and replaces the client world; a delta carries slots changed since the last broadcast, and a slot that left goes out once with `active = 0`. A decoder that sees an unknown kind or version throws `SyncFrameError`.
- **Keyframes:** a joining session gets one built from the last-broadcast world, and every session gets one each second (`KEYFRAME_INTERVAL_MS`).
- **Redis:** key `e2e:redis-sync:world:v2`, 128 x 6 B = 768 B, one `SETRANGE` of 6 B per position update (no Lua).
- **Test vectors:** `quantized-frames.vectors.json` (encoded frames and their decode), also exported as `@voicethere/agent/templates/redis-sync/quantized-frames.vectors.json`.

Reuse one `Float32Array(3)` on the client (`sendSyncBinary`).

## Build

```bash
npx @voicethere/agent build --entry templates/redis-sync/agent.ts --outfile dist/agent.js
```

## Sources

- `agent.ts`, `world-layout.ts`, `quantize.ts`
