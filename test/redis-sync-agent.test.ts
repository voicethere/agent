import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyFrameToWorld,
  createEmptyWorldBuffer,
  decodeFrame,
  encodePositionInto,
  MAX_PEERS,
  readPeerSlot,
} from "../templates/redis-sync/world-layout.js";
import {
  binarySends,
  clearAgentIpc,
  emitBinary,
  emitJson,
  endSession,
  silenceAgentIpc,
  startSession,
} from "./helpers/agent-ipc.js";

const ipc = silenceAgentIpc();
await import("../templates/redis-sync/agent.js");

function positionFrame(clientIndex: number, x: number, y: number): Buffer {
  const floats = encodePositionInto(new Float32Array(3), clientIndex, x, y);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

/** What a client sees: every frame sent to the session applied in order. */
function clientWorld(sessionId: string): Uint8Array {
  const world = createEmptyWorldBuffer();
  for (const frame of binarySends(ipc.send, sessionId)) {
    applyFrameToWorld(world, frame);
  }
  return world;
}

describe("redis-sync in-memory agent handlers", () => {
  const sessions: string[] = [];

  beforeEach(() => {
    clearAgentIpc(ipc.send);
    sessions.length = 0;
  });

  afterEach(async () => {
    for (const sessionId of sessions.splice(0)) {
      await endSession(sessionId);
    }
  });

  async function join(sessionId: string): Promise<void> {
    sessions.push(sessionId);
    await startSession(ipc.send, sessionId);
  }

  it("quantizes a 12-byte position frame and delivers it as a delta", async () => {
    await join("redis-mem-a");
    emitBinary("redis-mem-a", positionFrame(2, 11, 22));

    await vi.waitFor(() => {
      const slot = readPeerSlot(clientWorld("redis-mem-a"), 2);
      expect(slot?.x).toBeCloseTo(11, 1);
      expect(slot?.y).toBeCloseTo(22, 1);
    });
    const kinds = binarySends(ipc.send, "redis-mem-a").map(
      (frame) => decodeFrame(frame).kind,
    );
    expect(kinds[0]).toBe("keyframe");
    expect(kinds).toContain("delta");
  });

  it("does not patch a slot from a JSON position message", async () => {
    await join("redis-json");
    emitJson("redis-json", { type: "position", clientIndex: 1, x: 9, y: 8 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(readPeerSlot(clientWorld("redis-json"), 1)).toBeNull();
  });

  it("ignores short binary frames and out-of-range indexes", async () => {
    await join("redis-short");
    emitBinary("redis-short", Buffer.alloc(8));
    emitBinary("redis-short", positionFrame(MAX_PEERS, 1, 2));
    await new Promise((resolve) => setTimeout(resolve, 120));
    const world = clientWorld("redis-short");
    expect(world.every((byte) => byte === 0)).toBe(true);
  });

  it("clears the peer slot once when the session leaves", async () => {
    await join("redis-stay");
    await join("redis-leave");
    emitBinary("redis-leave", positionFrame(3, 1, 2));

    await vi.waitFor(() => {
      expect(readPeerSlot(clientWorld("redis-stay"), 3)).not.toBeNull();
    });

    await endSession("redis-leave");
    sessions.splice(sessions.indexOf("redis-leave"), 1);

    await vi.waitFor(() => {
      expect(readPeerSlot(clientWorld("redis-stay"), 3)).toBeNull();
    });
    const leaves = binarySends(ipc.send, "redis-stay")
      .map((frame) => decodeFrame(frame))
      .filter(
        (frame) =>
          frame.kind === "delta" &&
          frame.slots.some(
            (slot) => slot.clientIndex === 3 && slot.active === 0,
          ),
      );
    expect(leaves).toHaveLength(1);
  });
});
