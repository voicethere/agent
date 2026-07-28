/**
 * Per-session FIFO task chain. Different sessionIds run independently; the same
 * sessionId is processed strictly in enqueue order (no overlapping handlers).
 *
 * Task rejections are consumed at the queue tail so they do not surface as
 * process `unhandledRejection` events. Later same-session tasks still run
 * unless {@link clear} invalidated the generation.
 *
 * Lifecycle ordering:
 * 1. First `enqueue` creates a live map row (generation token).
 * 2. The row stays registered for the session lifetime — including when
 *    `pending === 0` between inbound handlers. Clients send continuously and
 *    agents fan out on timers; "no handler in flight" is not "session gone".
 * 3. `clear(sessionId)` aborts live work and removes the row (session_end).
 * 4. Old task `finally` only mutates the captured state object; it never
 *    deletes a newer generation's map entry.
 * 5. No per-session tombstone map — callers must `clear` ended sessions so
 *    unique-ID churn leaves no residue.
 */

export class SessionSerialQueueCancellationError extends Error {
  readonly code = "SESSION_SERIAL_QUEUE_CANCELLED" as const;

  constructor(
    readonly sessionId: string,
    readonly generation: number,
  ) {
    super(
      `session serial queue cancelled (sessionId=${sessionId}, generation=${generation})`,
    );
    this.name = "SessionSerialQueueCancellationError";
  }
}

/** Context for generation-aware tasks (second enqueue argument; optional). */
export type SessionSerialTaskContext = {
  sessionId: string;
  generation: number;
  signal: AbortSignal;
};

/**
 * Tasks may observe AbortSignal (compat first arg) and optional context.
 * Zero-arg / signal-only callbacks remain supported.
 */
export type SessionSerialTask = (
  signal: AbortSignal,
  context: SessionSerialTaskContext,
) => void | Promise<void>;

type SessionQueueState = {
  readonly generation: number;
  tail: Promise<unknown>;
  abort: AbortController | null;
  pending: number;
};

export class SessionSerialQueue {
  private readonly sessions = new Map<string, SessionQueueState>();
  /** Monotonic token source — never reused across clear/enqueue cycles. */
  private nextGeneration = 1;

  /**
   * Enqueue work for `sessionId`. Returns a promise that settles when this
   * task finishes, is skipped as stale, or is cancelled by {@link clear}.
   * Fire-and-forget callers may ignore the return value (compat).
   */
  enqueue(
    sessionId: string,
    task:
      | SessionSerialTask
      | ((signal: AbortSignal) => void | Promise<void>)
      | (() => void | Promise<void>),
  ): Promise<"completed" | "cancelled" | "failed"> {
    const state = this.ensureState(sessionId);
    const captured = state;
    const generation = captured.generation;
    captured.pending += 1;
    const previous = captured.tail;

    let taskAbort: AbortController | null = null;

    const settled: Promise<"completed" | "cancelled" | "failed"> = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.sessions.get(sessionId) !== captured) {
          return "cancelled" as const;
        }

        const abort = new AbortController();
        taskAbort = abort;
        captured.abort = abort;

        const context: SessionSerialTaskContext = {
          sessionId,
          generation,
          signal: abort.signal,
        };

        try {
          await Promise.resolve(
            (task as SessionSerialTask)(abort.signal, context),
          );
          if (this.sessions.get(sessionId) !== captured) {
            return "cancelled" as const;
          }
          return "completed" as const;
        } catch (error) {
          if (
            abort.signal.aborted ||
            this.sessions.get(sessionId) !== captured ||
            error instanceof SessionSerialQueueCancellationError
          ) {
            return "cancelled" as const;
          }
          return "failed" as const;
        } finally {
          if (captured.abort === abort) {
            captured.abort = null;
          }
        }
      })
      .finally(() => {
        // Only the captured state identity may be mutated by this task.
        // Do not delete the map row when pending hits 0 — the session stays
        // live until {@link clear} (session_end). Idle-delete broke timer
        // fan-out / isLive for still-connected sessions.
        captured.pending = Math.max(0, captured.pending - 1);
        if (taskAbort && captured.abort === taskAbort) {
          captured.abort = null;
        }
      });

    captured.tail = settled;
    return settled;
  }

  /**
   * Invalidate queued + running work for `sessionId`. Aborts the live AbortSignal,
   * drops the map entry, and leaves a fresh identity for the next enqueue.
   * Old in-flight `finally` blocks only touch their captured state object.
   */
  clear(sessionId: string): void {
    const old = this.sessions.get(sessionId);
    if (!old) return;
    old.abort?.abort();
    old.abort = null;
    // Remove live identity — do not mutate old.generation / splice into old row.
    this.sessions.delete(sessionId);
  }

  clearAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.clear(sessionId);
    }
  }

  hasPending(sessionId: string): boolean {
    return (this.sessions.get(sessionId)?.pending ?? 0) > 0;
  }

  /** Live generation token for a session, or `undefined` when cleared. */
  generationOf(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.generation;
  }

  /** True when `generation` is the live map entry for `sessionId`. */
  isCurrentGeneration(sessionId: string, generation: number): boolean {
    return this.sessions.get(sessionId)?.generation === generation;
  }

  /**
   * True when a queue row exists for the session (registered since first
   * enqueue, until {@link clear}). Not the same as {@link hasPending}.
   */
  isLive(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Registered session rows (must not grow without matching `clear` calls). */
  get activeSessionCount(): number {
    return this.sessions.size;
  }

  private ensureState(sessionId: string): SessionQueueState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const created: SessionQueueState = {
      generation: this.nextGeneration++,
      tail: Promise.resolve(),
      abort: null,
      pending: 0,
    };
    this.sessions.set(sessionId, created);
    return created;
  }
}
