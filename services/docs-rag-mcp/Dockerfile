# Base image for docs-rag-mcp. glibc (slim), not alpine: onnxruntime-node ships
# glibc binaries only. Extend it with your docs, see examples/Dockerfile.customer.
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Install without scripts, then run the one install script that matters:
# onnxruntime-node (approved in package.json "allowScripts"). better-sqlite3
# ships prebuilt binaries and must not fall back to node-gyp.
RUN npm ci --omit=dev --ignore-scripts && npm rebuild onnxruntime-node
# Fail the build if a native binary is missing or does not load on this platform.
RUN set -eu; \
    arch="$(node -p 'process.arch')"; \
    test -f "node_modules/onnxruntime-node/bin/napi-v6/linux/${arch}/onnxruntime_binding.node"; \
    test -f "node_modules/better-sqlite3/prebuilds/linux-${arch}.node"; \
    node --input-type=module -e "import Database from 'better-sqlite3'; import * as v from 'sqlite-vec'; const d = new Database(':memory:'); v.load(d); d.prepare('select vec_version()').get();"

FROM node:26-slim AS model
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
ENV DOCS_RAG_MODEL_DIR=/model
RUN node src/download-model.ts
RUN set -eu; \
    for f in config.json tokenizer.json tokenizer_config.json onnx/model_quantized.onnx; do \
      test -f "/model/Xenova/bge-small-en-v1.5/$f"; \
    done

FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 INDEX_DIR=/index DOCS_RAG_MODEL_DIR=/model
COPY --from=deps /app/node_modules ./node_modules
COPY --from=model /model /model
COPY package.json ./
COPY src ./src
RUN set -eu; \
    printf '#!/bin/sh\nexec node /app/src/cli.ts "$@"\n' > /usr/local/bin/docs-rag; \
    chmod 755 /usr/local/bin/docs-rag; \
    test -f /model/Xenova/bge-small-en-v1.5/onnx/model_quantized.onnx; \
    mkdir -p /index; chown node:node /index
USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
