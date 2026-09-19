/**
 * Shared world buffer layout for game-sync (agent + unit tests).
 *
 * Fixed-size Float32Array: MAX_LIVE_OBJECTS slots × OBJECT_STRIDE floats each.
 * Slot layout: [objectId, posX, posY, posZ, posW, dirX, dirY, dirZ, dirW]
 * Empty slot: objectId === 0
 */
import { MAX_LIVE_OBJECTS } from "./protocol.js";

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

const OBJECT_SLOT_SCRATCH = new Float32Array(OBJECT_STRIDE);
const OBJECT_SLOT_SCRATCH_BUF = Buffer.from(
  OBJECT_SLOT_SCRATCH.buffer,
  OBJECT_SLOT_SCRATCH.byteOffset,
  OBJECT_SLOT_BYTE_LENGTH,
);

/** Shared 9-float slot buffer (overwritten on the next call). */
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
  OBJECT_SLOT_SCRATCH[0] = objectId;
  OBJECT_SLOT_SCRATCH[1] = posX;
  OBJECT_SLOT_SCRATCH[2] = posY;
  OBJECT_SLOT_SCRATCH[3] = posZ;
  OBJECT_SLOT_SCRATCH[4] = posW;
  OBJECT_SLOT_SCRATCH[5] = dirX;
  OBJECT_SLOT_SCRATCH[6] = dirY;
  OBJECT_SLOT_SCRATCH[7] = dirZ;
  OBJECT_SLOT_SCRATCH[8] = dirW;
  return OBJECT_SLOT_SCRATCH_BUF;
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

/**
 * After simulating from a Redis load, keep slots empty that a concurrent release
 * zeroed in Redis while the tick was in flight — prevents saveWorldToRedis from
 * restoring an object Lua just cleared (sim GET → simulate → SET race).
 *
 * `authoritative` must be a fresh Redis GET after simulate (never stale in-memory
 * worldState — an empty buffer would wipe every live slot).
 */
export function preserveEmptySlots(
  simulated: Float32Array,
  authoritative: Float32Array,
): void {
  for (let slot = 0; slot < MAX_LIVE_OBJECTS; slot += 1) {
    if (readSlotObjectId(authoritative, slot) === 0) {
      markSlotFree(simulated, slot);
    }
  }
}

/** Merge a simulated world with the latest Redis snapshot before SET. */
export function commitSimulatedWorld(
  simulated: Float32Array,
  latestRedis: Float32Array,
): void {
  preserveEmptySlots(simulated, latestRedis);
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

export interface LiveWorldObjectInfo {
  objectId: number;
  ownerSessionId: string;
}

/** Snapshot occupancy from live world slots; ownerSessionId from map or empty string. */
export function liveWorldSnapshot(
  world: Float32Array,
  owners: ReadonlyMap<number, string>,
): LiveWorldObjectInfo[] {
  const ids = collectActiveObjectIds(world);
  ids.sort((a, b) => a - b);
  return ids.map((objectId) => ({
    objectId,
    ownerSessionId: owners.get(objectId) ?? "",
  }));
}

export function planRedisSimTick(options: {
  lockAcquired: boolean;
  connectedSessions: ReadonlySet<string>;
}): "simulate" | "relay" | "noop" {
  if (options.lockAcquired) {
    return "simulate";
  }
  if (options.connectedSessions.size > 0) {
    return "relay";
  }
  return "noop";
}

/** Finite positive elapsed seconds, clamped to [1/fallbackHz, 0.05]. */
export function clampSimulationDtSec(
  elapsedMs: number,
  fallbackHz: number,
): number {
  const minDt = 1 / fallbackHz;
  const maxDt = 0.05;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return minDt;
  }
  const elapsedSec = elapsedMs / 1000;
  return Math.min(maxDt, Math.max(minDt, elapsedSec));
}

/**
 * Copy Redis / Node Buffer bytes into `dest` (default: a new world).
 *
 * Node Buffer pools can have `byteOffset` not divisible by 4, so we copy via
 * a Uint8Array view onto `dest` instead of slicing a new ArrayBuffer.
 */
export function normalizeWorldBuffer(
  raw: Uint8Array | null | undefined,
  dest: Float32Array = createEmptyWorldBuffer(),
): Float32Array {
  const destBytes = new Uint8Array(dest.buffer, dest.byteOffset, dest.byteLength);
  if (!raw || raw.byteLength === 0) {
    destBytes.fill(0);
    return dest;
  }
  const byteCount = Math.min(Math.floor(raw.byteLength / 4) * 4, destBytes.byteLength);
  if (byteCount > 0) {
    destBytes.set(raw.subarray(0, byteCount));
  }
  if (byteCount < destBytes.byteLength) {
    destBytes.fill(0, byteCount);
  }
  return dest;
}

/** Concatenated float32 objectId headers (1..MAX_LIVE_OBJECTS), one allocation. */
export const OBJECT_ID_HEADERS_BLOB = (() => {
  const blob = Buffer.alloc(MAX_LIVE_OBJECTS * 4);
  for (let objectId = 1; objectId <= MAX_LIVE_OBJECTS; objectId += 1) {
    blob.writeFloatLE(objectId, (objectId - 1) * 4);
  }
  return blob;
})();

/** View into {@link OBJECT_ID_HEADERS_BLOB} for Lua slot header splice. */
export function objectIdHeaderBytes(objectId: number): Buffer {
  const index = objectId - 1;
  return OBJECT_ID_HEADERS_BLOB.subarray(index * 4, index * 4 + 4);
}
