# llm-agent

A voice and chat agent powered by an LLM, with custom tools and MCP servers. Source: `templates/llm-agent/agent.ts`.

## Files

- `agent.ts` wires the pieces together. You rarely need to change it.
- `voicethere.llm.json` holds the provider, model, greeting, barge-in, history and tool settings. The dashboard LLM tab edits this file.
- `prompt.md` is the system prompt. The dashboard LLM tab edits this file too.
- `tools.ts` lists your own tools. It ships with `get_current_time`.
- `hooks.ts` is where you adjust a turn in code. It is empty by default.
- `md.d.ts` lets TypeScript accept `import prompt from "./prompt.md"`.

## Set the API key

The default provider is OpenAI. Add a project secret named `AGENT_OPENAI_API_KEY` with your key, then deploy. The key is read by name from `apiKeySecret` in `voicethere.llm.json`; it is never stored in the file. Only project secrets whose names start with `AGENT_` reach the agent.

## Switch providers

Change `provider`, `model` and `apiKeySecret` in `voicethere.llm.json`. For example, `anthropic` with `AGENT_ANTHROPIC_API_KEY`, `gemini` with `AGENT_GEMINI_API_KEY`, or `openrouter` with `AGENT_OPENROUTER_API_KEY`. Create the matching project secret before you deploy.

## Learn more

See the docs page `/docs/llm-agents` for the full list of settings, tools, MCP servers and hooks.
