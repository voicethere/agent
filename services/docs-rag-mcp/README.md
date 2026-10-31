# docs-rag-mcp

Builds a read-only hybrid search index (vector + full-text) from your docs and searches it. Everything runs locally: no API key, no external call.

- Vector store: `vectors.db`, `sqlite-vec` `vec0` table (cosine).
- Text store: `text.db`, SQLite FTS5 (BM25) plus a `chunks` table.
- Embeddings: `Xenova/bge-small-en-v1.5` (quantized ONNX, 384 dims) through `@huggingface/transformers`. Queries get the model card's retrieval prefix, passages get none. The model is loaded from `DOCS_RAG_MODEL_DIR` with remote downloads disabled.
- Search: top 20 from each store, fused with reciprocal rank fusion (k0 = 60).

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

## Test

```bash
DOCS_RAG_MODEL_DIR=.models npm run download-model
npm test
```
