# spatial-showcase

Spatial audio showcase for `/showcase`. A `{ type: "join", demo }` DataChannel message selects `orbit`, `soundboard`, or `proximity`.

## Build

```bash
npx @voicethere/agent build --entry templates/spatial-showcase/agent.ts --outfile dist/agent.js
```

## Sources

- `agent.ts`, `protocol.ts`, `sounds.ts`, `room.ts`, `orbit.ts`, `orbit-session.ts`, `sine.ts`
