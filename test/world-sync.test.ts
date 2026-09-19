import { describe, expect, it } from "vitest";

import { parsePoseMessage } from "../templates/world-sync/agent.js";
import {
  decodePoseBuffer,
  decodePoseInto,
  decodeWorldSnapshot,
  encodePoseBuffer,
  encodeWorldSnapshot,
  POSE_BYTE_LENGTH,
  WorldSnapshotBuffer,
} from "../templates/world-sync-binary/protocol.js";

describe("world-sync JSON poses", () => {
  it("parses type pose messages", () => {
    expect(parsePoseMessage({ type: "pose", x: 1, y: 2, z: -3 })).toEqual({
      x: 1,
      y: 2,
      z: -3,
    });
  });

  it("parses bare xyz objects", () => {
    expect(parsePoseMessage({ x: 0.5, y: 0, z: 8 })).toEqual({
      x: 0.5,
      y: 0,
      z: 8,
    });
  });

  it("rejects non-pose payloads", () => {
    expect(parsePoseMessage({ type: "chat", x: 1, y: 2, z: 3 })).toBeNull();
    expect(parsePoseMessage({ x: "1", y: 0, z: 0 })).toBeNull();
    expect(parsePoseMessage(null)).toBeNull();
  });
});

describe("world-sync-binary pose buffers", () => {
  it("round-trips a 12-byte ArrayBuffer pose", () => {
    const encoded = encodePoseBuffer({ x: 10, y: -2.5, z: 4 });
    expect(encoded.byteLength).toBe(POSE_BYTE_LENGTH);
    expect(decodePoseBuffer(encoded)).toEqual({ x: 10, y: -2.5, z: 4 });
    expect(decodePoseBuffer(encoded.buffer)).toEqual({ x: 10, y: -2.5, z: 4 });
  });

  it("writes a pose into an existing Float32Array", () => {
    const xyz = new Float32Array(6);
    const encoded = encodePoseBuffer({ x: 1, y: 2, z: 3 });
    expect(decodePoseInto(encoded, xyz, 3)).toBe(true);
    expect(Array.from(xyz)).toEqual([0, 0, 0, 1, 2, 3]);
  });

  it("reads a pose from a view into a larger buffer without copying", () => {
    const larger = new Uint8Array(24);
    larger.set(encodePoseBuffer({ x: 4, y: 5, z: 6 }), 8);
    expect(decodePoseBuffer(larger.subarray(8, 20))).toEqual({ x: 4, y: 5, z: 6 });
  });

  it("rejects short buffers", () => {
    expect(decodePoseBuffer(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(decodePoseBuffer(null)).toBeNull();
  });

  it("round-trips a packed world snapshot with session ids", () => {
    const encoded = encodeWorldSnapshot([
      { sessionId: "peer-a", pose: { x: 1, y: 2, z: 3 } },
      { sessionId: "peer-b", pose: { x: -4, y: 0, z: 8 } },
    ]);
    expect(decodeWorldSnapshot(encoded)).toEqual([
      { sessionId: "peer-a", pose: { x: 1, y: 2, z: 3 } },
      { sessionId: "peer-b", pose: { x: -4, y: 0, z: 8 } },
    ]);
  });

  it("reuses the snapshot backing buffer across encodes", () => {
    const first = encodeWorldSnapshot([
      { sessionId: "a", pose: { x: 1, y: 0, z: 0 } },
    ]);
    const backing = first.buffer;
    const second = encodeWorldSnapshot([
      { sessionId: "b", pose: { x: 0, y: 1, z: 0 } },
    ]);
    expect(second.buffer).toBe(backing);
    expect(decodeWorldSnapshot(second)).toEqual([
      { sessionId: "b", pose: { x: 0, y: 1, z: 0 } },
    ]);
  });

  it("encodePacked writes xyz from a persistent Float32Array", () => {
    const snapshot = new WorldSnapshotBuffer();
    const ids = ["p1", "p2"];
    const xyz = new Float32Array([1, 2, 3, 4, 5, 6]);
    const encoded = snapshot.encodePacked(ids, xyz, 2);
    expect(decodeWorldSnapshot(encoded)).toEqual([
      { sessionId: "p1", pose: { x: 1, y: 2, z: 3 } },
      { sessionId: "p2", pose: { x: 4, y: 5, z: 6 } },
    ]);
    xyz[0] = 9;
    const again = snapshot.encodePacked(ids, xyz, 2);
    expect(again.buffer).toBe(encoded.buffer);
    expect(decodeWorldSnapshot(again)[0]?.pose.x).toBe(9);
  });
});
