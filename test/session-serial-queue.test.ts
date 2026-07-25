import { describe, expect, it, vi } from "vitest";

import { SessionSerialQueue } from "../src/session-serial-queue.js";

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
});
