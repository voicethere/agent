import { describe, expect, it } from "vitest";

import {
  clearPeerSlot,
  createEmptyWorldBuffer,
  decodeWorldBuffer,
  normalizeWorldBuffer,
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
});
