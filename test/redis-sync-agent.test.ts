import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PEER_FIELD_ACTIVE,
  PEER_FIELD_X,
  PEER_STRIDE,
  WORLD_FLOAT_COUNT,
} from "../templates/redis-sync/world-layout.js";
import {
  binarySends,
  clearAgentIpc,
  emitJson,
  endSession,
  silenceAgentIpc,
  startSession,
} from "./helpers/agent-ipc.js";

const ipc = silenceAgentIpc();
await import("../templates/redis-sync/agent.js");

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

  it("patches a peer slot and broadcasts the world blob", async () => {
    await join("redis-mem-a");
    emitJson("redis-mem-a", { type: "position", clientIndex: 2, x: 11, y: 22 });

    await vi.waitFor(() => {
      const frames = binarySends(ipc.send, "redis-mem-a");
      expect(frames.length).toBeGreaterThan(0);
      const world = new Float32Array(
        frames[frames.length - 1]!.buffer,
        frames[frames.length - 1]!.byteOffset,
        frames[frames.length - 1]!.byteLength / 4,
      );
      expect(world.length).toBe(WORLD_FLOAT_COUNT);
      const offset = 2 * PEER_STRIDE;
      expect(world[offset + PEER_FIELD_X]).toBe(11);
      expect(world[offset + PEER_FIELD_ACTIVE]).toBe(1);
    });
  });
});
