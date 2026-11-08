# llm-language-tutor

An English practice partner for learners at levels A2 to B2. It talks in short turns, corrects one mistake per turn, asks a follow-up question, and looks up phrases and idioms in a lessons file through `search_knowledge`. Source: `templates/llm-language-tutor/agent.ts`.

## What you need

- **Project Redis** turned on for the project. The agent indexes `knowledge/lessons.md` in Redis when it starts and skips the work when the file has not changed.
- A project secret named `AGENT_OPENROUTER_API_KEY` (a key from openrouter.ai). The same key serves the chat model and the embeddings, so `knowledge.embeddings` has no `apiKeySecret`.

Without Project Redis or the key the agent still answers, but `search_knowledge` is off.

## Files

- `agent.ts` wires the pieces together.
- `voicethere.llm.json` holds the model (`amazon/nova-micro-v1` on OpenRouter), greeting and the `knowledge` block (`store: "redis"`, `topK: 3`, namespace `tutor`).
- `prompt.md` is the tutor's system prompt.
- `knowledge/lessons.md` has eight lessons as `##` headings, each with useful phrases and two idioms. Each heading starts a retrievable chunk.
- `md.d.ts` lets TypeScript accept `import x from "./x.md"`.

## Embeddings model

The template uses `openai/text-embedding-3-small`. OpenRouter's embeddings guide names it (https://openrouter.ai/docs/api/reference/embeddings) and its embeddings request reference uses it as the `model` example (https://openrouter.ai/docs/api-reference/embeddings/create-embeddings). That reference documents `dimensions` as a request field (the number of dimensions of the output embeddings) but does not list which models accept it. `knowledge.embeddings.dimensions` is not set in `voicethere.llm.json`, so the agent uses its default of 512 and sends `dimensions: 512` with every embeddings request. Set the field to another value between 64 and 3072 to change it.

## Edit the lessons

Replace or add `##` sections in `knowledge/lessons.md`. A lesson is easiest to find when its heading names the topic and its phrases are written as the learner would ask about them. Redeploy; the index rebuilds because the file hash changes.

To teach another language, change `prompt.md` and the project's voice language (see `/docs/spoken-language` in the VoiceThere docs), then write the lessons in that language.

## Cost

Measured on VoiceThere's demo: see the use-case page.
