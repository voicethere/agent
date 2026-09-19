# webhooks

Inbound HTTP webhook sample — verifies `x-agent-webhook-signature` HMAC on the raw body, then fans out to connected sessions via DataChannel + `speak`.

## Build

```bash
npx @voicethere/agent build --entry templates/webhooks/agent.ts --outfile dist/agent.js
```

## Sources

- `agent.ts`
