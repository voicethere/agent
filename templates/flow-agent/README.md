# flow-agent

A scripted voice and chat conversation built from nodes: speak, listen, route by example sentences, call an API or an MCP tool, ask an LLM, branch on variables, end. Source: `templates/flow-agent/agent.ts`.

## Files

- `agent.ts` wires the flow to the agent runtime. You rarely need to change it.
- `voicethere.flow.json` is the conversation. The dashboard Flow tab edits this file; you can edit it by hand too.
- `voicethere.flow.mocks.json` holds mock answers for `route`, `llm`, `http` and `mcp` nodes. It is for local runs only, and the deployed agent never reads it.
- `tools.ts` lists your own tools for `llm` nodes. It is empty by default.

## Set the API key

The flow starts on OpenRouter with the model `anthropic/claude-haiku-5.5`, which supports the forced tool call the route classifier makes. Create a key at openrouter.ai, add it as a project secret named `AGENT_OPENROUTER_API_KEY`, then deploy. The key is read by name from `apiKeySecret` in `voicethere.flow.json`; it is never stored in the file. Only project secrets whose names start with `AGENT_` reach the agent.

To use another provider, change `provider`, `model` and `apiKeySecret` in the `models` block and import that provider's module in `agent.ts` (the comment there shows how).

## Test it locally

Check the flow file:

```bash
npx @voicethere/agent flow validate
```

Talk to it in the terminal with mock answers, so no key and no network are needed:

```bash
npx @voicethere/agent flow run --mock
```

Run it with real calls, reading keys from an env file you name:

```bash
npx @voicethere/agent flow run --env my-keys.env
```

Add `--record` to save the real HTTP, MCP and LLM answers as mock cases, `--trace out.json` to write the steps, and `--step` to pause before each node. `npx @voicethere/agent flow mock generate` fills the mocks file with generated data. Press Ctrl-C to stop a run: the recording and the trace collected so far are written first, then it exits with code 130. In `--step` mode, Ctrl-C exits without saving the trace or recording.
