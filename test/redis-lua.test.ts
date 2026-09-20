import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import {
  LUA_ALLOCATE_OBJECT,
  LUA_RELEASE_OBJECT,
  OBJECT_ID_HEADERS_BLOB,
} from "../templates/game-sync/redis.js";
import { MAX_LIVE_OBJECTS } from "../templates/game-sync/protocol.js";
import {
  countLiveObjects,
  normalizeWorldBuffer,
  OBJECT_SLOT_BYTE_LENGTH,
  readSlotObjectId,
  WORLD_BYTE_LENGTH,
} from "../templates/game-sync/world-layout.js";
import {
  LUA_PATCH_PEER_SLOT,
  normalizeWorldBuffer as normalizeRedisSyncWorld,
  peerSlotOffset,
  PEER_FIELD_ACTIVE,
  PEER_FIELD_INDEX,
  PEER_FIELD_X,
  PEER_FIELD_Y,
  PEER_SLOT_BYTE_LENGTH,
  readPeerSlot,
  WORLD_BYTE_LENGTH as REDIS_SYNC_WORLD_BYTE_LENGTH,
} from "../templates/redis-sync/world-layout.js";
import { silenceAgentIpc } from "./helpers/agent-ipc.js";
import { openTestRedis, type TestRedis } from "./helpers/test-redis.js";

silenceAgentIpc();
const { LUA_INCREMENT_COUNTER } =
  await import("../templates/webhooks-redis/agent.js");

const harness: TestRedis | null = await openTestRedis();

function skipWithoutRedis(): void {
  if (!harness) {
    throw new Error(
      "unreachable: describe.skipIf should have skipped Redis tests",
    );
  }
}

function objectTail(posX: number, posY: number): Buffer {
  const tail = new Float32Array([posX, posY, 0, 1, 10, 20, 0, 0]);
  return Buffer.from(tail.buffer, tail.byteOffset, tail.byteLength);
}

function peerSlot(
  clientIndex: number,
  x: number,
  y: number,
  active: number,
): Buffer {
  const slot = new Float32Array([clientIndex, x, y, active]);
  return Buffer.from(slot.buffer, slot.byteOffset, slot.byteLength);
}

async function allocate(
  key: string,
  posX: number,
  posY: number,
): Promise<number> {
  skipWithoutRedis();
  const result = await harness!.redis.eval(
    LUA_ALLOCATE_OBJECT,
    1,
    key,
    String(WORLD_BYTE_LENGTH),
    String(OBJECT_SLOT_BYTE_LENGTH),
    String(MAX_LIVE_OBJECTS),
    objectTail(posX, posY),
    OBJECT_ID_HEADERS_BLOB,
  );
  return Number(result);
}

describe.skipIf(!harness)("world Lua against real Redis", () => {
  afterAll(async () => {
    await harness?.close();
  });

  it("allocates distinct slots under concurrent EVAL", async () => {
    skipWithoutRedis();
    const key = `test:game-sync:${randomUUID()}`;
    const [first, second] = await Promise.all([
      allocate(key, 40, 50),
      allocate(key, 60, 70),
    ]);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
    expect(first).not.toBe(second);

    const raw = await harness!.redis.getBuffer(key);
    const world = normalizeWorldBuffer(raw);
    expect(countLiveObjects(world)).toBe(2);
    expect(readSlotObjectId(world, first - 1)).toBe(first);
    expect(readSlotObjectId(world, second - 1)).toBe(second);
  });

  it("returns -1 once MAX_LIVE_OBJECTS are live and recycles after release", async () => {
    skipWithoutRedis();
    const key = `test:game-sync:${randomUUID()}`;
    const ids: number[] = [];
    for (let i = 0; i < MAX_LIVE_OBJECTS; i += 1) {
      ids.push(await allocate(key, 10, 10));
    }
    expect(ids).toHaveLength(MAX_LIVE_OBJECTS);
    expect(new Set(ids).size).toBe(MAX_LIVE_OBJECTS);
    expect(await allocate(key, 10, 10)).toBe(-1);

    const released = Number(
      await harness!.redis.eval(
        LUA_RELEASE_OBJECT,
        1,
        key,
        String(WORLD_BYTE_LENGTH),
        String(OBJECT_SLOT_BYTE_LENGTH),
        String(MAX_LIVE_OBJECTS),
        String(ids[0]),
        OBJECT_ID_HEADERS_BLOB,
      ),
    );
    expect(released).toBe(1);
    expect(await allocate(key, 80, 90)).toBe(ids[0]);
  });

  it("patches two redis-sync peer slots concurrently without clobber", async () => {
    skipWithoutRedis();
    const key = `test:redis-sync:${randomUUID()}`;
    await Promise.all([
      harness!.redis.eval(
        LUA_PATCH_PEER_SLOT,
        1,
        key,
        String(peerSlotOffset(0) * 4),
        peerSlot(0, 1.5, 2.5, 1),
        String(REDIS_SYNC_WORLD_BYTE_LENGTH),
      ),
      harness!.redis.eval(
        LUA_PATCH_PEER_SLOT,
        1,
        key,
        String(peerSlotOffset(3) * 4),
        peerSlot(3, 7, 8, 1),
        String(REDIS_SYNC_WORLD_BYTE_LENGTH),
      ),
    ]);

    const raw = await harness!.redis.getBuffer(key);
    expect(raw?.byteLength).toBe(REDIS_SYNC_WORLD_BYTE_LENGTH);
    expect(raw?.byteLength).toBeGreaterThanOrEqual(PEER_SLOT_BYTE_LENGTH);
    const world = normalizeRedisSyncWorld(raw);
    expect(readPeerSlot(world, 0)).toEqual({
      clientIndex: 0,
      x: 1.5,
      y: 2.5,
      active: 1,
    });
    expect(readPeerSlot(world, 3)).toEqual({
      clientIndex: 3,
      x: 7,
      y: 8,
      active: 1,
    });
    expect(world[PEER_FIELD_INDEX]).toBe(0);
    expect(world[PEER_FIELD_X]).toBe(1.5);
    expect(world[PEER_FIELD_Y]).toBe(2.5);
    expect(world[PEER_FIELD_ACTIVE]).toBe(1);
  });

  it("increments the webhooks-redis counter atomically", async () => {
    skipWithoutRedis();
    const key = `test:webhook:${randomUUID()}`;
    const counts = await Promise.all(
      Array.from({ length: 8 }, () =>
        harness!.redis.eval(LUA_INCREMENT_COUNTER, 1, key),
      ),
    );
    expect(
      counts.map((n) => Number(n)).sort((a, b) => a - b),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
