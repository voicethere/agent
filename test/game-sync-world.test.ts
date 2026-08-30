import { describe, expect, it } from "vitest";

import { MAX_LIVE_OBJECTS } from "../templates/game-sync-protocol.js";
import {
  simulateWorldStep,
  OBJECT_RADIUS,
} from "../templates/game-sync-sim.js";
import {
  countLiveObjects,
  commitSimulatedWorld,
  createEmptyWorldBuffer,
  findFirstEmptySlot,
  markSlotFree,
  preserveEmptySlots,
  readSlotObjectId,
  slotToObjectId,
  writeObjectSlot,
} from "../templates/game-sync-world-layout.js";

function registerInMemory(world: Float32Array, slot: number): number {
  const objectId = slotToObjectId(slot);
  writeObjectSlot(world, slot, objectId, 100, 100, 0, 1, 120, 80, 0, 0);
  return objectId;
}

describe("game-sync world layout", () => {
  it("countLiveObjects returns 0 on empty world", () => {
    const world = createEmptyWorldBuffer();
    expect(countLiveObjects(world)).toBe(0);
    expect(findFirstEmptySlot(world)).toBe(0);
  });

  it("allocate rejects at MAX_LIVE_OBJECTS", () => {
    const world = createEmptyWorldBuffer();
    for (let slot = 0; slot < MAX_LIVE_OBJECTS; slot += 1) {
      registerInMemory(world, slot);
    }
    expect(countLiveObjects(world)).toBe(MAX_LIVE_OBJECTS);
    expect(findFirstEmptySlot(world)).toBeNull();
  });

  it("release frees a slot so register works again", () => {
    const world = createEmptyWorldBuffer();
    for (let slot = 0; slot < MAX_LIVE_OBJECTS; slot += 1) {
      registerInMemory(world, slot);
    }
    markSlotFree(world, 3);
    expect(countLiveObjects(world)).toBe(MAX_LIVE_OBJECTS - 1);
    expect(findFirstEmptySlot(world)).toBe(3);
    expect(readSlotObjectId(world, 3)).toBe(0);

    registerInMemory(world, 3);
    expect(countLiveObjects(world)).toBe(MAX_LIVE_OBJECTS);
    expect(readSlotObjectId(world, 3)).toBe(slotToObjectId(3));
  });

  it("preserveEmptySlots keeps Lua-released slots empty after sim (Redis tick race)", () => {
    const latestRedis = createEmptyWorldBuffer();
    registerInMemory(latestRedis, 2);
    expect(countLiveObjects(latestRedis)).toBe(1);

    const simulated = new Float32Array(latestRedis);
    markSlotFree(latestRedis, 2);
    expect(countLiveObjects(latestRedis)).toBe(0);

    preserveEmptySlots(simulated, latestRedis);
    expect(countLiveObjects(simulated)).toBe(0);
    expect(readSlotObjectId(simulated, 2)).toBe(0);
  });

  it("preserveEmptySlots with empty authoritative zeros every simulated slot", () => {
    const simulated = createEmptyWorldBuffer();
    registerInMemory(simulated, 0);
    registerInMemory(simulated, 4);
    expect(countLiveObjects(simulated)).toBe(2);

    preserveEmptySlots(simulated, createEmptyWorldBuffer());
    expect(countLiveObjects(simulated)).toBe(0);
  });

  it("commitSimulatedWorld keeps Redis-empty slots empty while keeping other sim positions", () => {
    const latestRedis = createEmptyWorldBuffer();
    registerInMemory(latestRedis, 0);

    const simulated = createEmptyWorldBuffer();
    registerInMemory(simulated, 0);
    registerInMemory(simulated, 2);
    simulated[1] = 999;
    simulated[10] = 888;

    markSlotFree(latestRedis, 2);

    commitSimulatedWorld(simulated, latestRedis);

    expect(readSlotObjectId(simulated, 0)).toBe(slotToObjectId(0));
    expect(simulated[1]).toBe(999);
    expect(readSlotObjectId(simulated, 2)).toBe(0);
    expect(simulated[10]).toBe(0);
  });
});

describe("game-sync simulation", () => {
  it("simulateWorldStep bounces off the left wall", () => {
    const world = createEmptyWorldBuffer();
    writeObjectSlot(world, 0, 1, OBJECT_RADIUS, 200, 0, 1, -200, 0, 0, 0);

    simulateWorldStep(world, 1, [1]);

    expect(world[1]).toBeGreaterThanOrEqual(OBJECT_RADIUS);
    expect(world[5]).toBeGreaterThan(0);
  });
});
