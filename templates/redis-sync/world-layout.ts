/**
 * Shared world layout and wire codec for the redis-sync template (agent + E2E helpers).
 *
 * World blob (Redis value and the pod's in-memory world), 6 bytes per slot, slot index =
 * clientIndex:
 *   u8 clientIndex · u8 active · i16le x · i16le y      (x, y quantized, see BOARD_MIN/MAX)
 * 128 slots = 768 B, so one position update is `SETRANGE key clientIndex*6 <6 bytes>`.
 *
 * Wire frame (agent -> client on voicethere-sync):
 *   u8 kind (1 keyframe, 2 delta) · u8 version (1) · u16le slotCount · slotCount x 6 B slots
 * A keyframe carries every active slot and replaces the client's world. A delta carries only
 * slots that changed since the pod's last broadcast; a slot that left goes out once with
 * active = 0. Client -> agent poses stay float32le [clientIndex, x, y] (12 B).
 *
 * The matching test vectors are `quantized-frames.vectors.json` (copied into the platform tests).
 */
import { dequantize, isQuantizable, quantize } from "./quantize.js";

export const MAX_PEERS = 128;
export const SLOT_BYTES = 6;
export const WORLD_BYTE_LENGTH = MAX_PEERS * SLOT_BYTES;

/** Board extent: x and y are clamped to [BOARD_MIN, BOARD_MAX]. Step is 2048 / 65534 (about 0.031). */
export const BOARD_MIN = -1024;
export const BOARD_MAX = 1024;

export const FRAME_KIND_KEYFRAME = 1;
export const FRAME_KIND_DELTA = 2;
export const FRAME_VERSION = 1;
export const FRAME_HEADER_BYTES = 4;
export const MAX_FRAME_BYTES = FRAME_HEADER_BYTES + WORLD_BYTE_LENGTH;

/** Client -> agent position frame: float32le [clientIndex, x, y] (12 bytes). */
export const POSITION_FLOAT_COUNT = 3;
export const POSITION_BYTE_LENGTH = POSITION_FLOAT_COUNT * 4;

export const REDIS_WORLD_KEY = "e2e:redis-sync:world:v2";

export type PeerPosition = {
  clientIndex: number;
  x: number;
  y: number;
};

export type PeerSlot = {
  clientIndex: number;
  x: number;
  y: number;
  active: number;
};

export type FrameKind = "keyframe" | "delta";

export type DecodedSlot = {
  clientIndex: number;
  active: number;
  /** Raw quantized components. */
  qx: number;
  qy: number;
};

export type DecodedFrame = {
  kind: FrameKind;
  version: number;
  slots: DecodedSlot[];
};

/** Thrown for a frame with an unknown kind or version byte, or a bad length. Never guessed. */
export class SyncFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncFrameError";
  }
}

export function slotOffset(clientIndex: number): number {
  return clientIndex * SLOT_BYTES;
}

export function createEmptyWorldBuffer(): Uint8Array {
  return new Uint8Array(WORLD_BYTE_LENGTH);
}

export function isValidPosition(
  clientIndex: number,
  x: number,
  y: number,
): boolean {
  return (
    Number.isInteger(clientIndex) &&
    clientIndex >= 0 &&
    clientIndex < MAX_PEERS &&
    isQuantizable(x) &&
    isQuantizable(y)
  );
}

/** Write one slot of raw quantized values at `offset` of `dest`. */
export function writeSlotBytes(
  dest: Uint8Array,
  offset: number,
  clientIndex: number,
  active: number,
  qx: number,
  qy: number,
): void {
  dest[offset] = clientIndex;
  dest[offset + 1] = active;
  dest[offset + 2] = qx & 0xff;
  dest[offset + 3] = (qx >> 8) & 0xff;
  dest[offset + 4] = qy & 0xff;
  dest[offset + 5] = (qy >> 8) & 0xff;
}

function readI16(src: Uint8Array, offset: number): number {
  const v = src[offset]! | (src[offset + 1]! << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
}

/** Quantize a pose into the 6-byte slot at the start of `dest` (the SETRANGE payload). */
export function encodeSlotInto(
  dest: Uint8Array,
  clientIndex: number,
  x: number,
  y: number,
  active: number,
): Uint8Array {
  writeSlotBytes(
    dest,
    0,
    clientIndex,
    active,
    active ? quantize(x, BOARD_MIN, BOARD_MAX) : 0,
    active ? quantize(y, BOARD_MIN, BOARD_MAX) : 0,
  );
  return dest;
}

/** Write a quantized pose into a world blob in place (memory mode). */
export function writePeerSlot(
  world: Uint8Array,
  clientIndex: number,
  x: number,
  y: number,
  active: number,
): void {
  const offset = slotOffset(clientIndex);
  writeSlotBytes(
    world,
    offset,
    clientIndex,
    active,
    active ? quantize(x, BOARD_MIN, BOARD_MAX) : 0,
    active ? quantize(y, BOARD_MIN, BOARD_MAX) : 0,
  );
}

export function clearPeerSlot(world: Uint8Array, clientIndex: number): void {
  writePeerSlot(world, clientIndex, 0, 0, 0);
}

export function readPeerSlot(
  world: Uint8Array,
  clientIndex: number,
): PeerSlot | null {
  const offset = slotOffset(clientIndex);
  if (world[offset + 1] !== 1) {
    return null;
  }
  return {
    clientIndex: world[offset]!,
    x: dequantize(readI16(world, offset + 2), BOARD_MIN, BOARD_MAX),
    y: dequantize(readI16(world, offset + 4), BOARD_MIN, BOARD_MAX),
    active: 1,
  };
}

/** Copy Redis bytes into `dest` in place, zero-padding a short blob and ignoring a long one. */
export function normalizeWorldBuffer(
  raw: Uint8Array | null | undefined,
  dest: Uint8Array,
): Uint8Array {
  if (!raw || raw.byteLength === 0) {
    dest.fill(0);
    return dest;
  }
  const byteCount = Math.min(raw.byteLength, dest.byteLength);
  dest.set(raw.subarray(0, byteCount));
  if (byteCount < dest.byteLength) {
    dest.fill(0, byteCount);
  }
  return dest;
}

function writeHeader(dest: Uint8Array, kind: number, slotCount: number): void {
  dest[0] = kind;
  dest[1] = FRAME_VERSION;
  dest[2] = slotCount & 0xff;
  dest[3] = (slotCount >> 8) & 0xff;
}

/** Keyframe of every active slot of `world` into `dest`; returns the frame length. */
export function encodeKeyframeInto(
  dest: Uint8Array,
  world: Uint8Array,
): number {
  let count = 0;
  let at = FRAME_HEADER_BYTES;
  for (let i = 0; i < MAX_PEERS; i += 1) {
    const o = i * SLOT_BYTES;
    if (world[o + 1] !== 1) continue;
    dest.set(world.subarray(o, o + SLOT_BYTES), at);
    at += SLOT_BYTES;
    count += 1;
  }
  writeHeader(dest, FRAME_KIND_KEYFRAME, count);
  return at;
}

function slotChanged(world: Uint8Array, last: Uint8Array, o: number): boolean {
  if (world[o + 1] === 0 && last[o + 1] === 0) {
    return false;
  }
  for (let b = 0; b < SLOT_BYTES; b += 1) {
    if (world[o + b] !== last[o + b]) return true;
  }
  return false;
}

/**
 * Delta of slots that differ between `world` and `lastSent` into `dest`. Returns the frame
 * length, or 0 when nothing changed (an empty delta is not sent). A slot that left is written
 * as [clientIndex, 0, 0, 0, 0, 0].
 */
export function encodeDeltaInto(
  dest: Uint8Array,
  world: Uint8Array,
  lastSent: Uint8Array,
): number {
  let count = 0;
  let at = FRAME_HEADER_BYTES;
  for (let i = 0; i < MAX_PEERS; i += 1) {
    const o = i * SLOT_BYTES;
    if (!slotChanged(world, lastSent, o)) continue;
    if (world[o + 1] === 1) {
      dest.set(world.subarray(o, o + SLOT_BYTES), at);
    } else {
      writeSlotBytes(dest, at, i, 0, 0, 0);
    }
    at += SLOT_BYTES;
    count += 1;
  }
  if (count === 0) return 0;
  writeHeader(dest, FRAME_KIND_DELTA, count);
  return at;
}

export function decodeFrame(data: Uint8Array): DecodedFrame {
  if (data.byteLength < FRAME_HEADER_BYTES) {
    throw new SyncFrameError(`frame too short: ${data.byteLength} bytes`);
  }
  const kindByte = data[0]!;
  if (kindByte !== FRAME_KIND_KEYFRAME && kindByte !== FRAME_KIND_DELTA) {
    throw new SyncFrameError(`unknown frame kind ${kindByte}`);
  }
  const version = data[1]!;
  if (version !== FRAME_VERSION) {
    throw new SyncFrameError(`unknown frame version ${version}`);
  }
  const slotCount = data[2]! | (data[3]! << 8);
  if (data.byteLength !== FRAME_HEADER_BYTES + slotCount * SLOT_BYTES) {
    throw new SyncFrameError(
      `frame length ${data.byteLength} does not match slotCount ${slotCount}`,
    );
  }
  const slots: DecodedSlot[] = [];
  for (let i = 0; i < slotCount; i += 1) {
    const o = FRAME_HEADER_BYTES + i * SLOT_BYTES;
    slots.push({
      clientIndex: data[o]!,
      active: data[o + 1]!,
      qx: readI16(data, o + 2),
      qy: readI16(data, o + 4),
    });
  }
  return {
    kind: kindByte === FRAME_KIND_KEYFRAME ? "keyframe" : "delta",
    version,
    slots,
  };
}

/** Client side: apply a frame to a world blob (a keyframe replaces it, a delta patches it). */
export function applyFrameToWorld(
  world: Uint8Array,
  data: Uint8Array,
): DecodedFrame {
  const frame = decodeFrame(data);
  if (frame.kind === "keyframe") {
    world.fill(0);
  }
  for (const slot of frame.slots) {
    writeSlotBytes(
      world,
      slotOffset(slot.clientIndex),
      slot.clientIndex,
      slot.active,
      slot.qx,
      slot.qy,
    );
  }
  return frame;
}

function asDataView(data: ArrayBufferLike | ArrayBufferView): DataView {
  if (ArrayBuffer.isView(data)) {
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  return new DataView(data);
}

/** Decode a 12-byte inbound position frame; null for short, non-finite or out-of-range index. */
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
    !isValidPosition(Math.trunc(clientIndex), x, y)
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
