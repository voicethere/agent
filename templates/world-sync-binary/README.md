# world-sync-binary

Single-agent positional sync using **binary** DataChannel frames. No Redis.

Clients send an `ArrayBuffer` of three little-endian float32 values `[x, y, z]`. The agent handles them in `onDataChannelBinary` and fans the packed world out with `sendBinaryToClient`.

## Protocol

- **Inbound (12 bytes):** `Float32Array([x, y, z]).buffer`
- **Outbound snapshot:** `uint32le peerCount`, then per peer `uint16le idLength` + UTF-8 `sessionId` + `float32le x,y,z`

## Build

```bash
npx @voicethere/agent build --entry templates/world-sync-binary/agent.ts --outfile dist/agent.js
```

## Sources

- `agent.ts` — `onDataChannelBinary` + `sendBinaryToClient`
- `protocol.ts` — encode/decode helpers (unit tested)
