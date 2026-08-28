/**
 * Shared world buffer layout for game-sync (agent + unit tests).
 *
 * Fixed-size Float32Array: MAX_LIVE_OBJECTS slots × OBJECT_STRIDE floats each.
 * Slot layout: [objectId, posX, posY, posZ, posW, dirX, dirY, dirZ, dirW]
 * Empty slot: objectId === 0
 */
import { MAX_LIVE_OBJECTS } from "./game-sync-protocol.js";

export const OBJECT_STRIDE = 9;
export const WORLD_FLOAT_COUNT = MAX_LIVE_OBJECTS * OBJECT_STRIDE;
export const WORLD_BYTE_LENGTH = WORLD_FLOAT_COUNT * 4;
export const OBJECT_SLOT_BYTE_LENGTH = OBJECT_STRIDE * 4;

export const REDIS_WORLD_KEY = "game-sync:world";
export const REDIS_SIM_LOCK_KEY = "game-sync:sim-lock";

export function slotToObjectId(slot: number): number {
  return slot + 1;
}

export function objectIdToSlot(objectId: number): number {
  return objectId - 1;
}

export function createEmptyWorldBuffer(): Float32Array {
  return new Float32Array(WORLD_FLOAT_COUNT);
}

export function slotByteOffset(slot: number): number {
  return slot * OBJECT_SLOT_BYTE_LENGTH;
}

export function readSlotObjectId(world: Float32Array, slot: number): number {
  const id = world[slot * OBJECT_STRIDE];
  return Number.isFinite(id) ? id : 0;
}

export function countLiveObjects(world: Float32Array): number {
  let live = 0;
  for (let slot = 0; slot < MAX_LIVE_OBJECTS; slot += 1) {
    if (readSlotObjectId(world, slot) !== 0) {
      live += 1;
    }
  }
  return live;
}

export function findFirstEmptySlot(world: Float32Array): number | null {
  for (let slot = 0; slot < MAX_LIVE_OBJECTS; slot += 1) {
    if (readSlotObjectId(world, slot) === 0) {
      return slot;
    }
  }
  return null;
}

export function findSlotByObjectId(
  world: Float32Array,
  objectId: number,
): number | null {
  for (let slot = 0; slot < MAX_LIVE_OBJECTS; slot += 1) {
    if (readSlotObjectId(world, slot) === objectId) {
      return slot;
    }
  }
  return null;
}

export function markSlotFree(world: Float32Array, slot: number): void {
  const start = slot * OBJECT_STRIDE;
  for (let i = 0; i < OBJECT_STRIDE; i += 1) {
    world[start + i] = 0;
  }
}

export function encodeObjectSlot(
  objectId: number,
  posX: number,
  posY: number,
  posZ: number,
  posW: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  dirW: number,
): Buffer {
  const floats = new Float32Array([
    objectId,
    posX,
    posY,
    posZ,
    posW,
    dirX,
    dirY,
    dirZ,
    dirW,
  ]);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

export function writeObjectSlot(
  world: Float32Array,
  slot: number,
  objectId: number,
  posX: number,
  posY: number,
  posZ: number,
  posW: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  dirW: number,
): void {
  const start = slot * OBJECT_STRIDE;
  world[start] = objectId;
  world[start + 1] = posX;
  world[start + 2] = posY;
  world[start + 3] = posZ;
  world[start + 4] = posW;
  world[start + 5] = dirX;
  world[start + 6] = dirY;
  world[start + 7] = dirZ;
  world[start + 8] = dirW;
}

export function collectActiveObjectIds(world: Float32Array): number[] {
  const ids: number[] = [];
  for (let slot = 0; slot < MAX_LIVE_OBJECTS; slot += 1) {
    const objectId = readSlotObjectId(world, slot);
    if (objectId !== 0) {
      ids.push(objectId);
    }
  }
  return ids;
}

/**
 * Decode a Redis / Node Buffer into a fixed-size world Float32Array.
 */
export function normalizeWorldBuffer(
  raw: Uint8Array | null | undefined,
): Float32Array {
  if (!raw || raw.byteLength === 0) {
    return createEmptyWorldBuffer();
  }
  const bytes = Math.floor(raw.byteLength / 4) * 4;
  if (bytes === 0) {
    return createEmptyWorldBuffer();
  }
  const aligned = raw.buffer.slice(raw.byteOffset, raw.byteOffset + bytes);
  const decoded = new Float32Array(aligned);
  if (decoded.length === WORLD_FLOAT_COUNT) {
    return decoded;
  }
  const normalized = createEmptyWorldBuffer();
  normalized.set(
    decoded.subarray(0, Math.min(decoded.length, WORLD_FLOAT_COUNT)),
  );
  return normalized;
}

/** Float32 objectId bytes for Lua slot header splice (objectId 1..MAX_LIVE_OBJECTS). */
export function objectIdHeaderBytes(objectId: number): Buffer {
  const header = new Float32Array([objectId]);
  return Buffer.from(header.buffer, header.byteOffset, 4);
}
