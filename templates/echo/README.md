# echo

Full echo debug agent for the VoiceThere dashboard. Speaks **you said: …** on voice finals and text chat, relays speech events over DataChannel, and echoes chat replies.

## Build

```bash
npx @voicethere/agent build --entry templates/echo/agent.ts --outfile dist/agent.js
```

## Sources

- `agent.ts`
