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

export const REDIS_WORLD_KEY = "e2e:redis-sync:world";

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
 * Decode a Redis / Node Buffer (or any Uint8Array) into a world Float32Array.
 *
 * Node Buffer pools often hand out views whose `byteOffset` is not a multiple of
 * 4. `new Float32Array(buf.buffer, buf.byteOffset, …)` then throws:
 *   "start offset of Float32Array should be a multiple of 4"
 * Copy via `ArrayBuffer.slice` so the view always starts at offset 0.
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

export function decodeWorldBuffer(data: ArrayBuffer): Float32Array {
  const view = new Float32Array(data);
  if (view.length === WORLD_FLOAT_COUNT) {
    return view;
  }
  const normalized = createEmptyWorldBuffer();
  normalized.set(view.subarray(0, Math.min(view.length, WORLD_FLOAT_COUNT)));
  return normalized;
}

export function worldBufferToArrayBuffer(world: Float32Array): ArrayBuffer {
  return world.buffer.slice(
    world.byteOffset,
    world.byteOffset + world.byteLength,
  ) as ArrayBuffer;
}
