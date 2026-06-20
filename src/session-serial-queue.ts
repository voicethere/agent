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
    const settled = next.finally(() => {
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
}
