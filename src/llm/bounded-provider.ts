import { LlmProviderError } from "./types.js";
import type { LlmProvider, LlmRequest, LlmStreamEvent } from "./types.js";

export interface StreamBounds {
  firstTokenTimeoutMs?: number;
  totalTimeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

/**
 * The provider's `error.code`, if any. The OpenAI SDK's `APIError` keeps the
 * parsed body `error` object on `.error`, both for an HTTP error and for an
 * error chunk inside a 200 stream (OpenRouter: Streaming › Handling errors
 * during streaming › Errors after the response is committed). Only `code` is
 * read: the vendor `message` can quote customer input, so it is never kept.
 */
function vendorCodeOf(err: unknown): string | number | undefined {
  const body = (err as { error?: unknown } | null)?.error;
  if (!body || typeof body !== "object") return undefined;
  const code = (body as { code?: unknown }).code;
  if (typeof code === "number" && Number.isFinite(code)) return code;
  if (typeof code === "string" && code.length > 0) return code.slice(0, 64);
  return undefined;
}

/** Maps an SDK error to a coded error. Reads `status` and `error.code` only, never the message or body. */
export function toLlmError(err: unknown, providerId: string): LlmProviderError {
  if (err instanceof LlmProviderError) return err;
  const raw = (err as { status?: unknown } | null)?.status;
  const status = typeof raw === "number" ? raw : undefined;
  const vendorCode = vendorCodeOf(err);
  // An error object with no HTTP status came from a streamed error chunk.
  const stream = status === undefined && vendorCode !== undefined;
  const detail = {
    ...(vendorCode !== undefined ? { vendorCode } : {}),
    ...(stream ? { stream } : {}),
  };
  const message = `${providerId} ${status ?? (stream ? "stream error" : "network error")}`;
  if (status === 401 || status === 403) {
    return new LlmProviderError("LLM_AUTH_FAILED", message, status, detail);
  }
  if (status === 429) {
    return new LlmProviderError("LLM_RATE_LIMITED", message, status, detail);
  }
  if (status === 400 || status === 404 || status === 422) {
    return new LlmProviderError("LLM_BAD_REQUEST", message, status, detail);
  }
  return new LlmProviderError("LLM_PROVIDER_ERROR", message, status, detail);
}

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

export function withStreamBounds(
  provider: LlmProvider,
  bounds: StreamBounds = {},
): LlmProvider {
  const firstTokenTimeoutMs = bounds.firstTokenTimeoutMs ?? 10_000;
  const totalTimeoutMs = bounds.totalTimeoutMs ?? 60_000;
  const retries = bounds.retries ?? 1;
  const retryDelayMs = bounds.retryDelayMs ?? 1000;

  async function* attempt(
    req: LlmRequest,
    yielded: { any: boolean },
  ): AsyncGenerator<LlmStreamEvent> {
    const ctl = new AbortController();
    let timedOut = false;
    const onCaller = () => ctl.abort();
    if (req.signal?.aborted) ctl.abort();
    req.signal?.addEventListener("abort", onCaller, { once: true });
    let firstTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => {
        timedOut = true;
        ctl.abort();
      },
      firstTokenTimeoutMs,
    );
    const totalTimer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, totalTimeoutMs);
    // Rejects when our controller aborts, so a provider that never responds
    // cannot hold the loop open.
    const aborted = new Promise<never>((_, reject) => {
      const fire = () =>
        reject(
          timedOut
            ? new LlmProviderError("LLM_TIMEOUT", `${provider.id} timed out`)
            : new LlmProviderError("LLM_ABORTED", `${provider.id} aborted`),
        );
      if (ctl.signal.aborted) fire();
      else ctl.signal.addEventListener("abort", fire, { once: true });
    });
    aborted.catch(() => {});
    const iter = provider
      .stream({ ...req, signal: ctl.signal })
      [Symbol.asyncIterator]();
    try {
      for (;;) {
        let r: IteratorResult<LlmStreamEvent>;
        try {
          r = await Promise.race([iter.next(), aborted]);
        } catch (err) {
          if (err instanceof LlmProviderError) throw err;
          if (req.signal?.aborted) {
            throw new LlmProviderError("LLM_ABORTED", `${provider.id} aborted`);
          }
          if (timedOut) {
            throw new LlmProviderError(
              "LLM_TIMEOUT",
              `${provider.id} timed out`,
            );
          }
          throw toLlmError(err, provider.id);
        }
        if (r.done) return;
        if (firstTimer) {
          clearTimeout(firstTimer);
          firstTimer = undefined;
        }
        yielded.any = true;
        yield r.value;
      }
    } finally {
      if (firstTimer) clearTimeout(firstTimer);
      clearTimeout(totalTimer);
      req.signal?.removeEventListener("abort", onCaller);
      ctl.abort();
      void iter.return?.(undefined)?.catch?.(() => {});
    }
  }

  return {
    id: provider.id,
    async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
      for (let n = 0; ; n++) {
        const yielded = { any: false };
        try {
          yield* attempt(req, yielded);
          return;
        } catch (err) {
          const e = toLlmError(err, provider.id);
          const retryable =
            e.code === "LLM_RATE_LIMITED" ||
            e.code === "LLM_PROVIDER_ERROR" ||
            e.code === "LLM_TIMEOUT";
          if (
            yielded.any ||
            !retryable ||
            n >= retries ||
            req.signal?.aborted
          ) {
            throw e;
          }
          await sleep(retryDelayMs, req.signal);
          if (req.signal?.aborted) {
            throw new LlmProviderError("LLM_ABORTED", `${provider.id} aborted`);
          }
        }
      }
    },
  };
}
