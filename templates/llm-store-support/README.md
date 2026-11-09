# llm-store-support

A phone support assistant for a fictional outdoor store, Kestrel Outdoor. It answers questions about shipping, returns, warranty, sizing, store hours and products from Markdown files through `search_knowledge`, and looks up every price with a tool on a project service. Source: `templates/llm-store-support/agent.ts`.

Prices never live in the knowledge files. The prompt tells the model to call `get_product_price` for any price and not to estimate one, so a price change happens in one place: the service.

## What you need

- **Project Redis** turned on. The agent indexes the files in `knowledge/` in Redis when it starts and skips the work when they have not changed.
- A project secret named `AGENT_OPENROUTER_API_KEY` (a key from openrouter.ai). The same key serves the chat model and the embeddings.
- A project service that runs the public image `ghcr.io/voicethere/mcp-example-service:<version>` (or `latest`), port `8080`, HTTP health check `/healthz`. It offers `list_products` and `get_product_price` over a sample Kestrel Outdoor catalog. The prices are sample data.

Without Redis or the key the agent still answers, but `search_knowledge` is off. Without the service it cannot give a price.

## Files

- `agent.ts` wires the pieces together.
- `voicethere.llm.json` holds the model (`amazon/nova-micro-v1` on OpenRouter), the greeting, `toolChoice: "required-first-round"`, the service tool source limited to `list_products` and `get_product_price`, and the `knowledge` block (`store: "redis"`, `topK: 3`, namespace `store-support`).
- `prompt.md` is the system prompt.
- `knowledge/` has one file per topic: `shipping.md`, `returns.md`, `warranty.md`, `sizing.md`, `store.md` and `products.md`. Each `##` heading starts a retrievable chunk.
- `md.d.ts` lets TypeScript accept `import x from "./x.md"`.

`toolChoice: "required-first-round"` makes every turn start with a tool call, so an answer comes from the knowledge or the price tool and not from the model's memory. A greeting such as "thanks" also triggers a call.

## Use your own store

1. Replace the files in `knowledge/` with your own policies, keeping `##` headings that name the topic, and update the imports in `agent.ts`.
2. Run your own MCP server as the project service. It needs to serve MCP over streamable HTTP at `/mcp` and answer `GET /healthz`, and its tools must match the names in `toolSources[].allow`. The source of the example server is in `services/mcp-example/` in the `@voicethere/agent` repository.
3. Edit `prompt.md` so the name, tone and rules fit your store.

## Embeddings model

The template uses `openai/text-embedding-3-small` through OpenRouter, with the agent's default of 512 dimensions. See the `llm-language-tutor` README for the details.

## Cost

Measured on VoiceThere's demo: see the use-case page.
