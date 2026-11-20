import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import vectors from "../templates/redis-sync/quantized-frames.vectors.json" with { type: "json" };
import { quantStep } from "../templates/game-sync/quantize.js";
import {
  BOARD_X_MAX,
  BOARD_Y_MAX,
  createEmptyWorldBuffer,
  decodeLiveObjectsFrame,
  dequantizeObject,
  encodeLiveObjectsInto,
  FRAME_FORMAT_QUANTIZED,
  FRAME_HEADER_BYTES,
  FRAME_RECORD_BYTES,
  FRAME_VERSION,
  invalidObjectDropCount,
  MAX_FRAME_BYTES,
  VELOCITY_LIMIT,
  WorldFrameError,
  writeObjectSlot,
} from "../templates/game-sync/world-layout.js";
import { BOARD_HEIGHT, BOARD_WIDTH } from "../templates/game-sync/sim.js";
import { MAX_LIVE_OBJECTS } from "../templates/game-sync/protocol.js";

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

type Input = { objectId: number; slot: number; pose: number[] };

function worldFromInput(inputs: Input[]): Float32Array {
  const world = createEmptyWorldBuffer();
  for (const o of inputs) {
    const p = o.pose as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    writeObjectSlot(world, o.slot, o.objectId, ...p);
  }
  return world;
}

describe("game-sync quantize.ts copy", () => {
  it("is byte-identical to redis-sync/quantize.ts (templates are self-contained)", () => {
    const a = readFileSync(
      new URL("../templates/game-sync/quantize.ts", import.meta.url),
    );
    const b = readFileSync(
      new URL("../templates/redis-sync/quantize.ts", import.meta.url),
    );
    expect(a.equals(b)).toBe(true);
  });
});

describe("game-sync quantized frame", () => {
  it("bounds equal the sim board", () => {
    expect(BOARD_X_MAX).toBe(BOARD_WIDTH);
    expect(BOARD_Y_MAX).toBe(BOARD_HEIGHT);
    expect(vectors.gameSync.bounds.x).toEqual([0, BOARD_WIDTH]);
    expect(vectors.gameSync.bounds.y).toEqual([0, BOARD_HEIGHT]);
    expect(vectors.gameSync.bounds.velocity).toEqual([
      -VELOCITY_LIMIT,
      VELOCITY_LIMIT,
    ]);
  });

  it("frame length is 4 + live x 18 B and MAX_FRAME_BYTES covers every slot", () => {
    expect(MAX_FRAME_BYTES).toBe(4 + MAX_LIVE_OBJECTS * 18);
    const world = createEmptyWorldBuffer();
    const dest = new Uint8Array(MAX_FRAME_BYTES);
    expect(encodeLiveObjectsInto(dest, world)).toBe(FRAME_HEADER_BYTES);
    for (const live of [1, 10, 25]) {
      for (let slot = 0; slot < live; slot += 1) {
        writeObjectSlot(world, slot, slot + 1, 10, 20, 0, 1, 30, 40, 0, 0);
      }
      expect(encodeLiveObjectsInto(dest, world)).toBe(
        FRAME_HEADER_BYTES + live * FRAME_RECORD_BYTES,
      );
      expect(dest[0]).toBe(FRAME_FORMAT_QUANTIZED);
      expect(dest[1]).toBe(FRAME_VERSION);
    }
  });

  for (const frame of vectors.gameSync.frames) {
    it(`shared vector ${frame.name}: decode and encode`, () => {
      const bytes = hexToBytes(frame.hex);
      expect(decodeLiveObjectsFrame(bytes)).toEqual(frame.objects);

      const dest = new Uint8Array(MAX_FRAME_BYTES);
      const world = worldFromInput(frame.input);
      const length = encodeLiveObjectsInto(dest, world);
      expect(Buffer.from(dest.subarray(0, length)).toString("hex")).toBe(
        frame.hex,
      );
    });
  }

  it("round-trips live objects within half a step", () => {
    const world = createEmptyWorldBuffer();
    let seed = 99;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let slot = 0; slot < MAX_LIVE_OBJECTS; slot += 1) {
      writeObjectSlot(
        world,
        slot,
        slot + 1,
        rand() * BOARD_X_MAX,
        rand() * BOARD_Y_MAX,
        0,
        1,
        (rand() * 2 - 1) * 254,
        (rand() * 2 - 1) * 254,
        0,
        0,
      );
    }
    const dest = new Uint8Array(MAX_FRAME_BYTES);
    const length = encodeLiveObjectsInto(dest, world);
    const objects = decodeLiveObjectsFrame(dest.subarray(0, length));
    expect(objects).toHaveLength(MAX_LIVE_OBJECTS);
    const posStepX = quantStep(0, BOARD_X_MAX);
    const posStepY = quantStep(0, BOARD_Y_MAX);
    const velStep = quantStep(-VELOCITY_LIMIT, VELOCITY_LIMIT);
    for (const [i, o] of objects.entries()) {
      const back = dequantizeObject(o.q);
      expect(o.objectId).toBe(i + 1);
      expect(Math.abs(back[0]! - world[i * 9 + 1]!)).toBeLessThanOrEqual(
        posStepX / 2 + 1e-4,
      );
      expect(Math.abs(back[1]! - world[i * 9 + 2]!)).toBeLessThanOrEqual(
        posStepY / 2 + 1e-4,
      );
      expect(Math.abs(back[4]! - world[i * 9 + 5]!)).toBeLessThanOrEqual(
        velStep / 2 + 1e-4,
      );
      expect(back[3]).toBeCloseTo(1, 6);
    }
  });

  it("drops and counts an object with a non-finite component instead of encoding it", () => {
    const world = createEmptyWorldBuffer();
    writeObjectSlot(world, 0, 1, Number.NaN, 20, 0, 1, 1, 1, 0, 0);
    writeObjectSlot(world, 1, 2, 10, 20, 0, 1, 1, 1, 0, 0);
    writeObjectSlot(world, 2, 3, 10, 20, 0, 1, Infinity, 1, 0, 0);
    const before = invalidObjectDropCount();
    const dest = new Uint8Array(MAX_FRAME_BYTES);
    const length = encodeLiveObjectsInto(dest, world);
    expect(invalidObjectDropCount() - before).toBe(2);
    const objects = decodeLiveObjectsFrame(dest.subarray(0, length));
    expect(objects.map((o) => o.objectId)).toEqual([2]);
  });

  it("decoder throws a named error for an unknown format, version or length", () => {
    expect(() => decodeLiveObjectsFrame(hexToBytes("03010000"))).toThrow(
      WorldFrameError,
    );
    expect(() => decodeLiveObjectsFrame(hexToBytes("02020000"))).toThrow(
      /unknown frame version 2/,
    );
    expect(() => decodeLiveObjectsFrame(hexToBytes("0201010000"))).toThrow(
      /does not match objectCount/,
    );
    expect(() => decodeLiveObjectsFrame(hexToBytes("0201"))).toThrow(
      /too short/,
    );
  });
});
