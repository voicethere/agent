/**
 * redis-sync pod behaviour under fake time (plan 2026-11-20-sync-template-efficiency, chunk 2):
 * deltas, keyframes, join baseline, byte sizes, buffer reuse and the SETRANGE write path
 * against a fake ioredis. The fake keeps its own Map, so nothing shares a real Redis db.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { quantStep } from "../templates/redis-sync/quantize.js";
import {
  applyFrameToWorld,
  BOARD_MAX,
  BOARD_MIN,
  normalizeWorldBuffer,
  createEmptyWorldBuffer,
  decodeFrame,
  encodePositionInto,
  MAX_PEERS,
  readPeerSlot,
  REDIS_WORLD_KEY,
  SLOT_BYTES,
  WORLD_BYTE_LENGTH,
} from "../templates/redis-sync/world-layout.js";
import {
  agentMockFactory,
  loadPod,
  meterState,
  resetMeter,
} from "./helpers/sync-pods.js";

const fakeRedis = vi.hoisted(() => {
  const state = {
    store: new Map<string, Buffer>(),
    calls: [] as Array<{ cmd: string; args: unknown[] }>,
    getGate: null as Promise<void> | null,
  };
  class FakeRedis {
    async connect(): Promise<void> {}
    async getBuffer(key: string): Promise<Buffer | null> {
      state.calls.push({ cmd: "getBuffer", args: [key] });
      if (state.getGate) await state.getGate;
      const value = state.store.get(key);
      return value ? Buffer.from(value) : null;
    }
    async setrange(
      key: string,
      offset: number,
      value: Buffer,
    ): Promise<number> {
      state.calls.push({
        cmd: "setrange",
        args: [key, offset, Buffer.from(value)],
      });
      const prev = state.store.get(key) ?? Buffer.alloc(0);
      const next = Buffer.alloc(Math.max(prev.length, offset + value.length));
      prev.copy(next);
      value.copy(next, offset);
      state.store.set(key, next);
      return next.length;
    }
    async eval(): Promise<never> {
      state.calls.push({ cmd: "eval", args: [] });
      throw new Error("redis-sync must not use Lua");
    }
  }
  return { state, FakeRedis };
});

vi.mock("ioredis", () => ({ Redis: fakeRedis.FakeRedis }));
vi.mock("@voicethere/agent", (importOriginal) =>
  agentMockFactory(importOriginal as () => Promise<Record<string, unknown>>),
);

const TICK_MS = 50;

function pose(clientIndex: number, x: number, y: number): Buffer {
  const floats = encodePositionInto(new Float32Array(3), clientIndex, x, y);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

function framesFor(sessionId: string) {
  return meterState().sends.filter(
    (send) => send.sessionId === sessionId && send.kind === "binary",
  );
}

async function startPod(redisUrl?: string) {
  if (redisUrl) process.env.AGENT_REDIS_URL = redisUrl;
  else delete process.env.AGENT_REDIS_URL;
  fakeRedis.state.store.clear();
  fakeRedis.state.calls.length = 0;
  const pod = await loadPod(
    () => import("../templates/redis-sync/agent.js"),
    () => vi.resetModules(),
  );
  await pod.onAgentStart?.({ env: {} } as never);
  return pod;
}

describe.each([
  ["memory", undefined],
  ["redis", "redis://fake"],
])("redis-sync pod (%s mode)", (_label, redisUrl) => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMeter();
    fakeRedis.state.getGate = null;
  });
  afterEach(() => {
    vi.useRealTimers();
    fakeRedis.state.getGate = null;
  });

  it("sends no frame when nothing changed, and a keyframe every 20th tick", async () => {
    const pod = await startPod(redisUrl);
    await pod.onClientJoin?.({ sessionId: "a" } as never);
    await pod.onDataChannelBinary?.({
      sessionId: "a",
      rawBinary: pose(1, 10, 20),
    } as never);
    resetMeter();
    await vi.advanceTimersByTimeAsync(TICK_MS); // tick 1: the delta
    expect(framesFor("a")).toHaveLength(1);
    expect(framesFor("a")[0]!.bytes).toBe(4 + SLOT_BYTES);
    await vi.advanceTimersByTimeAsync(TICK_MS * 18); // ticks 2..19: idle
    expect(framesFor("a")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(TICK_MS); // tick 20: keyframe
    expect(framesFor("a")).toHaveLength(2);
    expect(framesFor("a")[1]!.bytes).toBe(4 + SLOT_BYTES);
    await vi.advanceTimersByTimeAsync(TICK_MS * 19);
    expect(framesFor("a")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(TICK_MS); // tick 40: keyframe
    expect(framesFor("a")).toHaveLength(3);
    await pod.onClientLeave?.({ sessionId: "a" } as never);
  });

  it("30 idle peers send about 0 between keyframes; moving peers stay within 4 + 30 x 6 B per tick", async () => {
    const pod = await startPod(redisUrl);
    for (let i = 0; i < 30; i += 1) {
      await pod.onClientJoin?.({ sessionId: `p${i}` } as never);
      await pod.onDataChannelBinary?.({
        sessionId: `p${i}`,
        rawBinary: pose(i, i * 10, i * 5),
      } as never);
    }
    await vi.advanceTimersByTimeAsync(TICK_MS); // settles the first delta
    resetMeter();
    await vi.advanceTimersByTimeAsync(TICK_MS * 18);
    expect(meterState().sends).toHaveLength(0);

    resetMeter();
    for (let tick = 0; tick < 10; tick += 1) {
      for (let i = 0; i < 30; i += 1) {
        await pod.onDataChannelBinary?.({
          sessionId: `p${i}`,
          rawBinary: pose(i, i * 10 + tick + 1, i * 5),
        } as never);
      }
      await vi.advanceTimersByTimeAsync(TICK_MS);
    }
    const sizes = new Set(meterState().sends.map((send) => send.bytes));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(4 + 30 * SLOT_BYTES);
    for (let i = 0; i < 30; i += 1) {
      await pod.onClientLeave?.({ sessionId: `p${i}` } as never);
    }
  });

  it("a joining session gets the last-broadcast keyframe and then the same shared deltas", async () => {
    const pod = await startPod(redisUrl);
    await pod.onClientJoin?.({ sessionId: "old" } as never);
    await pod.onDataChannelBinary?.({
      sessionId: "old",
      rawBinary: pose(5, 50, 60),
    } as never);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    resetMeter();
    await pod.onClientJoin?.({ sessionId: "new" } as never);
    const first = framesFor("new")[0]!;
    expect(first.copy).toBeDefined();
    const joinFrame = decodeFrame(first.copy!);
    expect(joinFrame.kind).toBe("keyframe");
    expect(joinFrame.slots.map((s) => s.clientIndex)).toEqual([5]);

    // A later change reaches the new session as a delta on that baseline.
    await pod.onDataChannelBinary?.({
      sessionId: "old",
      rawBinary: pose(6, 1, 2),
    } as never);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    const clientWorld = createEmptyWorldBuffer();
    for (const frame of framesFor("new")) {
      applyFrameToWorld(clientWorld, frame.copy!);
    }
    const half = quantStep(BOARD_MIN, BOARD_MAX) / 2;
    const five = readPeerSlot(clientWorld, 5)!;
    const six = readPeerSlot(clientWorld, 6)!;
    expect(Math.abs(five.x - 50)).toBeLessThanOrEqual(half);
    expect(Math.abs(five.y - 60)).toBeLessThanOrEqual(half);
    expect(Math.abs(six.x - 1)).toBeLessThanOrEqual(half);
    expect(Math.abs(six.y - 2)).toBeLessThanOrEqual(half);
    await pod.onClientLeave?.({ sessionId: "old" } as never);
    await pod.onClientLeave?.({ sessionId: "new" } as never);
  });

  it("reuses one scratch buffer: every frame sent is a view of the same backing store", async () => {
    const pod = await startPod(redisUrl);
    const buffers = new Set<unknown>();
    const agent = await import("@voicethere/agent");
    const spy = vi.spyOn(agent, "broadCastBinaryToClients");
    await pod.onClientJoin?.({ sessionId: "r" } as never);
    for (let round = 0; round < 30; round += 1) {
      await pod.onDataChannelBinary?.({
        sessionId: "r",
        rawBinary: pose(round % 8, round, round),
      } as never);
      await vi.advanceTimersByTimeAsync(TICK_MS);
    }
    for (const call of spy.mock.calls) {
      buffers.add((call[0] as Buffer).buffer);
    }
    expect(spy.mock.calls.length).toBeGreaterThan(10);
    expect(buffers.size).toBe(1);
    spy.mockRestore();
    await pod.onClientLeave?.({ sessionId: "r" } as never);
  });

  it("counts and drops invalid poses", async () => {
    const pod = await startPod(redisUrl);
    const mod = await import("../templates/redis-sync/agent.js");
    await pod.onClientJoin?.({ sessionId: "bad" } as never);
    resetMeter();
    await pod.onDataChannelBinary?.({
      sessionId: "bad",
      rawBinary: Buffer.from(new Float32Array([1, Number.NaN, 2]).buffer),
    } as never);
    await pod.onDataChannelBinary?.({
      sessionId: "bad",
      rawBinary: pose(MAX_PEERS + 4, 1, 2),
    } as never);
    expect(mod.getDroppedPoseCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(meterState().sends).toHaveLength(0);
    await pod.onClientLeave?.({ sessionId: "bad" } as never);
  });
});

describe("redis-sync join during an in-flight tick (redis mode)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMeter();
    fakeRedis.state.getGate = null;
  });
  afterEach(() => {
    vi.useRealTimers();
    fakeRedis.state.getGate = null;
  });

  it("a join during an in-flight tick converges to the pod world", async () => {
    const pod = await startPod("redis://fake");
    await pod.onClientJoin?.({ sessionId: "old" } as never);
    await pod.onDataChannelBinary?.({
      sessionId: "old",
      rawBinary: pose(5, 50, 60),
    } as never);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    await pod.onDataChannelBinary?.({
      sessionId: "old",
      rawBinary: pose(6, 1, 2),
    } as never);
    let release!: () => void;
    fakeRedis.state.getGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await vi.advanceTimersByTimeAsync(TICK_MS); // parked in the GET
    await pod.onClientJoin?.({ sessionId: "new" } as never);
    fakeRedis.state.getGate = null;
    release();
    await vi.advanceTimersByTimeAsync(TICK_MS);
    await vi.advanceTimersByTimeAsync(TICK_MS);

    const clientWorld = createEmptyWorldBuffer();
    for (const frame of framesFor("new")) {
      applyFrameToWorld(clientWorld, frame.copy!);
    }
    const podWorld = normalizeWorldBuffer(
      fakeRedis.state.store.get(REDIS_WORLD_KEY),
      createEmptyWorldBuffer(),
    );
    const active = (world: Uint8Array) =>
      Array.from({ length: MAX_PEERS }, (_, i) => i)
        .filter((i) => world[i * SLOT_BYTES + 1] === 1)
        .map((i) =>
          Buffer.from(
            world.subarray(i * SLOT_BYTES, (i + 1) * SLOT_BYTES),
          ).toString("hex"),
        );
    expect(active(podWorld)).toHaveLength(2);
    expect(active(clientWorld)).toEqual(active(podWorld));
    await pod.onClientLeave?.({ sessionId: "old" } as never);
    await pod.onClientLeave?.({ sessionId: "new" } as never);
  });
});

describe("redis-sync SETRANGE write path", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMeter();
    fakeRedis.state.getGate = null;
  });
  afterEach(() => {
    vi.useRealTimers();
    fakeRedis.state.getGate = null;
  });

  it("writes one 6-byte slot at clientIndex * 6 and never uses Lua", async () => {
    const pod = await startPod("redis://fake");
    await pod.onClientJoin?.({ sessionId: "s" } as never);
    await pod.onDataChannelBinary?.({
      sessionId: "s",
      rawBinary: pose(5, 100, -100),
    } as never);
    const writes = fakeRedis.state.calls.filter((c) => c.cmd === "setrange");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.args[0]).toBe(REDIS_WORLD_KEY);
    expect(writes[0]!.args[1]).toBe(5 * SLOT_BYTES);
    expect((writes[0]!.args[2] as Buffer).byteLength).toBe(SLOT_BYTES);
    expect(fakeRedis.state.calls.some((c) => c.cmd === "eval")).toBe(false);

    // SETRANGE pads with zeros up to the slot, the pod reads a short blob as a 768 B world.
    expect(fakeRedis.state.store.get(REDIS_WORLD_KEY)!.length).toBe(
      6 * SLOT_BYTES,
    );
    await vi.advanceTimersByTimeAsync(TICK_MS);
    const frame = framesFor("s").at(-1)!;
    expect(frame.bytes).toBe(4 + SLOT_BYTES);

    await pod.onClientLeave?.({ sessionId: "s" } as never);
    const leave = fakeRedis.state.calls
      .filter((c) => c.cmd === "setrange")
      .at(-1)!;
    expect(leave.args[1]).toBe(5 * SLOT_BYTES);
    expect([...(leave.args[2] as Buffer)]).toEqual([5, 0, 0, 0, 0, 0]);
    expect(WORLD_BYTE_LENGTH).toBe(MAX_PEERS * SLOT_BYTES);
    expect(readPeerSlot(createEmptyWorldBuffer(), 5)).toBeNull();
  });
});
