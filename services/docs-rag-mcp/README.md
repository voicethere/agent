# docs-rag-mcp

Builds a read-only hybrid search index (vector + full-text) from your docs and searches it. Everything runs locally: no API key, no external call.

- Vector store: `vectors.db`, `sqlite-vec` `vec0` table (cosine).
- Text store: `text.db`, SQLite FTS5 (BM25) plus a `chunks` table.
- Embeddings: `Xenova/bge-small-en-v1.5` (quantized ONNX, 384 dims) through `@huggingface/transformers`. Queries get the model card's retrieval prefix, passages get none. The model is loaded from `DOCS_RAG_MODEL_DIR` with remote downloads disabled.
- Search: top 20 from each store, fused with weighted reciprocal rank fusion (k0 = 60, vector weight 1.0, text weight 0.5). The full-text query drops English stop words and ORs the rest. At most 2 chunks per document are returned. Overrides: `DOCS_RAG_VECTOR_WEIGHT`, `DOCS_RAG_TEXT_WEIGHT`, `DOCS_RAG_MAX_PER_DOC`, and the `--vector-weight`, `--text-weight`, `--max-per-doc` eval flags.

## Embedding

Pooling is mean, then L2 normalization; queries get the model card's retrieval prefix. The upstream BAAI card uses CLS pooling, so we compared both on the same indexes (the 40 platform questions are an indicative set, the sample set has 12). Mean stayed: CLS lowered hybrid recall@4 on the platform set and did not raise hybrid or vector MRR.

| Set           | Pooling | vector recall@4 / MRR | hybrid recall@4 / MRR |
| ------------- | ------- | --------------------- | --------------------- |
| platform docs | mean    | 0.925 / 0.820         | 0.925 / 0.767         |
| platform docs | cls     | 0.850 / 0.792         | 0.875 / 0.783         |
| sample        | mean    | 1.000 / 0.958         | 1.000 / 0.958         |
| sample        | cls     | 1.000 / 0.958         | 1.000 / 0.958         |

Pooling is fixed, not configurable: an index built with one pooling cannot be searched with the other.

## Inputs

A corpus JSON file, or a directory of `.md` files.

```json
{
  "documents": [
    {
      "id": "pricing",
      "title": "Pricing",
      "url": "https://example.com/pricing",
      "text": "# Pricing\n..."
    }
  ]
}
```

For a directory, `id` is the relative path, `title` is the first `#` heading (or the file name), and `--base-url` builds the page URL.

## Use

```bash
npm install
DOCS_RAG_MODEL_DIR=.models npm run download-model
DOCS_RAG_MODEL_DIR=.models node src/cli.ts build --docs fixtures/docs --out .index
DOCS_RAG_MODEL_DIR=.models node src/cli.ts eval --index .index --questions fixtures/questions.json --min-recall 0.9
```

`eval` reads `[{ "q": "...", "docId": "...", "fact": "..." }]`, prints recall@4 and MRR for vector, text and hybrid, and exits 1 when hybrid recall@4 is below `--min-recall`.

## Server

`src/server.ts` serves the index over MCP (streamable HTTP, stateless) on `PORT` (default 8080): `POST /mcp` and `GET /healthz`. `/healthz` answers 503 until the model and both databases are loaded, then 200. Without `INDEX_DIR/manifest.json` the process prints `DOCS_RAG_INDEX_MISSING` and exits 1.

| Tool          | Input                                                   | Result                                                                                              |
| ------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `search_docs` | `query` (1 to 500 characters), `k` (1 to 10, default 5) | Numbered hits `N. title — url (id: page)` followed by the passage, at most 4000 characters in total |
| `get_doc`     | `id` (the page id from a hit)                           | The page text, at most 12000 characters, or `not found`                                             |

Each call is bounded to 5 s. Log lines carry the tool, `k`, hit count and duration, never the query or passage text.

| Env                    | Default               | Meaning                                                                                                                                       |
| ---------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                 | `8080`                | Listen port                                                                                                                                   |
| `INDEX_DIR`            | `/index`              | Directory with `manifest.json`, `vectors.db`, `text.db`                                                                                       |
| `DOCS_RAG_MODEL_DIR`   | `/model` in the image | Embedding model directory                                                                                                                     |
| `MCP_TOKEN`            | unset                 | When set, `/mcp` needs `Authorization: Bearer <token>`. Leave it unset behind a project service: the platform checks the service token first. |
| `DOCS_RAG_TOOL_PREFIX` | empty                 | Prefix for both tool names, up to 32 letters, digits or underscores: `acme_` gives `acme_search_docs`                                         |
| `DOCS_RAG_DESCRIPTION` | generic text          | Description of the search tool, for example `Search the Acme docs`                                                                            |

## Image

The base image is `node:26-slim` (glibc), not alpine: `onnxruntime-node` ships glibc binaries only, and `sqlite-vec` and `better-sqlite3` have glibc prebuilds. It holds the dependencies, the model under `/model`, the `docs-rag` command on `PATH`, and runs the server as the non-root `node` user with `INDEX_DIR=/index`. The build fails when a native binary or a model file is missing. The base image alone has no index and refuses to start.

Extend it with your docs (`examples/Dockerfile.customer`):

```dockerfile
FROM ghcr.io/voicethere/docs-rag-mcp:latest
COPY docs/ /docs/
RUN docs-rag build --docs /docs --out /index
# optional gate: RUN docs-rag eval --index /index --questions /questions.json --min-recall 0.9
```

Run it as a project service: port `8080`, HTTP health check `/healthz`, and see the `llm-docs-rag` template.

Smoke test against a running server (lists the tools, calls both, prints p50 and p95 of N searches):

```bash
node scripts/smoke-mcp.ts --url http://127.0.0.1:8080/mcp --query "your question" --expect-doc pricing.md --searches 50
```

Measured on an image with a 66-page, 774-chunk corpus (linux/arm64): healthz after 0.4 s from `docker run`, memory about 260 MiB after 50 searches, search p50 7 ms and p95 11 ms.

## Test

```bash
DOCS_RAG_MODEL_DIR=.models npm run download-model
npm test
```

With Docker, build the base image and set `DOCS_RAG_BASE_IMAGE=<tag>` to also build the customer example from the sample docs, start it and query it.

## Licences

Licences are read from each package's `package.json` in `node_modules` and from the model card.

| Component                                                                                                                      | Version | Licence                                          |
| ------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------ |
| `BAAI/bge-small-en-v1.5` (original model; `Xenova/bge-small-en-v1.5` is its ONNX conversion and its card has no licence field) | n/a     | MIT (BAAI model card)                            |
| `@huggingface/transformers`                                                                                                    | 4.3.2   | Apache-2.0                                       |
| `better-sqlite3`                                                                                                               | 13.0.3  | MIT                                              |
| `sqlite-vec`                                                                                                                   | 0.1.9   | MIT OR Apache (as written in its `package.json`) |
| `onnxruntime-node` (transitive)                                                                                                | 1.30.0  | MIT                                              |
