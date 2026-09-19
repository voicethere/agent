# recording-consent

Conversation recording consent on connect. Pauses capture while collecting name and date of birth, then resumes only if the customer consented.

## Build

```bash
npx @voicethere/agent build --entry templates/recording-consent/agent.ts --outfile dist/agent.js
```

## Sources

- `agent.ts`, `conversation.ts`
