import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  encodePositionInto,
  PEER_FIELD_ACTIVE,
  PEER_FIELD_X,
  PEER_STRIDE,
  WORLD_FLOAT_COUNT,
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

function latestWorld(sessionId: string): Float32Array {
  const frames = binarySends(ipc.send, sessionId);
  const last = frames[frames.length - 1]!;
  return new Float32Array(last.buffer, last.byteOffset, last.byteLength / 4);
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

  it("patches a peer slot from a 12-byte position frame and broadcasts the world blob", async () => {
    await join("redis-mem-a");
    emitBinary("redis-mem-a", positionFrame(2, 11, 22));

    await vi.waitFor(() => {
      const frames = binarySends(ipc.send, "redis-mem-a");
      expect(frames.length).toBeGreaterThan(0);
      const world = latestWorld("redis-mem-a");
      expect(world.length).toBe(WORLD_FLOAT_COUNT);
      const offset = 2 * PEER_STRIDE;
      expect(world[offset + PEER_FIELD_X]).toBe(11);
      expect(world[offset + PEER_FIELD_ACTIVE]).toBe(1);
    });
  });

  it("does not patch a slot from a JSON position message", async () => {
    await join("redis-json");
    ipc.send.mockClear();
    emitJson("redis-json", { type: "position", clientIndex: 1, x: 9, y: 8 });

    await vi.waitFor(() => {
      expect(binarySends(ipc.send, "redis-json").length).toBeGreaterThan(0);
    });
    expect(latestWorld("redis-json")[1 * PEER_STRIDE + PEER_FIELD_ACTIVE]).toBe(
      0,
    );
  });

  it("ignores short binary frames", async () => {
    await join("redis-short");
    ipc.send.mockClear();
    emitBinary("redis-short", Buffer.alloc(8));

    await vi.waitFor(() => {
      expect(binarySends(ipc.send, "redis-short").length).toBeGreaterThan(0);
    });
    expect(latestWorld("redis-short")[PEER_FIELD_ACTIVE]).toBe(0);
  });

  it("clears the peer slot when the session leaves", async () => {
    await join("redis-stay");
    await join("redis-leave");
    emitBinary("redis-leave", positionFrame(3, 1, 2));
    const offset = 3 * PEER_STRIDE;

    await vi.waitFor(() => {
      expect(latestWorld("redis-stay")[offset + PEER_FIELD_ACTIVE]).toBe(1);
    });

    await endSession("redis-leave");
    sessions.splice(sessions.indexOf("redis-leave"), 1);

    await vi.waitFor(() => {
      expect(latestWorld("redis-stay")[offset + PEER_FIELD_ACTIVE]).toBe(0);
    });
  });
});
