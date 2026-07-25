/**
 * Per-session FIFO task chain. Different sessionIds run independently; the same
 * sessionId is processed strictly in enqueue order (no overlapping handlers).
 *
 * Task rejections are consumed at the queue tail so they do not surface as
 * process `unhandledRejection` events. Later same-session tasks still run.
 */
export class SessionSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue(sessionId: string, task: () => void | Promise<void>): void {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const settled = previous
      .catch(() => undefined)
      .then(() => Promise.resolve(task()))
      .catch(() => undefined)
      .finally(() => {
        if (this.tails.get(sessionId) === settled) {
          this.tails.delete(sessionId);
        }
      });
    this.tails.set(sessionId, settled);
  }

  clear(sessionId: string): void {
    this.tails.delete(sessionId);
  }

  clearAll(): void {
    this.tails.clear();
  }

  hasPending(sessionId: string): boolean {
    return this.tails.has(sessionId);
  }
}
