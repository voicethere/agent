# webhooks-redis

Same HMAC verify path as `webhooks`, plus an atomic Redis counter (`AGENT_REDIS_URL`) before DataChannel fan-out.

## Build

```bash
npx @voicethere/agent build --entry templates/webhooks-redis/agent.ts --outfile dist/agent.js
```

## Sources

- `agent.ts`
