import { describe, expect, it, vi } from "vitest";

import {
  SessionSerialQueue,
  SessionSerialQueueCancellationError,
} from "../src/session-serial-queue.js";

describe("SessionSerialQueue", () => {
  it("serializes tasks for the same session", async () => {
    const queue = new SessionSerialQueue();
    const order: string[] = [];

    queue.enqueue("s1", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("a");
    });
    queue.enqueue("s1", async () => {
      order.push("b");
    });

    await vi.waitFor(() => expect(order).toEqual(["a", "b"]));
  });

  it("runs different sessions concurrently", async () => {
    const queue = new SessionSerialQueue();
    const order: string[] = [];

    queue.enqueue("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("slow");
    });
    queue.enqueue("fast", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("fast");
    });

    await vi.waitFor(() => expect(order).toEqual(["fast", "slow"]));
  });

  it("reports pending state", async () => {
    const queue = new SessionSerialQueue();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    queue.enqueue("s1", () => gate);
    expect(queue.hasPending("s1")).toBe(true);
    release();

    await vi.waitFor(() => expect(queue.hasPending("s1")).toBe(false));
  });

  it("contains rejected tasks without process unhandledRejection", async () => {
    const queue = new SessionSerialQueue();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      queue.enqueue("s1", async () => {
        throw new Error("task fail");
      });

      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      expect(queue.hasPending("s1")).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("clears pending state and runs later same-session tasks after a rejection", async () => {
    const queue = new SessionSerialQueue();
    const order: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      queue.enqueue("s1", async () => {
        order.push("fail");
        throw new Error("boom");
      });
      queue.enqueue("s1", async () => {
        order.push("next");
      });

      await vi.waitFor(() => expect(order).toEqual(["fail", "next"]));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      expect(queue.hasPending("s1")).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("generation clear cancels queued work and aborts running AbortSignal tasks", async () => {
    const queue = new SessionSerialQueue();
    const events: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = queue.enqueue("s1", async (signal: AbortSignal) => {
      events.push("start-1");
      await gate;
      if (signal.aborted) {
        events.push("aborted-1");
        throw new SessionSerialQueueCancellationError("s1", 0);
      }
      events.push("finish-1");
    });
    const second = queue.enqueue("s1", async () => {
      events.push("start-2");
    });

    await vi.waitFor(() => expect(events).toContain("start-1"));
    const genBefore = queue.generationOf("s1");
    expect(genBefore).toBeDefined();
    queue.clear("s1");
    expect(queue.generationOf("s1")).toBeUndefined();
    release();

    await expect(first).resolves.toBe("cancelled");
    await expect(second).resolves.toBe("cancelled");
    expect(events).not.toContain("start-2");
    expect(events).not.toContain("finish-1");
  });

  it("enqueue after clear belongs to a fresh generation token; old finally cannot delete it", async () => {
    const queue = new SessionSerialQueue();
    const emits: string[] = [];
    let finishOld: () => void = () => {};
    const oldGate = new Promise<void>((resolve) => {
      finishOld = resolve;
    });

    const old = queue.enqueue("reuse", async (_signal, ctx) => {
      await oldGate;
      if (!queue.isCurrentGeneration("reuse", ctx.generation)) {
        return;
      }
      emits.push("old");
    });
    const oldGen = queue.generationOf("reuse");

    queue.clear("reuse");
    const fresh = queue.enqueue("reuse", async (_signal, ctx) => {
      emits.push(`new:${ctx.generation}`);
    });
    const newGen = queue.generationOf("reuse");
    expect(newGen).toBeDefined();
    expect(newGen).not.toBe(oldGen);

    await expect(fresh).resolves.toBe("completed");
    expect(emits[0]?.startsWith("new:")).toBe(true);

    finishOld();
    await expect(old).resolves.toBe("cancelled");
    expect(emits).toHaveLength(1);
    // Fresh generation stays registered until clear (no idle-delete).
    expect(queue.isLive("reuse")).toBe(true);
    expect(queue.activeSessionCount).toBe(1);
    queue.clear("reuse");
    expect(queue.activeSessionCount).toBe(0);
  });

  it("keeps session registered while idle between handlers", async () => {
    const queue = new SessionSerialQueue();
    await queue.enqueue("s1", async () => undefined);
    expect(queue.hasPending("s1")).toBe(false);
    expect(queue.isLive("s1")).toBe(true);
    expect(queue.activeSessionCount).toBe(1);

    await queue.enqueue("s1", async () => undefined);
    expect(queue.isLive("s1")).toBe(true);
    expect(queue.generationOf("s1")).toBeDefined();

    queue.clear("s1");
    expect(queue.isLive("s1")).toBe(false);
    expect(queue.activeSessionCount).toBe(0);
  });

  it("unique session ID churn leaves no map residue", async () => {
    const queue = new SessionSerialQueue();
    for (let i = 0; i < 2000; i += 1) {
      const id = `unique-${i}`;
      await queue.enqueue(id, async () => undefined);
      queue.clear(id);
    }
    expect(queue.activeSessionCount).toBe(0);
  });

  it("stress: enqueue/clear/reuse loop leaves no map growth and does not stall", async () => {
    const queue = new SessionSerialQueue();
    const sessionId = "soak-reuse";

    for (let i = 0; i < 50; i += 1) {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = queue.enqueue(sessionId, async (_signal, ctx) => {
        await gate;
        if (!queue.isCurrentGeneration(sessionId, ctx.generation)) return;
      });
      queue.enqueue(sessionId, async () => {
        throw new Error("stale-queued");
      });
      queue.clear(sessionId);
      release();
      await expect(pending).resolves.toBe("cancelled");

      const next = queue.enqueue(sessionId, async () => undefined);
      await expect(next).resolves.toBe("completed");
    }

    await vi.waitFor(() => expect(queue.hasPending(sessionId)).toBe(false));
    // Last completed generation stays until explicit clear (session_end).
    expect(queue.isLive(sessionId)).toBe(true);
    expect(queue.activeSessionCount).toBe(1);
    queue.clear(sessionId);
    expect(queue.activeSessionCount).toBe(0);
  });

  it("errors do not stall the next generation", async () => {
    const queue = new SessionSerialQueue();
    const order: string[] = [];

    void queue.enqueue("s1", async () => {
      order.push("boom");
      throw new Error("gen0 fail");
    });
    await vi.waitFor(() => expect(order).toEqual(["boom"]));
    queue.clear("s1");

    await queue.enqueue("s1", async () => {
      order.push("gen1");
    });
    expect(order).toEqual(["boom", "gen1"]);
    expect(queue.hasPending("s1")).toBe(false);
  });

  it("passes generation context as the second enqueue argument", async () => {
    const queue = new SessionSerialQueue();
    let seen: number | undefined;
    await queue.enqueue("s1", async (signal, ctx) => {
      expect(signal).toBe(ctx.signal);
      seen = ctx.generation;
    });
    expect(typeof seen).toBe("number");
  });
});
