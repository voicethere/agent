import { describe, expect, it } from "vitest";

import {
  clearPeerSlot,
  createEmptyWorldBuffer,
  decodePositionBuffer,
  decodeWorldBuffer,
  encodePositionInto,
  normalizeWorldBuffer,
  POSITION_BYTE_LENGTH,
  readPeerSlot,
  WORLD_BYTE_LENGTH,
  worldBufferToArrayBuffer,
  writePeerSlot,
} from "../templates/redis-sync/world-layout.js";

describe("redis-sync world layout", () => {
  it("round-trips a live peer slot", () => {
    const world = createEmptyWorldBuffer();
    writePeerSlot(world, 4, 12.5, -3, 1);
    expect(readPeerSlot(world, 4)).toEqual({
      clientIndex: 4,
      x: 12.5,
      y: -3,
      active: 1,
    });
    clearPeerSlot(world, 4);
    expect(readPeerSlot(world, 4)).toBeNull();
  });

  it("normalizeWorldBuffer writes into dest without allocating a new world", () => {
    const dest = createEmptyWorldBuffer();
    writePeerSlot(dest, 1, 8, 9, 1);
    const raw = Buffer.from(
      new Uint8Array(dest.buffer, dest.byteOffset, dest.byteLength),
    );
    dest.fill(0);
    const result = normalizeWorldBuffer(raw, dest);
    expect(result).toBe(dest);
    expect(readPeerSlot(dest, 1)).toEqual({
      clientIndex: 1,
      x: 8,
      y: 9,
      active: 1,
    });
  });

  it("worldBufferToArrayBuffer returns the standalone backing buffer", () => {
    const world = createEmptyWorldBuffer();
    expect(worldBufferToArrayBuffer(world)).toBe(world.buffer);
    expect(worldBufferToArrayBuffer(world).byteLength).toBe(WORLD_BYTE_LENGTH);
  });

  it("decodeWorldBuffer copies an ArrayBuffer into dest", () => {
    const src = createEmptyWorldBuffer();
    writePeerSlot(src, 0, 1, 2, 1);
    const dest = createEmptyWorldBuffer();
    const decoded = decodeWorldBuffer(
      worldBufferToArrayBuffer(src) as ArrayBuffer,
      dest,
    );
    expect(decoded).toBe(dest);
    expect(readPeerSlot(dest, 0)?.x).toBe(1);
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

  it("decodePositionBuffer rejects short, null, or non-finite frames", () => {
    expect(decodePositionBuffer(null)).toBeNull();
    expect(decodePositionBuffer(new Float32Array(2))).toBeNull();
    expect(
      decodePositionBuffer(new Float32Array([Number.NaN, 1, 2])),
    ).toBeNull();
    expect(decodePositionBuffer(new Float32Array([-1, 1, 2]))).toBeNull();
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
