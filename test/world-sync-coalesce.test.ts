/**
 * world-sync / world-sync-binary send one broadcast per tick, not one per pose
 * (plan 2026-11-20-sync-template-efficiency, chunk 4). Before the fix 30 poses
 * made 30 broadcasts (O(N^3) bytes).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodePoseBuffer } from "../templates/world-sync-binary/protocol.js";
import {
  agentMockFactory,
  loadPod,
  meterState,
  resetMeter,
} from "./helpers/sync-pods.js";

vi.mock("@voicethere/agent", (importOriginal) =>
  agentMockFactory(importOriginal as () => Promise<Record<string, unknown>>),
);

/** One 30 Hz broadcast interval (floor(1000 / 30)). */
const ONE_TICK_MS = 33;
const PEERS = 30;

describe("world-sync coalesces poses per tick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMeter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("world-sync: 30 poses inside one tick produce 1 broadcast", async () => {
    const pod = await loadPod(
      () => import("../templates/world-sync/agent.js"),
      () => vi.resetModules(),
    );
    const ids = Array.from({ length: PEERS }, (_, i) => `ws-${i}`);
    for (const sessionId of ids) {
      await pod.onClientJoin?.({ sessionId } as never);
    }
    resetMeter();
    for (const [i, sessionId] of ids.entries()) {
      await pod.onDataChannelMessage?.({
        sessionId,
        message: { type: "pose", x: i, y: 1, z: 2 },
      } as never);
    }
    await vi.advanceTimersByTimeAsync(ONE_TICK_MS);
    expect(meterState().broadcasts).toBe(1);
  });

  it("world-sync-binary: 30 poses inside one tick produce 1 broadcast", async () => {
    const pod = await loadPod(
      () => import("../templates/world-sync-binary/agent.js"),
      () => vi.resetModules(),
    );
    const ids = Array.from({ length: PEERS }, (_, i) => `wsb-${i}`);
    for (const sessionId of ids) {
      await pod.onClientJoin?.({ sessionId } as never);
    }
    resetMeter();
    for (const [i, sessionId] of ids.entries()) {
      await pod.onDataChannelBinary?.({
        sessionId,
        rawBinary: Buffer.from(encodePoseBuffer({ x: i, y: 1, z: 2 })),
      } as never);
    }
    await vi.advanceTimersByTimeAsync(ONE_TICK_MS);
    expect(meterState().broadcasts).toBe(1);
  });

  for (const [label, importer, send] of [
    ["world-sync", () => import("../templates/world-sync/agent.js"), "json"],
    [
      "world-sync-binary",
      () => import("../templates/world-sync-binary/agent.js"),
      "binary",
    ],
  ] as const) {
    const load = () => loadPod(importer, () => vi.resetModules());
    const pose = (
      pod: Awaited<ReturnType<typeof load>>,
      sessionId: string,
      i: number,
    ) =>
      send === "json"
        ? pod.onDataChannelMessage?.({
            sessionId,
            message: { type: "pose", x: i, y: 1, z: 2 },
          } as never)
        : pod.onDataChannelBinary?.({
            sessionId,
            rawBinary: Buffer.from(encodePoseBuffer({ x: i, y: 1, z: 2 })),
          } as never);

    it(`${label}: no pose, no broadcast; a pose sends once per tick, then idles`, async () => {
      const pod = await load();
      await pod.onClientJoin?.({ sessionId: "a" } as never);
      resetMeter();
      await vi.advanceTimersByTimeAsync(ONE_TICK_MS * 5);
      expect(meterState().broadcasts).toBe(0);
      await pose(pod, "a", 1);
      await vi.advanceTimersByTimeAsync(ONE_TICK_MS * 5);
      expect(meterState().broadcasts).toBe(1);
    });

    it(`${label}: join and leave broadcast at once`, async () => {
      const pod = await load();
      resetMeter();
      await pod.onClientJoin?.({ sessionId: "a" } as never);
      await pod.onClientJoin?.({ sessionId: "b" } as never);
      expect(meterState().broadcasts).toBe(2);
      await pod.onClientLeave?.({ sessionId: "a" } as never);
      expect(meterState().broadcasts).toBe(3);
    });

    it(`${label}: the tick timer is cleared when the last peer leaves`, async () => {
      const pod = await load();
      await pod.onClientJoin?.({ sessionId: "a" } as never);
      await pod.onClientJoin?.({ sessionId: "b" } as never);
      expect(vi.getTimerCount()).toBe(1);
      await pod.onClientLeave?.({ sessionId: "a" } as never);
      expect(vi.getTimerCount()).toBe(1);
      await pose(pod, "b", 3);
      await pod.onClientLeave?.({ sessionId: "b" } as never);
      expect(vi.getTimerCount()).toBe(0);
      resetMeter();
      await vi.advanceTimersByTimeAsync(ONE_TICK_MS * 5);
      expect(meterState().broadcasts).toBe(0);
    });
  }
});
