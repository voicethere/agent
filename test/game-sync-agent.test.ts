import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_LIVE_OBJECTS } from "../templates/game-sync/protocol.js";
import {
  OBJECT_STRIDE,
  readSlotObjectId,
} from "../templates/game-sync/world-layout.js";
import {
  binarySends,
  clearAgentIpc,
  clientPayloads,
  emitJson,
  endSession,
  silenceAgentIpc,
  startSession,
} from "./helpers/agent-ipc.js";

const ipc = silenceAgentIpc();
await import("../templates/game-sync/agent.js");

function latestPayload(
  send: ReturnType<typeof vi.fn>,
  sessionId: string,
  type: string,
): Record<string, unknown> | undefined {
  return clientPayloads(send, sessionId)
    .filter(
      (payload): payload is Record<string, unknown> =>
        Boolean(payload) &&
        typeof payload === "object" &&
        (payload as { type?: unknown }).type === type,
    )
    .at(-1);
}

describe("game-sync in-memory agent handlers", () => {
  const sessions: string[] = [];

  beforeEach(() => {
    clearAgentIpc(ipc.send);
    sessions.length = 0;
  });

  afterEach(async () => {
    for (const sessionId of [...sessions].reverse()) {
      const owned = latestPayload(ipc.send, sessionId, "register_ack");
      if (typeof owned?.objectId === "number") {
        emitJson(sessionId, { type: "unregister", objectId: owned.objectId });
        await vi.waitFor(() => {
          expect(
            latestPayload(ipc.send, sessionId, "unregister_ack"),
          ).toMatchObject({ objectId: owned.objectId });
        });
      }
      await endSession(sessionId);
    }
    sessions.length = 0;
  });

  async function join(sessionId: string): Promise<void> {
    sessions.push(sessionId);
    await startSession(ipc.send, sessionId);
  }

  it("acks register and writes a live object into the binary world", async () => {
    await join("game-reg");
    emitJson("game-reg", { type: "register" });

    await vi.waitFor(() => {
      const ack = latestPayload(ipc.send, "game-reg", "register_ack");
      expect(ack).toMatchObject({ type: "register_ack" });
      expect(ack?.objectId).toEqual(expect.any(Number));
    });

    await vi.waitFor(() => {
      const frames = binarySends(ipc.send, "game-reg");
      expect(frames.length).toBeGreaterThan(0);
      const world = new Float32Array(
        frames[frames.length - 1]!.buffer,
        frames[frames.length - 1]!.byteOffset,
        frames[frames.length - 1]!.byteLength / 4,
      );
      expect(readSlotObjectId(world, 0)).toBeGreaterThan(0);
      expect(world[1]).toBeGreaterThan(0);
    });
  });

  it("nacks register once MAX_LIVE_OBJECTS are filled", async () => {
    await join("game-full");
    for (let i = 0; i < MAX_LIVE_OBJECTS; i += 1) {
      emitJson("game-full", { type: "register" });
    }
    await vi.waitFor(() => {
      const acks = clientPayloads(ipc.send, "game-full").filter(
        (payload) =>
          payload &&
          typeof payload === "object" &&
          (payload as { type?: unknown }).type === "register_ack",
      );
      expect(acks).toHaveLength(MAX_LIVE_OBJECTS);
    });

    emitJson("game-full", { type: "register" });
    await vi.waitFor(() => {
      expect(latestPayload(ipc.send, "game-full", "register_nack")).toEqual({
        type: "register_nack",
        reason: "world_full",
        maxObjects: MAX_LIVE_OBJECTS,
      });
    });

    const acks = clientPayloads(ipc.send, "game-full").filter(
      (payload) =>
        payload &&
        typeof payload === "object" &&
        (payload as { type?: unknown }).type === "register_ack",
    ) as Array<{ objectId: number }>;
    for (const ack of acks) {
      emitJson("game-full", { type: "unregister", objectId: ack.objectId });
    }
    await vi.waitFor(() => {
      const unregisters = clientPayloads(ipc.send, "game-full").filter(
        (payload) =>
          payload &&
          typeof payload === "object" &&
          (payload as { type?: unknown }).type === "unregister_ack",
      );
      expect(unregisters).toHaveLength(MAX_LIVE_OBJECTS);
    });
  });

  it("broadcasts chat to every connected session", async () => {
    await join("game-chat-a");
    await join("game-chat-b");
    emitJson("game-chat-a", { type: "chat", text: "hello-board" });

    await vi.waitFor(() => {
      const expected = {
        type: "chat_broadcast",
        senderSessionId: "game-chat-a",
        text: "hello-board",
      };
      expect(clientPayloads(ipc.send, "game-chat-a")).toContainEqual(expected);
      expect(clientPayloads(ipc.send, "game-chat-b")).toContainEqual(expected);
    });
  });

  it("shares one world Buffer view on the 60Hz binary fan-out", async () => {
    await join("game-share-a");
    await join("game-share-b");
    emitJson("game-share-a", { type: "register" });
    ipc.send.mockClear();

    await vi.waitFor(() => {
      const frames = binarySends(ipc.send);
      const forA = binarySends(ipc.send, "game-share-a");
      const forB = binarySends(ipc.send, "game-share-b");
      expect(forA.length).toBeGreaterThan(0);
      expect(forB.length).toBeGreaterThan(0);
      expect(frames[0]?.buffer).toBe(frames[1]?.buffer);
      expect(frames[0]!.byteLength).toBeGreaterThanOrEqual(OBJECT_STRIDE * 4);
    });
  });
});
