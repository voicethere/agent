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
});
