# llm-docs-rag

An LLM agent that answers questions about your own documentation. The docs live in a project service that runs the `docs-rag-mcp` image: a read-only index with vector search and full-text search, baked into the image next to a small embedding model. The agent lists the service's tools at `/mcp` (`toolSources: [{ "kind": "service", "path": "/mcp", "allow": ["search_docs", "get_doc"] }]` in `voicethere.llm.json`), and the prompt tells the model to call `search_docs` before it states any product fact and to name the page URL. Retrieval inside the agent (`knowledge`) stays off. Source: `templates/llm-docs-rag/agent.ts`.

Search runs in the service. No API key, no outside call and no runtime write: the index is built when you build the image.

## Build your docs image

1. Put your Markdown files in a `docs/` folder. The page id is the file path, the title is the first `#` heading.
2. Copy `Dockerfile.customer` from the `services/docs-rag-mcp/examples` folder of the `@voicethere/agent` repository next to `docs/`, then build and push it:

```bash
docker build -f Dockerfile.customer \
  --build-arg BASE=ghcr.io/voicethere/docs-rag-mcp:<version> \
  --build-arg BASE_URL=https://docs.example.com/ \
  -t registry.example.com/acme/docs-mcp:1 .
docker push registry.example.com/acme/docs-mcp:1
```

`BASE_URL` is optional. With it, each page gets a URL (`BASE_URL` plus the file path without `.md`), and the agent can read it out. Use a release tag of the base image, or `latest`.

To get a corpus from rendered pages instead of Markdown files, pass a JSON file with `docs-rag build --corpus corpus.json --out /index`; the format is in the service README.

## Set the project service

In the dashboard, open **Services** and set:

- Image: the one you pushed. A public image needs no registry credential.
- Port: `8080`, HTTP health check path `/healthz`
- CPU 500 m and memory 1024 MiB are a safe start; the service takes about 260 MiB after the first searches. Choose "always on" so the first caller does not wait for a cold start.

Redeploy the project. The agent connects to `/mcp` on the service with the project's service token and discovers `search_docs` and `get_doc`; the agent log shows an `llm tools discovered` line.

## Make it yours

- Tool names and the search tool's description are set with environment variables on the image: `DOCS_RAG_TOOL_PREFIX` (for example `acme_`, which gives `acme_search_docs` and `acme_get_doc`; update `allow` and the prompt to match) and `DOCS_RAG_DESCRIPTION` (for example `Search the Acme docs`).
- Edit `prompt.md` for tone and scope. Keep the rule that the model searches before it states a fact.
- Set the provider, model and API key as in the `llm-agent` template: the template starts on OpenRouter with `amazon/nova-micro-v1`, key `AGENT_OPENROUTER_API_KEY` (a project secret).

## Files

- `agent.ts` wires the pieces together. You rarely need to change it.
- `voicethere.llm.json` holds the provider, model, greeting, barge-in, history and tool settings. The dashboard LLM tab edits this file.
- `prompt.md` is the system prompt.
- `tools.ts` lists your own tools. It is empty: the docs tools come from the service.
- `hooks.ts` is where you adjust a turn in code. It is empty by default.
- `md.d.ts` lets TypeScript accept `import prompt from "./prompt.md"`.

See the docs page `/docs/llm-agents` for the full list of settings.
