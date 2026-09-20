/**
 * Shared world buffer layout for redis-sync template (agent + E2E helpers).
 *
 * One Float32Array backs the full multiplayer state in Redis:
 *   peer slot = clientIndex * PEER_STRIDE
 *   [clientIndex, x, y, active]
 *
 * active: 1 = present, 0 = left / empty slot
 */
export const MAX_PEERS = 128;
export const PEER_STRIDE = 4;
export const WORLD_FLOAT_COUNT = MAX_PEERS * PEER_STRIDE;
export const WORLD_BYTE_LENGTH = WORLD_FLOAT_COUNT * 4;
export const PEER_SLOT_BYTE_LENGTH = PEER_STRIDE * 4;

export const PEER_FIELD_INDEX = 0;
export const PEER_FIELD_X = 1;
export const PEER_FIELD_Y = 2;
export const PEER_FIELD_ACTIVE = 3;

/** Client → agent position frame: float32le [clientIndex, x, y] (12 bytes). */
export const POSITION_FLOAT_COUNT = 3;
export const POSITION_BYTE_LENGTH = POSITION_FLOAT_COUNT * 4;

export type PeerPosition = {
  clientIndex: number;
  x: number;
  y: number;
};

export const REDIS_WORLD_KEY = "e2e:redis-sync:world";

/** Atomic splice of one peer slot (16 bytes) into the world blob. */
export const LUA_PATCH_PEER_SLOT = `
local key = KEYS[1]
local offset = tonumber(ARGV[1])
local slot = ARGV[2]
local size = tonumber(ARGV[3])
local world = redis.call('GET', key)
if not world then
  world = string.rep(string.char(0), size)
elseif #world < size then
  world = world .. string.rep(string.char(0), size - #world)
elseif #world > size then
  world = string.sub(world, 1, size)
end
world = string.sub(world, 1, offset) .. slot .. string.sub(world, offset + #slot + 1)
redis.call('SET', key, world)
return size
`;

export type PeerSlot = {
  clientIndex: number;
  x: number;
  y: number;
  active: number;
};

export function peerSlotOffset(clientIndex: number): number {
  return clientIndex * PEER_STRIDE;
}

export function createEmptyWorldBuffer(): Float32Array {
  return new Float32Array(WORLD_FLOAT_COUNT);
}

export function writePeerSlot(
  world: Float32Array,
  clientIndex: number,
  x: number,
  y: number,
  active: number,
): void {
  const offset = peerSlotOffset(clientIndex);
  world[offset + PEER_FIELD_INDEX] = clientIndex;
  world[offset + PEER_FIELD_X] = x;
  world[offset + PEER_FIELD_Y] = y;
  world[offset + PEER_FIELD_ACTIVE] = active;
}

export function clearPeerSlot(world: Float32Array, clientIndex: number): void {
  writePeerSlot(world, clientIndex, 0, 0, 0);
}

function asDataView(data: ArrayBufferLike | ArrayBufferView): DataView {
  if (ArrayBuffer.isView(data)) {
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  return new DataView(data);
}

/** Decode a 12-byte inbound position frame. */
export function decodePositionBuffer(
  data: ArrayBufferLike | ArrayBufferView | null | undefined,
): PeerPosition | null {
  if (data == null) {
    return null;
  }
  const view = asDataView(data);
  if (view.byteLength < POSITION_BYTE_LENGTH) {
    return null;
  }
  const clientIndex = view.getFloat32(0, true);
  const x = view.getFloat32(4, true);
  const y = view.getFloat32(8, true);
  if (
    !Number.isFinite(clientIndex) ||
    clientIndex < 0 ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    return null;
  }
  return { clientIndex: Math.trunc(clientIndex), x, y };
}

/** Write [clientIndex, x, y] into `dest` (length >= 3) and return it. */
export function encodePositionInto(
  dest: Float32Array,
  clientIndex: number,
  x: number,
  y: number,
): Float32Array {
  dest[0] = clientIndex;
  dest[1] = x;
  dest[2] = y;
  return dest;
}

export function readPeerSlot(
  world: Float32Array,
  clientIndex: number,
): PeerSlot | null {
  const offset = peerSlotOffset(clientIndex);
  const active = world[offset + PEER_FIELD_ACTIVE];
  if (active !== 1) {
    return null;
  }
  return {
    clientIndex: world[offset + PEER_FIELD_INDEX],
    x: world[offset + PEER_FIELD_X],
    y: world[offset + PEER_FIELD_Y],
    active,
  };
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

export function decodeWorldBuffer(
  data: ArrayBuffer,
  dest: Float32Array = createEmptyWorldBuffer(),
): Float32Array {
  return normalizeWorldBuffer(new Uint8Array(data), dest);
}

/** Same backing ArrayBuffer when the world is a standalone Float32Array. */
export function worldBufferToArrayBuffer(world: Float32Array): ArrayBuffer {
  if (world.byteOffset === 0 && world.byteLength === world.buffer.byteLength) {
    return world.buffer as ArrayBuffer;
  }
  return world.buffer.slice(
    world.byteOffset,
    world.byteOffset + world.byteLength,
  ) as ArrayBuffer;
}
