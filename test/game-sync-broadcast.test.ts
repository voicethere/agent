/**
 * game-sync broadcast cadence, frame content and buffer reuse in per-pod memory mode
 * (plan 2026-11-20-sync-template-efficiency, chunk 3). Timers run on fake time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_LIVE_OBJECTS } from "../templates/game-sync/protocol.js";
import {
  collectActiveObjectIds,
  decodeLiveObjectsFrame,
  dequantizeObject,
  FRAME_HEADER_BYTES,
  FRAME_RECORD_BYTES,
} from "../templates/game-sync/world-layout.js";
import { SIM_HZ, BROADCAST_HZ } from "../templates/game-sync/sim.js";
import {
  agentMockFactory,
  loadPod,
  meterState,
  resetMeter,
  summarizeMeter,
} from "./helpers/sync-pods.js";

vi.mock("@voicethere/agent", (importOriginal) =>
  agentMockFactory(importOriginal as () => Promise<Record<string, unknown>>),
);

const sim = vi.hoisted(() => ({
  world: null as Float32Array | null,
  initial: null as Float32Array | null,
  steps: 0,
}));
vi.mock("../templates/game-sync/sim.js", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("../templates/game-sync/sim.js");
  return {
    ...actual,
    simulateWorldStep: (world: Float32Array, ...rest: unknown[]) => {
      sim.world = world;
      sim.initial ??= Float32Array.from(world);
      sim.steps += 1;
      return (actual.simulateWorldStep as (...a: unknown[]) => void)(
        world,
        ...rest,
      );
    },
  };
});

const SIM_INTERVAL_MS = Math.floor(1000 / SIM_HZ);

async function startPod(objects: number) {
  const pod = await loadPod(
    () => import("../templates/game-sync/agent.js"),
    () => vi.resetModules(),
  );
  await pod.onAgentStart?.({ env: {} } as never);
  await pod.onClientJoin?.({ sessionId: "bc" } as never);
  for (let i = 0; i < objects; i += 1) {
    await pod.onDataChannelMessage?.({
      sessionId: "bc",
      message: { type: "register" },
    } as never);
  }
  resetMeter();
  return pod;
}

function binaryFrames(): Buffer[] {
  return meterState()
    .sends.filter((send) => send.kind === "binary")
    .map((send) => send.copy!);
}

describe("game-sync 60 Hz sim, 30 Hz broadcast", () => {
  beforeEach(() => {
    delete process.env.AGENT_REDIS_URL;
    vi.useFakeTimers();
    sim.world = null;
    sim.initial = null;
    sim.steps = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs at 60 Hz and 30 Hz", () => {
    expect(SIM_HZ).toBe(60);
    expect(BROADCAST_HZ).toBe(30);
  });

  it("broadcasts on every 2nd sim tick, not on the others", async () => {
    const pod = await startPod(3);
    for (let tick = 1; tick <= 10; tick += 1) {
      await vi.advanceTimersByTimeAsync(SIM_INTERVAL_MS);
      expect(binaryFrames()).toHaveLength(Math.floor(tick / 2));
    }
    await pod.onClientLeave?.({ sessionId: "bc" } as never);
  });

  it("frame length is 4 + live x 18 B at about 30 frames a second", async () => {
    for (const live of [1, 10, 25]) {
      const pod = await startPod(live);
      await vi.advanceTimersByTimeAsync(1000);
      const summary = summarizeMeter(1000);
      expect(summary.frameBytes).toEqual([
        FRAME_HEADER_BYTES + live * FRAME_RECORD_BYTES,
      ]);
      // 62 timer ticks in 1 s at 16 ms, every 2nd one sends.
      expect(summary.frames).toBe(31);
      expect(live).toBeLessThanOrEqual(MAX_LIVE_OBJECTS);
      await pod.onClientLeave?.({ sessionId: "bc" } as never);
      await vi.advanceTimersByTimeAsync(100);
    }
  });

  it("keeps the world float32: 1000 sim steps equal an unquantized reference run", async () => {
    const actual = await vi.importActual<
      typeof import("../templates/game-sync/sim.js")
    >("../templates/game-sync/sim.js");
    const pod = await startPod(5);
    for (let tick = 0; tick < 1000; tick += 1) {
      await vi.advanceTimersByTimeAsync(SIM_INTERVAL_MS);
    }
    const live = sim.world!;
    expect(live).toBeInstanceOf(Float32Array);
    expect(sim.steps).toBe(1000);

    // Every in-memory step uses dt = 1/SIM_HZ (a 16 ms tick is clamped up to one sim interval).
    const reference = Float32Array.from(sim.initial!);
    const ids = Int32Array.from(collectActiveObjectIds(reference));
    for (let step = 0; step < 1000; step += 1) {
      actual.simulateWorldStep(reference, 1 / SIM_HZ, ids, ids.length);
    }
    expect(Array.from(live)).toEqual(Array.from(reference));

    // Only the broadcast copy is quantized: close to the float world, not equal to it.
    const objects = decodeLiveObjectsFrame(binaryFrames().at(-1)!);
    expect(objects).toHaveLength(5);
    const back = dequantizeObject(objects[0]!.q);
    expect(Math.abs(back[0]! - live[1]!)).toBeLessThan(0.02);
    await pod.onClientLeave?.({ sessionId: "bc" } as never);
  });

  it("allocates no new Buffer per tick after warm-up", async () => {
    const pod = await startPod(10);
    await vi.advanceTimersByTimeAsync(10 * SIM_INTERVAL_MS);
    const alloc = vi.spyOn(Buffer, "alloc");
    const allocUnsafe = vi.spyOn(Buffer, "allocUnsafe");
    const allocUnsafeSlow = vi.spyOn(Buffer, "allocUnsafeSlow");
    const from = vi.spyOn(Buffer, "from");
    await vi.advanceTimersByTimeAsync(40 * SIM_INTERVAL_MS);
    // The harness copies each outbound frame with Buffer.from; the template itself never allocates.
    expect(alloc).not.toHaveBeenCalled();
    expect(allocUnsafe).not.toHaveBeenCalled();
    expect(allocUnsafeSlow).not.toHaveBeenCalled();
    const frames = binaryFrames();
    expect(frames.length).toBeGreaterThan(0);
    from.mockRestore();
    alloc.mockRestore();
    allocUnsafe.mockRestore();
    allocUnsafeSlow.mockRestore();
    await pod.onClientLeave?.({ sessionId: "bc" } as never);
  });

  it("broadcast frames track the sim: dequantized x moves with velocity", async () => {
    const pod = await startPod(1);
    await vi.advanceTimersByTimeAsync(4 * SIM_INTERVAL_MS);
    const frames = binaryFrames();
    expect(frames.length).toBeGreaterThanOrEqual(2);
    const first = dequantizeObject(decodeLiveObjectsFrame(frames[0]!)[0]!.q);
    const second = dequantizeObject(decodeLiveObjectsFrame(frames[1]!)[0]!.q);
    const vx = first[4]!;
    const dt = 2 / SIM_HZ;
    expect(Math.abs(vx)).toBeGreaterThan(60);
    expect(second[0]! - first[0]!).toBeCloseTo(vx * dt, 0);
    await pod.onClientLeave?.({ sessionId: "bc" } as never);
  });
});
