import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  countLiveObjects,
  normalizeWorldBuffer,
  REDIS_WORLD_KEY,
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
import { openTestRedis, type TestRedis } from "./helpers/test-redis.js";

const harness: TestRedis | null = await openTestRedis();
const ipc = silenceAgentIpc();
if (harness) {
  process.env.AGENT_REDIS_URL = harness.url;
  await harness.redis.del(REDIS_WORLD_KEY);
  await import("../templates/game-sync/agent.js");
}

describe.skipIf(!harness)("game-sync agent against real Redis", () => {
  const sessions: string[] = [];

  afterEach(async () => {
    for (const sessionId of sessions.splice(0)) {
      await endSession(sessionId);
    }
    ipc.send.mockClear();
    await harness?.redis.del(REDIS_WORLD_KEY);
  });

  afterAll(async () => {
    await harness?.close();
  });

  it("register writes the object into the Redis world blob", async () => {
    ipc.send.mockClear();
    const sessionId = "game-redis-a";
    sessions.push(sessionId);
    await startSession(ipc.send, sessionId, {
      AGENT_REDIS_URL: harness!.url,
    });
    emitJson(sessionId, { type: "register" });

    await vi.waitFor(() => {
      const ack = clientPayloads(ipc.send, sessionId).find(
        (payload) =>
          payload &&
          typeof payload === "object" &&
          (payload as { type?: unknown }).type === "register_ack",
      ) as { objectId?: number } | undefined;
      expect(ack?.objectId).toEqual(expect.any(Number));
    });

    await vi.waitFor(async () => {
      const raw = await harness!.redis.getBuffer(REDIS_WORLD_KEY);
      expect(raw?.byteLength).toBeGreaterThan(0);
      expect(countLiveObjects(normalizeWorldBuffer(raw))).toBe(1);
    });

    await vi.waitFor(() => {
      expect(binarySends(ipc.send, sessionId).length).toBeGreaterThan(0);
    });
  });
});
