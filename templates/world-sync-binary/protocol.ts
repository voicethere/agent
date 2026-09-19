/**
 * Binary pose protocol for the single-agent world-sync-binary template.
 *
 * Client → agent (12 bytes): Float32Array [x, y, z] — reuse one Float32Array.
 * Agent → client world snapshot (one growable buffer, rewritten in place):
 *   uint32le peerCount
 *   for each peer:
 *     uint16le sessionIdByteLength
 *     utf8 sessionId
 *     float32le x, y, z
 */
export const POSE_FLOAT_COUNT = 3;
export const POSE_BYTE_LENGTH = POSE_FLOAT_COUNT * 4;

export type Pose = { x: number; y: number; z: number };

export type WorldPoseEntry = { sessionId: string; pose: Pose };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const POSE_BYTES = new Uint8Array(POSE_BYTE_LENGTH);
const POSE_VIEW = new DataView(
  POSE_BYTES.buffer,
  POSE_BYTES.byteOffset,
  POSE_BYTE_LENGTH,
);

function asDataView(data: ArrayBufferLike | ArrayBufferView): DataView {
  if (ArrayBuffer.isView(data)) {
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  return new DataView(data);
}

function asUint8View(data: ArrayBufferLike | ArrayBufferView): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function decodePoseBuffer(
  data: ArrayBufferLike | ArrayBufferView | null | undefined,
): Pose | null {
  if (data == null) {
    return null;
  }
  const view = asDataView(data);
  if (view.byteLength < POSE_BYTE_LENGTH) {
    return null;
  }
  const x = view.getFloat32(0, true);
  const y = view.getFloat32(4, true);
  const z = view.getFloat32(8, true);
  if (!isFinitePose(x, y, z)) {
    return null;
  }
  return { x, y, z };
}

function isFinitePose(x: number, y: number, z: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
}

/** Write xyz from an inbound frame into a persistent Float32Array (no copy). */
export function decodePoseInto(
  data: ArrayBufferLike | ArrayBufferView | null | undefined,
  dest: Float32Array,
  floatOffset = 0,
): boolean {
  if (data == null || dest.length < floatOffset + POSE_FLOAT_COUNT) {
    return false;
  }
  const view = asDataView(data);
  if (view.byteLength < POSE_BYTE_LENGTH) {
    return false;
  }
  const x = view.getFloat32(0, true);
  const y = view.getFloat32(4, true);
  const z = view.getFloat32(8, true);
  if (!isFinitePose(x, y, z)) {
    return false;
  }
  dest[floatOffset] = x;
  dest[floatOffset + 1] = y;
  dest[floatOffset + 2] = z;
  return true;
}

/**
 * Pack a pose into the shared 12-byte scratch buffer (overwritten on the next call).
 */
export function encodePoseBuffer(pose: Pose): Uint8Array {
  POSE_VIEW.setFloat32(0, pose.x, true);
  POSE_VIEW.setFloat32(4, pose.y, true);
  POSE_VIEW.setFloat32(8, pose.z, true);
  return POSE_BYTES;
}

/** One growable snapshot buffer; encode* rewrite it in place and return a view. */
export class WorldSnapshotBuffer {
  private bytes: Uint8Array;
  private view: DataView;
  private used = 0;
  private out: Uint8Array;

  constructor(capacity = 256) {
    this.bytes = new Uint8Array(capacity);
    this.view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    );
    this.out = this.bytes.subarray(0, 0);
  }

  get byteLength(): number {
    return this.used;
  }

  /**
   * View of the last encoded snapshot (same backing buffer, length = used).
   * The view object is reused while the encoded length is unchanged.
   */
  bytesView(): Uint8Array {
    if (
      this.out.byteLength !== this.used ||
      this.out.buffer !== this.bytes.buffer
    ) {
      this.out = this.bytes.subarray(0, this.used);
    }
    return this.out;
  }

  encode(entries: Iterable<WorldPoseEntry>): Uint8Array {
    const list = Array.isArray(entries) ? entries : [...entries];
    let size = 4;
    for (const entry of list) {
      size += 2 + utf8ByteLength(entry.sessionId) + POSE_BYTE_LENGTH;
    }
    this.ensure(size);
    this.view.setUint32(0, list.length, true);
    let offset = 4;
    for (const entry of list) {
      offset = this.writePeer(
        offset,
        entry.sessionId,
        entry.pose.x,
        entry.pose.y,
        entry.pose.z,
      );
    }
    this.used = offset;
    return this.bytesView();
  }

  encodePacked(
    sessionIds: readonly string[],
    xyz: Float32Array,
    count: number,
  ): Uint8Array {
    let size = 4;
    for (let i = 0; i < count; i += 1) {
      size += 2 + utf8ByteLength(sessionIds[i] ?? "") + POSE_BYTE_LENGTH;
    }
    this.ensure(size);
    this.view.setUint32(0, count, true);
    let offset = 4;
    for (let i = 0; i < count; i += 1) {
      const floatOffset = i * POSE_FLOAT_COUNT;
      offset = this.writePeer(
        offset,
        sessionIds[i] ?? "",
        xyz[floatOffset] ?? 0,
        xyz[floatOffset + 1] ?? 0,
        xyz[floatOffset + 2] ?? 0,
      );
    }
    this.used = offset;
    return this.bytesView();
  }

  private writePeer(
    offset: number,
    sessionId: string,
    x: number,
    y: number,
    z: number,
  ): number {
    const { written } = encoder.encodeInto(
      sessionId,
      this.bytes.subarray(offset + 2),
    );
    this.view.setUint16(offset, written, true);
    offset += 2 + written;
    this.view.setFloat32(offset, x, true);
    this.view.setFloat32(offset + 4, y, true);
    this.view.setFloat32(offset + 8, z, true);
    return offset + POSE_BYTE_LENGTH;
  }

  private ensure(size: number): void {
    if (this.bytes.byteLength >= size) {
      return;
    }
    let capacity = Math.max(this.bytes.byteLength, 1);
    while (capacity < size) {
      capacity *= 2;
    }
    this.bytes = new Uint8Array(capacity);
    this.view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    );
  }
}

const defaultSnapshot = new WorldSnapshotBuffer();

export function encodeWorldSnapshot(
  entries: Iterable<WorldPoseEntry>,
): Uint8Array {
  return defaultSnapshot.encode(entries);
}

export function decodeWorldSnapshot(
  data: ArrayBufferLike | ArrayBufferView,
): WorldPoseEntry[] {
  const bytes = asUint8View(data);
  if (bytes.byteLength < 4) {
    return [];
  }
  const view = asDataView(bytes);
  const count = view.getUint32(0, true);
  const entries: WorldPoseEntry[] = [];
  let offset = 4;
  for (let i = 0; i < count; i += 1) {
    if (offset + 2 > bytes.byteLength) {
      break;
    }
    const idLength = view.getUint16(offset, true);
    offset += 2;
    if (offset + idLength + POSE_BYTE_LENGTH > bytes.byteLength) {
      break;
    }
    const sessionId = decoder.decode(bytes.subarray(offset, offset + idLength));
    offset += idLength;
    const x = view.getFloat32(offset, true);
    const y = view.getFloat32(offset + 4, true);
    const z = view.getFloat32(offset + 8, true);
    offset += POSE_BYTE_LENGTH;
    if (!isFinitePose(x, y, z)) {
      continue;
    }
    entries.push({ sessionId, pose: { x, y, z } });
  }
  return entries;
}
