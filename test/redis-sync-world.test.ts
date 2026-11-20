import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { dequantize, quantize } from "../templates/redis-sync/quantize.js";
import {
  applyFrameToWorld,
  BOARD_MAX,
  BOARD_MIN,
  clearPeerSlot,
  createEmptyWorldBuffer,
  decodeFrame,
  decodePositionBuffer,
  encodeDeltaInto,
  encodeKeyframeInto,
  encodePositionInto,
  encodeSlotInto,
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
  MAX_PEERS,
  normalizeWorldBuffer,
  POSITION_BYTE_LENGTH,
  readPeerSlot,
  SLOT_BYTES,
  SyncFrameError,
  WORLD_BYTE_LENGTH,
  writePeerSlot,
} from "../templates/redis-sync/world-layout.js";

const here = dirname(fileURLToPath(import.meta.url));

type Vectors = {
  board: { min: number; max: number };
  redisSync: {
    frames: Array<{
      name: string;
      hex: string;
      kind: string;
      version: number;
      slots: Array<{
        clientIndex: number;
        active: number;
        qx: number;
        qy: number;
      }>;
    }>;
  };
  gameSync: { frames: unknown[] };
  quantizer: {
    board: Array<{ value: number; q: number }>;
    unit: Array<{ value: number; q: number }>;
  };
};

function activeSlots(world: Uint8Array): string[] {
  const out: string[] = [];
  for (let i = 0; i < MAX_PEERS; i += 1) {
    const slot = readPeerSlot(world, i);
    if (slot) out.push(`${i}:${slot.x.toFixed(6)}:${slot.y.toFixed(6)}`);
  }
  return out;
}

describe("redis-sync world layout", () => {
  it("round-trips a live peer slot within half a step", () => {
    const world = createEmptyWorldBuffer();
    expect(world.byteLength).toBe(WORLD_BYTE_LENGTH);
    expect(WORLD_BYTE_LENGTH).toBe(768);
    writePeerSlot(world, 4, 12.5, -3, 1);
    const slot = readPeerSlot(world, 4)!;
    expect(slot.clientIndex).toBe(4);
    expect(slot.active).toBe(1);
    expect(slot.x).toBeCloseTo(12.5, 1);
    expect(slot.y).toBeCloseTo(-3, 1);
    clearPeerSlot(world, 4);
    expect(readPeerSlot(world, 4)).toBeNull();
  });

  it("encodeSlotInto writes the 6-byte slot used by SETRANGE", () => {
    const dest = new Uint8Array(SLOT_BYTES);
    encodeSlotInto(dest, 9, 100, -200, 1);
    expect(dest[0]).toBe(9);
    expect(dest[1]).toBe(1);
    const view = new DataView(dest.buffer);
    expect(view.getInt16(2, true)).toBe(quantize(100, BOARD_MIN, BOARD_MAX));
    expect(view.getInt16(4, true)).toBe(quantize(-200, BOARD_MIN, BOARD_MAX));
    encodeSlotInto(dest, 9, 100, -200, 0);
    expect([...dest]).toEqual([9, 0, 0, 0, 0, 0]);
  });

  it("normalizeWorldBuffer copies into dest, pads short blobs and cuts long ones", () => {
    const dest = createEmptyWorldBuffer();
    writePeerSlot(dest, 1, 8, 9, 1);
    const raw = Buffer.from(dest);
    dest.fill(7);
    expect(normalizeWorldBuffer(raw.subarray(0, 12), dest)).toBe(dest);
    expect(dest[1 * SLOT_BYTES + 1]).toBe(1);
    expect(dest[12]).toBe(0);
    normalizeWorldBuffer(Buffer.alloc(WORLD_BYTE_LENGTH + 50, 1), dest);
    expect(dest.byteLength).toBe(WORLD_BYTE_LENGTH);
    normalizeWorldBuffer(null, dest);
    expect(dest.every((b) => b === 0)).toBe(true);
  });

  it("round-trips a keyframe and a delta", () => {
    const world = createEmptyWorldBuffer();
    const last = createEmptyWorldBuffer();
    const frame = new Uint8Array(MAX_FRAME_BYTES);
    writePeerSlot(world, 2, 5, 6, 1);
    writePeerSlot(world, 70, -7, 8, 1);

    const keyLen = encodeKeyframeInto(frame, world);
    expect(keyLen).toBe(FRAME_HEADER_BYTES + 2 * SLOT_BYTES);
    const key = decodeFrame(frame.subarray(0, keyLen));
    expect(key.kind).toBe("keyframe");
    expect(key.slots.map((s) => s.clientIndex)).toEqual([2, 70]);

    const deltaLen = encodeDeltaInto(frame, world, last);
    expect(decodeFrame(frame.subarray(0, deltaLen)).kind).toBe("delta");
    last.set(world);
    expect(encodeDeltaInto(frame, world, last)).toBe(0);
    writePeerSlot(world, 2, 5.5, 6, 1);
    const one = encodeDeltaInto(frame, world, last);
    expect(one).toBe(FRAME_HEADER_BYTES + SLOT_BYTES);
    clearPeerSlot(world, 70);
    last.set(world);
    clearPeerSlot(world, 2);
    const leave = decodeFrame(
      frame.subarray(0, encodeDeltaInto(frame, world, last)),
    );
    expect(leave.slots).toEqual([{ clientIndex: 2, active: 0, qx: 0, qy: 0 }]);
  });

  it("a client that applies a keyframe and then any deltas equals the pod world (seeded)", () => {
    let seed = 987654321;
    const rand = (n: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    const pod = createEmptyWorldBuffer();
    const last = createEmptyWorldBuffer();
    const client = createEmptyWorldBuffer();
    const frame = new Uint8Array(MAX_FRAME_BYTES);
    for (let round = 0; round < 400; round += 1) {
      const moves = rand(6);
      for (let m = 0; m < moves; m += 1) {
        const idx = rand(MAX_PEERS);
        if (rand(5) === 0) {
          clearPeerSlot(pod, idx);
        } else {
          writePeerSlot(pod, idx, rand(2400) - 1200, rand(2400) - 1200, 1);
        }
      }
      if (round % 20 === 0) {
        applyFrameToWorld(
          client,
          frame.subarray(0, encodeKeyframeInto(frame, pod)),
        );
      } else {
        const len = encodeDeltaInto(frame, pod, last);
        if (len > 0) applyFrameToWorld(client, frame.subarray(0, len));
      }
      last.set(pod);
      expect(activeSlots(client)).toEqual(activeSlots(pod));
    }
  });

  it("decodeFrame throws a named error for unknown kind, version and bad length", () => {
    expect(() => decodeFrame(Uint8Array.of(9, 1, 0, 0))).toThrow(
      SyncFrameError,
    );
    expect(() => decodeFrame(Uint8Array.of(1, 2, 0, 0))).toThrow(/version 2/);
    expect(() => decodeFrame(Uint8Array.of(1, 1, 1, 0, 0))).toThrow(
      /does not match/,
    );
    expect(() => decodeFrame(Uint8Array.of(1, 1))).toThrow(/too short/);
  });

  it("round-trips a 12-byte inbound position frame", () => {
    const dest = new Float32Array(3);
    encodePositionInto(dest, 7, 1.5, -2);
    expect(dest.byteLength).toBe(POSITION_BYTE_LENGTH);
    expect(decodePositionBuffer(dest)).toEqual({
      clientIndex: 7,
      x: 1.5,
      y: -2,
    });
    const buf = Buffer.from(dest.buffer, dest.byteOffset, dest.byteLength);
    expect(decodePositionBuffer(buf)).toEqual({
      clientIndex: 7,
      x: 1.5,
      y: -2,
    });
  });

  it("decodePositionBuffer rejects short, null, non-finite or out-of-range frames", () => {
    expect(decodePositionBuffer(null)).toBeNull();
    expect(decodePositionBuffer(new Float32Array(2))).toBeNull();
    expect(
      decodePositionBuffer(new Float32Array([Number.NaN, 1, 2])),
    ).toBeNull();
    expect(decodePositionBuffer(new Float32Array([1, Infinity, 2]))).toBeNull();
    expect(decodePositionBuffer(new Float32Array([-1, 1, 2]))).toBeNull();
    expect(
      decodePositionBuffer(new Float32Array([MAX_PEERS, 1, 2])),
    ).toBeNull();
    expect(
      decodePositionBuffer(new Float32Array([MAX_PEERS - 1, 1, 2])),
    ).not.toBeNull();
  });

  it("decodePositionBuffer reads a typed-array view with byteOffset", () => {
    const padded = new Float32Array(6);
    padded[3] = 4;
    padded[4] = 10;
    padded[5] = 20;
    const view = new Float32Array(padded.buffer, 12, 3);
    expect(decodePositionBuffer(view)).toEqual({
      clientIndex: 4,
      x: 10,
      y: 20,
    });
  });
});

describe("quantized-frames.vectors.json (redis-sync)", () => {
  const vectors = JSON.parse(
    readFileSync(
      join(here, "../templates/redis-sync/quantized-frames.vectors.json"),
      "utf8",
    ),
  ) as Vectors;

  it("carries the board bounds, redis-sync frames and the game-sync frames", () => {
    expect(vectors.board).toEqual({ min: BOARD_MIN, max: BOARD_MAX });
    expect(vectors.redisSync.frames.length).toBeGreaterThanOrEqual(5);
    // Decoded and re-encoded in test/game-sync-frames.test.ts.
    expect(vectors.gameSync.frames.length).toBeGreaterThanOrEqual(4);
  });

  it("decodes every frame to the listed slots", () => {
    for (const vector of vectors.redisSync.frames) {
      const decoded = decodeFrame(Buffer.from(vector.hex, "hex"));
      expect(decoded.kind, vector.name).toBe(vector.kind);
      expect(decoded.version, vector.name).toBe(vector.version);
      expect(decoded.slots, vector.name).toEqual(vector.slots);
    }
  });

  it("matches the quantizer", () => {
    for (const row of vectors.quantizer.board) {
      expect(quantize(row.value, BOARD_MIN, BOARD_MAX)).toBe(row.q);
    }
    expect(dequantize(32767, BOARD_MIN, BOARD_MAX)).toBe(BOARD_MAX);
  });
});
