/**
 * world-sync / world-sync-binary send one broadcast per tick, not one per pose
 * (plan 2026-11-20-sync-template-efficiency, chunk 1 failing test; chunk 4 fixes).
 *
 * Skipped by default: fails on main (30 poses -> 30 broadcasts, O(N^3) bytes).
 * Run with SYNC_EFFICIENCY_BUG_TESTS=1 to see the failure; chunk 4 removes the gate.
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

const RUN_BUG_TESTS = process.env.SYNC_EFFICIENCY_BUG_TESTS === "1";
/** One 30 Hz broadcast interval (floor(1000 / 30)). */
const ONE_TICK_MS = 33;
const PEERS = 30;

describe.skipIf(!RUN_BUG_TESTS)(
  "world-sync coalesces poses per tick (skipped until chunk 4: fails on main)",
  () => {
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
  },
);
