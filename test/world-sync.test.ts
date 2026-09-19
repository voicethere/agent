import { describe, expect, it } from "vitest";

import { parsePoseMessage } from "../templates/world-sync/agent.js";
import {
  decodePoseBuffer,
  decodeWorldSnapshot,
  encodePoseBuffer,
  encodeWorldSnapshot,
  POSE_BYTE_LENGTH,
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
});
