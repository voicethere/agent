import { toLlmError } from "./bounded-provider.js";
import { LlmProviderError } from "./types.js";
import type {
  EmbeddingsRequest,
  EmbeddingsResult,
  LlmEmbedder,
} from "./types.js";

export interface EmbedBounds {
  /** Per attempt. Default 15 000. */
  timeoutMs?: number;
  /** Extra attempts after the first. Default 2. */
  retries?: number;
  retryDelayMs?: number;
  /** Inputs per request. Default 96. */
  maxBatch?: number;
}

/** Documented embedding model ids: OpenAI embeddings guide, Google Gemini embeddings guide. */
export const DEFAULT_EMBEDDING_MODEL = {
  openai: "text-embedding-3-small",
  gemini: "gemini-embedding-001",
} as const;

export const DEFAULT_EMBEDDING_DIMS = 512;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

async function attemptOnce(
  inner: LlmEmbedder,
  req: EmbeddingsRequest,
  timeoutMs: number,
): Promise<EmbeddingsResult> {
  const ctl = new AbortController();
  let timedOut = false;
  const onCaller = () => ctl.abort();
  if (req.signal?.aborted) ctl.abort();
  req.signal?.addEventListener("abort", onCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  const fail = (): LlmProviderError =>
    timedOut && !req.signal?.aborted
      ? new LlmProviderError("LLM_TIMEOUT", `${inner.id} embeddings timed out`)
      : new LlmProviderError("LLM_ABORTED", `${inner.id} embeddings aborted`);
  // Rejects when our controller aborts, so an SDK that ignores the signal
  // cannot hold the call open.
  const aborted = new Promise<never>((_, reject) => {
    if (ctl.signal.aborted) reject(fail());
    else
      ctl.signal.addEventListener("abort", () => reject(fail()), {
        once: true,
      });
  });
  aborted.catch(() => {});
  try {
    return await Promise.race([
      inner.embed({ ...req, signal: ctl.signal }),
      aborted,
    ]);
  } catch (err) {
    if (err instanceof LlmProviderError) throw err;
    if (req.signal?.aborted || timedOut) throw fail();
    throw toLlmError(err, inner.id);
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onCaller);
    ctl.abort();
  }
}

function retryable(e: LlmProviderError): boolean {
  if (e.code === "LLM_RATE_LIMITED" || e.code === "LLM_TIMEOUT") return true;
  if (e.code === "LLM_PROVIDER_ERROR") {
    return e.status === undefined || e.status >= 500;
  }
  return false;
}

/**
 * Bounds an embedder: batches inputs, times out and retries each batch,
 * and checks the vectors. Error messages never contain input text.
 */
export function withEmbedBounds(
  inner: LlmEmbedder,
  bounds: EmbedBounds = {},
): LlmEmbedder {
  const timeoutMs = bounds.timeoutMs ?? 15_000;
  const retries = bounds.retries ?? 2;
  const retryDelayMs = bounds.retryDelayMs ?? 500;
  const maxBatch = Math.max(1, bounds.maxBatch ?? 96);

  async function batch(
    req: EmbeddingsRequest,
    inputs: string[],
  ): Promise<EmbeddingsResult> {
    for (let n = 0; ; n++) {
      let res: EmbeddingsResult;
      try {
        res = await attemptOnce(inner, { ...req, inputs }, timeoutMs);
      } catch (err) {
        const e = toLlmError(err, inner.id);
        if (!retryable(e) || n >= retries || req.signal?.aborted) throw e;
        await sleep(retryDelayMs, req.signal);
        if (req.signal?.aborted) {
          throw new LlmProviderError(
            "LLM_ABORTED",
            `${inner.id} embeddings aborted`,
          );
        }
        continue;
      }
      // A malformed 200 is not retried: another attempt would be billed again.
      if (res.vectors.length !== inputs.length) {
        throw new LlmProviderError(
          "LLM_PROVIDER_ERROR",
          `${inner.id} embedding count mismatch`,
        );
      }
      if (res.vectors.some((v) => v.length === 0)) {
        throw new LlmProviderError(
          "LLM_PROVIDER_ERROR",
          `${inner.id} embedding is empty`,
        );
      }
      return res;
    }
  }

  return {
    id: inner.id,
    async embed(req: EmbeddingsRequest): Promise<EmbeddingsResult> {
      const vectors: number[][] = [];
      let inputTokens: number | undefined;
      let model = req.model;
      for (let i = 0; i < req.inputs.length; i += maxBatch) {
        const res = await batch(req, req.inputs.slice(i, i + maxBatch));
        vectors.push(...res.vectors);
        model = res.model;
        if (res.inputTokens !== undefined) {
          inputTokens = (inputTokens ?? 0) + res.inputTokens;
        }
      }
      const dims = vectors[0]?.length ?? 0;
      if (
        vectors.some((v) => v.length !== dims) ||
        (req.dimensions !== undefined &&
          vectors.length > 0 &&
          dims !== req.dimensions)
      ) {
        throw new LlmProviderError(
          "LLM_PROVIDER_ERROR",
          `${inner.id} embedding dims mismatch`,
        );
      }
      for (const v of vectors) {
        let sum = 0;
        for (const x of v) sum += x * x;
        const norm = Math.sqrt(sum);
        if (!(norm > 0)) {
          throw new LlmProviderError(
            "LLM_PROVIDER_ERROR",
            `${inner.id} embedding is all zeros`,
          );
        }
        for (let i = 0; i < v.length; i++) v[i] /= norm;
      }
      return {
        vectors,
        model,
        dims,
        ...(inputTokens !== undefined ? { inputTokens } : {}),
      };
    },
  };
}
