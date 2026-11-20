import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import {
  LUA_ALLOCATE_OBJECT,
  LUA_COMMIT_WORLD,
  LUA_READ_WORLD,
  LUA_RELEASE_LOCK,
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
  encodeSlotInto,
  normalizeWorldBuffer as normalizeRedisSyncWorld,
  readPeerSlot,
  slotOffset,
  SLOT_BYTES,
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

const LOCK_TOKEN = "test-token";

/** The scripts only write while the lock key holds the caller's token. */
async function takeLock(key: string, token = LOCK_TOKEN): Promise<string> {
  skipWithoutRedis();
  const lockKey = `${key}:lock`;
  await harness!.redis.set(lockKey, token, "PX", 60_000);
  return lockKey;
}

async function allocate(
  key: string,
  posX: number,
  posY: number,
  token = LOCK_TOKEN,
): Promise<number> {
  skipWithoutRedis();
  const result = await harness!.redis.eval(
    LUA_ALLOCATE_OBJECT,
    2,
    key,
    `${key}:lock`,
    String(WORLD_BYTE_LENGTH),
    String(OBJECT_SLOT_BYTE_LENGTH),
    String(MAX_LIVE_OBJECTS),
    objectTail(posX, posY),
    OBJECT_ID_HEADERS_BLOB,
    token,
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
    await takeLock(key);
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
    await takeLock(key);
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
        2,
        key,
        `${key}:lock`,
        String(WORLD_BYTE_LENGTH),
        String(OBJECT_SLOT_BYTE_LENGTH),
        String(MAX_LIVE_OBJECTS),
        String(ids[0]),
        OBJECT_ID_HEADERS_BLOB,
        LOCK_TOKEN,
      ),
    );
    expect(released).toBe(1);
    expect(await allocate(key, 80, 90)).toBe(ids[0]);
  });

  it("allocate and release write nothing when the lock holds another token", async () => {
    skipWithoutRedis();
    const key = `test:game-sync:${randomUUID()}`;
    await takeLock(key, "someone-else");
    expect(await allocate(key, 40, 50)).toBe(-3);
    expect(await harness!.redis.exists(key)).toBe(0);

    await takeLock(key);
    const id = await allocate(key, 40, 50);
    expect(id).toBeGreaterThan(0);
    await takeLock(key, "someone-else");
    const before = await harness!.redis.getBuffer(key);
    const released = Number(
      await harness!.redis.eval(
        LUA_RELEASE_OBJECT,
        2,
        key,
        `${key}:lock`,
        String(WORLD_BYTE_LENGTH),
        String(OBJECT_SLOT_BYTE_LENGTH),
        String(MAX_LIVE_OBJECTS),
        String(id),
        OBJECT_ID_HEADERS_BLOB,
        LOCK_TOKEN,
      ),
    );
    expect(released).toBe(-3);
    expect(await harness!.redis.getBuffer(key)).toEqual(before);
  });

  it("release-lock deletes only the holder's own token", async () => {
    skipWithoutRedis();
    const lockKey = `test:game-sync:${randomUUID()}:lock`;
    await harness!.redis.set(lockKey, "holder-b", "PX", 60_000);
    expect(
      Number(
        await harness!.redis.eval(LUA_RELEASE_LOCK, 1, lockKey, "holder-a"),
      ),
    ).toBe(0);
    expect(await harness!.redis.get(lockKey)).toBe("holder-b");
    expect(
      Number(
        await harness!.redis.eval(LUA_RELEASE_LOCK, 1, lockKey, "holder-b"),
      ),
    ).toBe(1);
    expect(await harness!.redis.get(lockKey)).toBeNull();
  });

  it("commit writes world and sim-at together only while the token holds the lock", async () => {
    skipWithoutRedis();
    const base = `test:game-sync:${randomUUID()}`;
    const [lockKey, worldKey, simAtKey] = [`${base}:lock`, base, `${base}:at`];
    const commit = async (token: string, bytes: string, at: string) =>
      Number(
        await harness!.redis.eval(
          LUA_COMMIT_WORLD,
          3,
          lockKey,
          worldKey,
          simAtKey,
          token,
          bytes,
          at,
        ),
      );
    await harness!.redis.set(lockKey, "holder-b", "PX", 60_000);
    expect(await commit("holder-a", "stale", "1")).toBe(0);
    expect(await harness!.redis.exists(worldKey, simAtKey)).toBe(0);

    expect(await commit("holder-b", "fresh", "2")).toBe(1);
    expect(await harness!.redis.get(worldKey)).toBe("fresh");
    expect(await harness!.redis.get(simAtKey)).toBe("2");
  });

  it("read returns the world, the stored sim-at and Redis' own clock", async () => {
    skipWithoutRedis();
    const base = `test:game-sync:${randomUUID()}`;
    const read = async () =>
      (await harness!.redis.callBuffer(
        "EVAL",
        LUA_READ_WORLD,
        2,
        base,
        `${base}:at`,
      )) as Buffer[];
    const empty = await read();
    expect(empty[0]!.byteLength).toBe(0);
    expect(empty[1]!.byteLength).toBe(0);
    await harness!.redis.set(base, Buffer.from([0, 255, 7]));
    await harness!.redis.set(`${base}:at`, "12345");
    const [world, simAt, now] = await read();
    expect([...world!]).toEqual([0, 255, 7]);
    expect(simAt!.toString()).toBe("12345");
    // Epoch milliseconds from Redis TIME, as a plain integer string.
    expect(now!.toString()).toMatch(/^1\d{12}$/);
  });

  it("SETRANGE writes two redis-sync peer slots concurrently without clobber", async () => {
    skipWithoutRedis();
    const key = `test:redis-sync:${randomUUID()}`;
    await Promise.all(
      [
        [0, 1.5, 2.5],
        [3, 7, 8],
      ].map(([index, x, y]) =>
        harness!.redis.setrange(
          key,
          slotOffset(index!),
          Buffer.from(
            encodeSlotInto(new Uint8Array(SLOT_BYTES), index!, x!, y!, 1),
          ),
        ),
      ),
    );

    const raw = await harness!.redis.getBuffer(key);
    // SETRANGE pads with zeros up to the last slot written; the pod zero-pads the rest.
    expect(raw?.byteLength).toBe(4 * SLOT_BYTES);
    const world = normalizeRedisSyncWorld(
      raw,
      new Uint8Array(REDIS_SYNC_WORLD_BYTE_LENGTH),
    );
    expect(readPeerSlot(world, 0)?.x).toBeCloseTo(1.5, 1);
    expect(readPeerSlot(world, 0)?.y).toBeCloseTo(2.5, 1);
    expect(readPeerSlot(world, 3)?.x).toBeCloseTo(7, 1);
    expect(readPeerSlot(world, 3)?.y).toBeCloseTo(8, 1);
    expect(readPeerSlot(world, 1)).toBeNull();
    await harness!.redis.del(key);
  });

  it("increments the webhooks-redis counter atomically", async () => {
    skipWithoutRedis();
    const key = `test:webhook:${randomUUID()}`;
    const counts = await Promise.all(
      Array.from({ length: 8 }, () =>
        harness!.redis.eval(LUA_INCREMENT_COUNTER, 1, key),
      ),
    );
    expect(counts.map((n) => Number(n)).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });
});
