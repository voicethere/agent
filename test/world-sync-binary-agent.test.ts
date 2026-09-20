import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  decodeWorldSnapshot,
  encodePoseBuffer,
} from "../templates/world-sync-binary/protocol.js";
import {
  binarySends,
  clearAgentIpc,
  emitBinary,
  endSession,
  silenceAgentIpc,
  startSession,
} from "./helpers/agent-ipc.js";

const ipc = silenceAgentIpc();
await import("../templates/world-sync-binary/agent.js");

describe("world-sync-binary agent handlers", () => {
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

  it("broadcasts a packed snapshot when a peer sends xyz", async () => {
    await join("bin-a");
    await join("bin-b");
    emitBinary("bin-a", Buffer.from(encodePoseBuffer({ x: 1, y: 2, z: 3 })));

    await vi.waitFor(() => {
      const frames = binarySends(ipc.send, "bin-b");
      expect(frames.length).toBeGreaterThan(0);
      const world = decodeWorldSnapshot(frames[frames.length - 1]!);
      expect(world).toEqual(
        expect.arrayContaining([
          { sessionId: "bin-a", pose: { x: 1, y: 2, z: 3 } },
          { sessionId: "bin-b", pose: { x: 0, y: 0, z: 0 } },
        ]),
      );
      expect(world).toHaveLength(2);
    });
  });

  it("reuses one Buffer view across every peer send", async () => {
    await join("bin-share-a");
    await join("bin-share-b");
    ipc.send.mockClear();
    emitBinary(
      "bin-share-a",
      Buffer.from(encodePoseBuffer({ x: 9, y: 8, z: 7 })),
    );

    await vi.waitFor(() => {
      const frames = binarySends(ipc.send);
      expect(frames.length).toBeGreaterThanOrEqual(2);
      expect(frames[0]?.buffer).toBe(frames[1]?.buffer);
    });
  });

  it("removes a leaving peer from the packed snapshot", async () => {
    await join("bin-leave-a");
    await join("bin-leave-b");
    await endSession("bin-leave-b");
    sessions.splice(sessions.indexOf("bin-leave-b"), 1);

    await vi.waitFor(() => {
      const frames = binarySends(ipc.send, "bin-leave-a");
      expect(frames.length).toBeGreaterThan(0);
      expect(decodeWorldSnapshot(frames[frames.length - 1]!)).toEqual([
        { sessionId: "bin-leave-a", pose: { x: 0, y: 0, z: 0 } },
      ]);
    });
  });
});
