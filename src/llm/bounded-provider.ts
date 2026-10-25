import { LlmProviderError } from "./types.js";
import type { LlmProvider, LlmRequest, LlmStreamEvent } from "./types.js";

export interface StreamBounds {
  firstTokenTimeoutMs?: number;
  totalTimeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

/** Maps an SDK error to a coded error. Reads `status` only, never the body. */
export function toLlmError(err: unknown, providerId: string): LlmProviderError {
  if (err instanceof LlmProviderError) return err;
  const raw = (err as { status?: unknown } | null)?.status;
  const status = typeof raw === "number" ? raw : undefined;
  const message = `${providerId} ${status ?? "network error"}`;
  if (status === 401 || status === 403) {
    return new LlmProviderError("LLM_AUTH_FAILED", message, status);
  }
  if (status === 429) {
    return new LlmProviderError("LLM_RATE_LIMITED", message, status);
  }
  if (status === 400 || status === 404 || status === 422) {
    return new LlmProviderError("LLM_BAD_REQUEST", message, status);
  }
  return new LlmProviderError("LLM_PROVIDER_ERROR", message, status);
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
