/**
 * Binary pose protocol for the single-agent world-sync-binary template.
 *
 * Client → agent (12 bytes): Float32Array [x, y, z]
 * Agent → client world snapshot:
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

export function toUint8Array(
  data: ArrayBufferLike | ArrayBufferView,
): Uint8Array {
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

export function decodePoseBuffer(
  data: ArrayBufferLike | ArrayBufferView | null | undefined,
): Pose | null {
  if (data == null) {
    return null;
  }
  const bytes = toUint8Array(data);
  if (bytes.byteLength < POSE_BYTE_LENGTH) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const x = view.getFloat32(0, true);
  const y = view.getFloat32(4, true);
  const z = view.getFloat32(8, true);
  if (![x, y, z].every(Number.isFinite)) {
    return null;
  }
  return { x, y, z };
}

export function encodePoseBuffer(pose: Pose): Uint8Array {
  const bytes = new Uint8Array(POSE_BYTE_LENGTH);
  const view = new DataView(bytes.buffer);
  view.setFloat32(0, pose.x, true);
  view.setFloat32(4, pose.y, true);
  view.setFloat32(8, pose.z, true);
  return bytes;
}

export function encodeWorldSnapshot(
  entries: Iterable<WorldPoseEntry>,
): Uint8Array {
  const list = [...entries];
  let bodyBytes = 4;
  const encodedIds: Uint8Array[] = [];
  for (const entry of list) {
    const idBytes = new TextEncoder().encode(entry.sessionId);
    encodedIds.push(idBytes);
    bodyBytes += 2 + idBytes.byteLength + POSE_BYTE_LENGTH;
  }

  const out = new Uint8Array(bodyBytes);
  const view = new DataView(out.buffer);
  view.setUint32(0, list.length, true);
  let offset = 4;
  for (let i = 0; i < list.length; i += 1) {
    const idBytes = encodedIds[i]!;
    const pose = list[i]!.pose;
    view.setUint16(offset, idBytes.byteLength, true);
    offset += 2;
    out.set(idBytes, offset);
    offset += idBytes.byteLength;
    view.setFloat32(offset, pose.x, true);
    view.setFloat32(offset + 4, pose.y, true);
    view.setFloat32(offset + 8, pose.z, true);
    offset += POSE_BYTE_LENGTH;
  }
  return out;
}

export function decodeWorldSnapshot(
  data: ArrayBufferLike | ArrayBufferView,
): WorldPoseEntry[] {
  const bytes = toUint8Array(data);
  if (bytes.byteLength < 4) {
    return [];
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  const entries: WorldPoseEntry[] = [];
  let offset = 4;
  const decoder = new TextDecoder();
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
    if (![x, y, z].every(Number.isFinite)) {
      continue;
    }
    entries.push({ sessionId, pose: { x, y, z } });
  }
  return entries;
}
