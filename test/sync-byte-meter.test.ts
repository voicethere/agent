/**
 * Byte meter for the data-sync templates (plan 2026-11-20-sync-template-efficiency, chunk 1; game-sync rows updated in chunk 3).
 *
 * Records what each template sends per session per second today, with the
 * template's own timers driven by fake time and no Redis (per-pod memory mode;
 * the outbound frame is the same size with project Redis). The numbers are the
 * baseline in development/webrtc-cloud/features/2026-11-20-sync-template-efficiency.md.
 * Later chunks replace these expectations with the new frame sizes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodePoseBuffer } from "../templates/world-sync-binary/protocol.js";
import {
  agentMockFactory,
  loadPod,
  resetMeter,
  summarizeMeter,
  type MeterSummary,
} from "./helpers/sync-pods.js";

vi.mock("@voicethere/agent", (importOriginal) =>
  agentMockFactory(importOriginal as () => Promise<Record<string, unknown>>),
);

const WINDOW_MS = 1000;

function report(label: string, summary: MeterSummary): void {
  console.info(
    `[sync-byte-meter] ${label}: sessions=${summary.sessions} frames=${summary.frames} ` +
      `frameBytes=${summary.frameBytes.join("/")} perSessionBps=${summary.perSessionBps.toFixed(0)} ` +
      `totalBps=${summary.totalBps.toFixed(0)}`,
  );
}

describe("sync template byte meter (baseline)", () => {
  beforeEach(() => {
    delete process.env.AGENT_REDIS_URL;
    vi.useFakeTimers();
    resetMeter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("redis-sync, 30 peers", async () => {
    const pod = await loadPod(
      () => import("../templates/redis-sync/agent.js"),
      () => vi.resetModules(),
    );
    await pod.onAgentStart?.({ env: {} } as never);
    for (let i = 0; i < 30; i += 1) {
      const sessionId = `rs-${i}`;
      await pod.onClientJoin?.({ sessionId } as never);
      const pose = Buffer.from(new Float32Array([i, i * 10, i * 5]).buffer);
      await pod.onDataChannelBinary?.({ sessionId, rawBinary: pose } as never);
    }
    resetMeter();
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    const summary = summarizeMeter(WINDOW_MS);
    report("redis-sync 30 peers", summary);
    expect(summary.sessions).toBe(30);
    // 30 new slots: one 4 + 30 x 6 B delta on the first tick, one keyframe of the same size on tick 20.
    expect(summary.frameBytes).toEqual([184]);
    expect(summary.frames).toBe(2 * 30);
    for (let i = 0; i < 30; i += 1) {
      await pod.onClientLeave?.({ sessionId: `rs-${i}` } as never);
    }
  });

  for (const objects of [1, 10, 25]) {
    it(`game-sync, ${objects} objects`, async () => {
      const pod = await loadPod(
        () => import("../templates/game-sync/agent.js"),
        () => vi.resetModules(),
      );
      await pod.onAgentStart?.({ env: {} } as never);
      const sessionId = `gs-${objects}`;
      await pod.onClientJoin?.({ sessionId } as never);
      for (let i = 0; i < objects; i += 1) {
        await pod.onDataChannelMessage?.({
          sessionId,
          message: { type: "register" },
        } as never);
      }
      resetMeter();
      await vi.advanceTimersByTimeAsync(WINDOW_MS);
      const summary = summarizeMeter(WINDOW_MS);
      report(`game-sync ${objects} objects`, summary);
      expect(summary.sessions).toBe(1);
      // 4 B header + 18 B per live object, 30 Hz (62 timer ticks, every 2nd sends).
      expect(summary.frameBytes).toEqual([4 + objects * 18]);
      expect(summary.frames).toBe(31);
      await pod.onClientLeave?.({ sessionId } as never);
      await vi.advanceTimersByTimeAsync(100);
    });
  }

  it("world-sync-binary, 30 peers at 20 Hz input", async () => {
    const pod = await loadPod(
      () => import("../templates/world-sync-binary/agent.js"),
      () => vi.resetModules(),
    );
    const sessionIds = Array.from({ length: 30 }, (_, i) => `wb-${i}`);
    for (const sessionId of sessionIds) {
      await pod.onClientJoin?.({ sessionId } as never);
    }
    resetMeter();
    for (let round = 0; round < 20; round += 1) {
      for (const [i, sessionId] of sessionIds.entries()) {
        const rawBinary = Buffer.from(
          encodePoseBuffer({ x: round, y: i, z: 1 }),
        );
        await pod.onDataChannelBinary?.({ sessionId, rawBinary } as never);
      }
      await vi.advanceTimersByTimeAsync(50);
    }
    const summary = summarizeMeter(WINDOW_MS);
    report("world-sync-binary 30 peers 20 Hz", summary);
    expect(summary.sessions).toBe(30);
    // One shared frame per dirty 33 ms tick, so per session min(input rate, 30 Hz):
    // 20 Hz input -> about 20 frames/s per session (was 600), never above 30.
    expect(summary.frames).toBeGreaterThanOrEqual(19 * 30);
    expect(summary.frames).toBeLessThanOrEqual(30 * 30);
    for (const sessionId of sessionIds) {
      await pod.onClientLeave?.({ sessionId } as never);
    }
  });
});
