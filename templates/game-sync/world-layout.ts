/**
 * Shared world buffer layout for game-sync (agent + unit tests).
 *
 * Fixed-size Float32Array: MAX_LIVE_OBJECTS slots × OBJECT_STRIDE floats each.
 * Slot layout: [objectId, posX, posY, posZ, posW, dirX, dirY, dirZ, dirW]
 * Empty slot: objectId === 0
 */
import { MAX_LIVE_OBJECTS } from "./protocol.js";
import {
  dequantize,
  dequantizeUnit,
  isQuantizable,
  quantize,
  quantizeUnit,
} from "./quantize.js";

export const OBJECT_STRIDE = 9;
export const WORLD_FLOAT_COUNT = MAX_LIVE_OBJECTS * OBJECT_STRIDE;
export const WORLD_BYTE_LENGTH = WORLD_FLOAT_COUNT * 4;
export const OBJECT_SLOT_BYTE_LENGTH = OBJECT_STRIDE * 4;

export const REDIS_WORLD_KEY = "game-sync:world";
export const REDIS_SIM_LOCK_KEY = "game-sync:sim-lock";
/** Redis time (ms) at which the stored world was last stepped; written with the world. */
export const REDIS_SIM_AT_KEY = "game-sync:sim-at";

/**
 * Broadcast frame (agent -> client, quantized int16; the Redis world stays float32):
 *   u8 format (2) · u8 version (1) · u16le objectCount · objectCount x 18 B
 *   record = u16le objectId · 8 x i16le [posX posY posZ posW dirX dirY dirZ dirW]
 * Live objects only. Bounds below: x in [0, BOARD_X_MAX], y in [0, BOARD_Y_MAX] (they equal
 * BOARD_WIDTH / BOARD_HEIGHT in sim.ts), dirX/dirY (velocity, px/s) in [-VELOCITY_LIMIT,
 * VELOCITY_LIMIT]; z, w and dirZ/dirW are unit components (round(v x 32767)).
 * Matching test vectors: templates/redis-sync/quantized-frames.vectors.json, `gameSync`.
 */
export const FRAME_FORMAT_QUANTIZED = 2;
export const FRAME_VERSION = 1;
export const FRAME_HEADER_BYTES = 4;
export const FRAME_RECORD_BYTES = 18;
export const MAX_FRAME_BYTES =
  FRAME_HEADER_BYTES + MAX_LIVE_OBJECTS * FRAME_RECORD_BYTES;
export const BOARD_X_MAX = 1280;
export const BOARD_Y_MAX = 720;
/**
 * Elastic collisions can pass energy to one object (about 900 px/s with 25 objects), so the
 * range is 1024; a component beyond it is clamped and counted ({@link getClampedComponentCount}).
 */
export const VELOCITY_LIMIT = 1024;

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

/**
 * Allocation-free variant for the sim loop: writes live object ids into `dest`
 * (capacity >= MAX_LIVE_OBJECTS) and returns how many were written.
 */
export function collectActiveObjectIdsInto(
  world: Float32Array,
  dest: Int32Array,
): number {
  let count = 0;
  const limit = Math.min(MAX_LIVE_OBJECTS, dest.length);
  for (let slot = 0; slot < MAX_LIVE_OBJECTS && count < limit; slot += 1) {
    const objectId = readSlotObjectId(world, slot);
    if (objectId !== 0) {
      dest[count] = objectId;
      count += 1;
    }
  }
  return count;
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
  const destBytes = new Uint8Array(
    dest.buffer,
    dest.byteOffset,
    dest.byteLength,
  );
  if (!raw || raw.byteLength === 0) {
    destBytes.fill(0);
    return dest;
  }
  const byteCount = Math.min(
    Math.floor(raw.byteLength / 4) * 4,
    destBytes.byteLength,
  );
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

/** Thrown for a frame with an unknown format or version byte, or a bad length. Never guessed. */
export class WorldFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldFrameError";
  }
}

export type DecodedObject = {
  objectId: number;
  /** Raw quantized [posX posY posZ posW dirX dirY dirZ dirW]. */
  q: number[];
};

/** Objects dropped by {@link encodeLiveObjectsInto} for a non-finite component. */
let invalidObjectDrops = 0;
/** Components {@link encodeLiveObjectsInto} clamped to their quantization range. */
let clampedComponents = 0;

export function getClampedComponentCount(): number {
  return clampedComponents;
}

function quantizeCounted(v: number, min: number, max: number): number {
  if (v < min || v > max) clampedComponents += 1;
  return quantize(v, min, max);
}

function quantizeUnitCounted(v: number): number {
  if (v < -1 || v > 1) clampedComponents += 1;
  return quantizeUnit(v);
}

export function invalidObjectDropCount(): number {
  return invalidObjectDrops;
}

function writeI16(dest: Uint8Array, offset: number, v: number): void {
  dest[offset] = v & 0xff;
  dest[offset + 1] = (v >> 8) & 0xff;
}

function readI16(src: Uint8Array, offset: number): number {
  const v = src[offset]! | (src[offset + 1]! << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
}

function slotIsQuantizable(world: Float32Array, start: number): boolean {
  for (let i = 1; i < OBJECT_STRIDE; i += 1) {
    if (!isQuantizable(world[start + i]!)) return false;
  }
  return true;
}

/**
 * Quantize every live slot of `world` into `dest` (capacity >= MAX_FRAME_BYTES) and return
 * the frame length. No allocation. A live slot with a non-finite component is dropped and
 * counted ({@link invalidObjectDropCount}); it is never encoded.
 */
export function encodeLiveObjectsInto(
  dest: Uint8Array,
  world: Float32Array,
): number {
  let count = 0;
  let at = FRAME_HEADER_BYTES;
  for (let slot = 0; slot < MAX_LIVE_OBJECTS; slot += 1) {
    const start = slot * OBJECT_STRIDE;
    const objectId = readSlotObjectId(world, slot);
    if (objectId === 0) continue;
    if (!slotIsQuantizable(world, start)) {
      invalidObjectDrops += 1;
      continue;
    }
    dest[at] = objectId & 0xff;
    dest[at + 1] = (objectId >> 8) & 0xff;
    writeI16(dest, at + 2, quantizeCounted(world[start + 1]!, 0, BOARD_X_MAX));
    writeI16(dest, at + 4, quantizeCounted(world[start + 2]!, 0, BOARD_Y_MAX));
    writeI16(dest, at + 6, quantizeUnitCounted(world[start + 3]!));
    writeI16(dest, at + 8, quantizeUnitCounted(world[start + 4]!));
    writeI16(
      dest,
      at + 10,
      quantizeCounted(world[start + 5]!, -VELOCITY_LIMIT, VELOCITY_LIMIT),
    );
    writeI16(
      dest,
      at + 12,
      quantizeCounted(world[start + 6]!, -VELOCITY_LIMIT, VELOCITY_LIMIT),
    );
    writeI16(dest, at + 14, quantizeUnitCounted(world[start + 7]!));
    writeI16(dest, at + 16, quantizeUnitCounted(world[start + 8]!));
    at += FRAME_RECORD_BYTES;
    count += 1;
  }
  dest[0] = FRAME_FORMAT_QUANTIZED;
  dest[1] = FRAME_VERSION;
  dest[2] = count & 0xff;
  dest[3] = (count >> 8) & 0xff;
  return at;
}

export function decodeLiveObjectsFrame(data: Uint8Array): DecodedObject[] {
  if (data.byteLength < FRAME_HEADER_BYTES) {
    throw new WorldFrameError(`frame too short: ${data.byteLength} bytes`);
  }
  if (data[0] !== FRAME_FORMAT_QUANTIZED) {
    throw new WorldFrameError(`unknown frame format ${data[0]}`);
  }
  if (data[1] !== FRAME_VERSION) {
    throw new WorldFrameError(`unknown frame version ${data[1]}`);
  }
  const count = data[2]! | (data[3]! << 8);
  if (data.byteLength !== FRAME_HEADER_BYTES + count * FRAME_RECORD_BYTES) {
    throw new WorldFrameError(
      `frame length ${data.byteLength} does not match objectCount ${count}`,
    );
  }
  const objects: DecodedObject[] = [];
  for (let i = 0; i < count; i += 1) {
    const o = FRAME_HEADER_BYTES + i * FRAME_RECORD_BYTES;
    const q: number[] = [];
    for (let c = 0; c < 8; c += 1) q.push(readI16(data, o + 2 + c * 2));
    objects.push({ objectId: data[o]! | (data[o + 1]! << 8), q });
  }
  return objects;
}

/** Dequantize raw components to [posX posY posZ posW dirX dirY dirZ dirW]. */
export function dequantizeObject(q: readonly number[]): number[] {
  return [
    dequantize(q[0]!, 0, BOARD_X_MAX),
    dequantize(q[1]!, 0, BOARD_Y_MAX),
    dequantizeUnit(q[2]!),
    dequantizeUnit(q[3]!),
    dequantize(q[4]!, -VELOCITY_LIMIT, VELOCITY_LIMIT),
    dequantize(q[5]!, -VELOCITY_LIMIT, VELOCITY_LIMIT),
    dequantizeUnit(q[6]!),
    dequantizeUnit(q[7]!),
  ];
}

/** A step is skipped when less than half a 60 Hz interval has passed since the stored sim-at. */
export const SIM_STEP_MIN_MS = Math.floor(1000 / 60) / 2;
export const SIM_STEP_MAX_SEC = 0.05;

/**
 * dt (s) to step from the stored sim-at, or null to skip. No lower clamp, so the sum of
 * dt equals Redis wall time whatever the timer jitter. No stored sim-at: one interval.
 */
export function planRedisStepDtSec(
  simAtMs: number,
  nowMs: number,
): number | null {
  if (simAtMs === 0) return 1 / 60;
  const elapsed = nowMs - simAtMs;
  if (elapsed < SIM_STEP_MIN_MS) return null;
  return Math.min(SIM_STEP_MAX_SEC, elapsed / 1000);
}
