# llm-mcp-service

The `llm-agent` template wired to a project service that speaks MCP. The agent lists the service's tools at `/mcp` (`toolSources: [{ "kind": "service", "path": "/mcp" }]` in `voicethere.llm.json`) and the model can call them. Source: `templates/llm-mcp-service/agent.ts`.

## Run the example MCP service

The public image `ghcr.io/voicethere/mcp-example-service` is a small MCP server with two tools, `get_plan_price` (sample prices, not real ones) and `get_server_time`. In the dashboard, open **Services** and set:

- Image: `ghcr.io/voicethere/mcp-example-service:<version>` (use a release tag, or `latest`)
- Port: `8080`, HTTP health check path `/healthz`

Redeploy the project. The agent connects to `/mcp` on the service with the project's service token and discovers both tools; the agent log shows an `llm tools discovered` line.

To use your own server, replace the image with one that serves MCP over streamable HTTP at `/mcp` and answers `GET /healthz`. The platform checks the service token before a request reaches your service and does not pass it on, so your server needs no token handling when it runs as a project service. The example image reads an optional `MCP_TOKEN` and then requires `Authorization: Bearer <MCP_TOKEN>`; use that only when you run the server outside a project service.

## External MCP server

To use a server you do not host as a project service, add an `mcp` entry to `toolSources` in `voicethere.llm.json`:

```json
{
  "kind": "mcp",
  "name": "docs",
  "url": "https://mcp.example.com/mcp",
  "auth": { "type": "bearer", "secret": "AGENT_MCP_TOKEN" }
}
```

Create the project secret `AGENT_MCP_TOKEN` first. `auth` can also be `{ "type": "none" }` or `{ "type": "headers", "headers": { "X-Api-Key": "AGENT_MCP_KEY" } }`, where each value names a project secret. `allow` and `deny` lists narrow which tools the model sees. You can keep the `service` entry and add external servers next to it.

The rest of this file is the `llm-agent` README, which applies here too.

## Files

- `agent.ts` wires the pieces together. You rarely need to change it.
- `voicethere.llm.json` holds the provider, model, greeting, barge-in, history and tool settings. The dashboard LLM tab edits this file.
- `prompt.md` is the system prompt. The dashboard LLM tab edits this file too.
- `tools.ts` lists your own tools. It ships with `get_current_time`.
- `hooks.ts` is where you adjust a turn in code. It is empty by default.
- `knowledge/about.md` is a sample document for retrieval (off by default).
- `md.d.ts` lets TypeScript accept `import prompt from "./prompt.md"`.

## Set the API key

The template starts on OpenRouter with the model `amazon/nova-micro-v1`. Create a key at openrouter.ai, add it as a project secret named `AGENT_OPENROUTER_API_KEY`, then deploy. For production, pick the model from OpenRouter's list yourself, checking cost, latency and tool support. The key is read by name from `apiKeySecret` in `voicethere.llm.json`; it is never stored in the file. Only project secrets whose names start with `AGENT_` reach the agent.

## Filler phrases

The `fillers` block in `voicethere.llm.json` lists short sentences the agent speaks while the caller waits. Each situation has its own phrases; leave a situation out, or give it an empty list, to turn it off. The whole block is off when absent.

```json
"fillers": {
  "thinking": { "phrases": ["Okay.", "Right.", "Sure.", "Let me see."], "afterMs": 1500 },
  "toolCall": { "phrases": ["Let me check that for you.", "One moment, I'll look that up."] },
  "toolWait": { "phrases": ["Still checking, one moment.", "Almost there."], "afterMs": 4000 },
  "interruptible": true
}
```

- `thinking`: no sentence of the reply was spoken `afterMs` (300 to 10000, default 1500) after the model call started. Phrases up to 60 characters. Once per turn.
- `toolCall`: the model asked for a tool and nothing has been spoken in this turn yet (no reply sentence, and no `thinking` filler in the last 2 seconds). It is spoken at once, before the tool runs. Phrases up to 120 characters. Once per turn.
- `toolWait`: a tool round is still running `afterMs` (1000 to 30000, default 4000) after it started. Once per tool round, twice per turn.
- At most 3 fillers per turn. Two fillers never play back to back unless the reply spoke in between or `afterMs` passed. Phrases are picked at random and never repeat the previous filler of the session. Each list takes up to 20 phrases.
- Callers can cut a filler by speaking (`interruptible`, default true). If the answer arrives while a filler plays, the answer follows it.
- Fillers are speech only. They do not appear in the conversation the model sees or in chat text.
- `tools.filler` (a single text) is deprecated. It still works when `toolCall` and `toolWait` have no phrases; otherwise `fillers` wins and a warning is logged.

## Speech coalescing

`speech.coalesceMs` (0 to 1000, default 150) sets how long the agent holds a finished sentence to join it with the next one. Sentences that complete within the window are spoken as one utterance, so a reply the model returns at once has no gap between its sentences. The buffer is also spoken when the stream ends, at 400 characters, or when a tool call starts. Chat `assistant_delta` messages are not delayed. `0` speaks every sentence on its own.

## Prompt guidance for phone calls

The template prompt ends with a "Voice call" section. In your own agent you can append the same text with `CALL_AGENT_PROMPT_GUIDANCE` from `@voicethere/agent/llm`:

```ts
import { CALL_AGENT_PROMPT_GUIDANCE } from "@voicethere/agent/llm";

createLlmAgent({
  systemPrompt: `${prompt}\n\n${CALL_AGENT_PROMPT_GUIDANCE}` /* ... */,
});
```

It is never added automatically.

## Switch providers

Change `provider`, `model` and `apiKeySecret` in `voicethere.llm.json`. To go back to OpenAI, use `provider: "openai"`, `model: "gpt-4o-mini"` and `AGENT_OPENAI_API_KEY`; no import changes. Other options are `anthropic` with `AGENT_ANTHROPIC_API_KEY` and `gemini` with `AGENT_GEMINI_API_KEY`. Create the matching project secret before you deploy.

## Switching provider

Only the provider you import in `agent.ts` is bundled. When you change `provider` in `voicethere.llm.json`, also change the import and the `providers` list:

- `anthropic`: `import { anthropic } from "@voicethere/agent/llm/anthropic";` and `providers: [anthropic]`
- `gemini`: `import { gemini } from "@voicethere/agent/llm/gemini";` and `providers: [gemini]`
- `openrouter` uses the `openai` module.

If they do not match, `createLlmAgent` throws when the bundle loads, and the deploy check reports it.

## Knowledge (RAG)

The `knowledge` block in `voicethere.llm.json` ships with `"store": "off"`, so the template runs without Redis. Turning it on takes three steps:

1. Put your Markdown files in `knowledge/`, import each one in `agent.ts` and add it to the `documents` list. The agent splits every file by heading and indexes the pieces.
2. Set `"store": "redis"` and enable Project Redis for the project. Create the project secret `AGENT_OPENAI_API_KEY` for the embeddings (or change `knowledge.embeddings`; Anthropic has no embeddings API). The agent indexes in the background on start and skips files that did not change.
3. Redeploy. The model now has a `search_knowledge` tool and answers from the retrieved chunks.

For a large or changing data set use your own Supabase project instead: set `"store": "supabase"`, add a `supabase` block with `urlSecret` and `keySecret` (see the knowledge section of the package README for the SQL to run in your project), and fill the table yourself. Set `dimensions` to match your table. Chunk and query text never reach VoiceThere logs.

## Learn more

See the docs page `/docs/llm-agents` for the full list of settings, tools, MCP servers and hooks.
