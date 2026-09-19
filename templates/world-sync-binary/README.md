# world-sync-binary

Single-agent positional sync using **binary** DataChannel frames. No Redis.

Clients send an `ArrayBuffer` of three little-endian float32 values `[x, y, z]`. Reuse one `Float32Array(3)` on the client. The agent stores xyz in one `Float32Array`, rewrites a single `WorldSnapshotBuffer` in place, and fans the resulting view out with `broadCastBinaryToClients` — one `Buffer` wrap per tick, zero byte copies.

## Protocol

- **Inbound (12 bytes):** `Float32Array([x, y, z]).buffer`
- **Outbound snapshot:** `uint32le peerCount`, then per peer `uint16le idLength` + UTF-8 `sessionId` + `float32le x,y,z`

## Build

```bash
npx @voicethere/agent build --entry templates/world-sync-binary/agent.ts --outfile dist/agent.js
```

## Sources

- `agent.ts` — `onDataChannelBinary` + `broadCastBinaryToClients`
- `protocol.ts` — encode/decode helpers; `WorldSnapshotBuffer` reuses one backing array
