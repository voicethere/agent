/**
 * Per-session FIFO task chain. Different sessionIds run independently; the same
 * sessionId is processed strictly in enqueue order (no overlapping handlers).
 */
export class SessionSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue(sessionId: string, task: () => void | Promise<void>): void {
    const previous =
      this.tails.get(sessionId)?.catch(() => undefined) ?? Promise.resolve();
    const next = previous.then(() => Promise.resolve(task()));
    this.tails.set(
      sessionId,
      next.finally(() => {
        if (this.tails.get(sessionId) === next) {
          this.tails.delete(sessionId);
        }
      }),
    );
  }

  clear(sessionId: string): void {
    this.tails.delete(sessionId);
  }

  clearAll(): void {
    this.tails.clear();
  }
}
