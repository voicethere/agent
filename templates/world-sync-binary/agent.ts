/**
 * Single-agent binary world sync — no Redis.
 *
 * Clients send an ArrayBuffer of 3 float32 values `[x, y, z]` on the sync
 * DataChannel. Poses live in one Float32Array; the outbound snapshot is one
 * growable buffer rewritten in place and fanned out as a single Buffer view
 * (no per-tick or per-peer copies).
 *
 * Build:
 *   npx @voicethere/agent build --entry templates/world-sync-binary/agent.ts --outfile dist/agent.js
 */
import { broadCastBinaryToClients, defineAgent } from "@voicethere/agent";

import {
  decodePoseInto,
  POSE_FLOAT_COUNT,
  WorldSnapshotBuffer,
} from "./protocol.js";

const snapshot = new WorldSnapshotBuffer();
const indexBySession = new Map<string, number>();
const sessionIds: string[] = [];
let xyz = new Float32Array(8 * POSE_FLOAT_COUNT);
let peerCount = 0;

function ensurePeerCapacity(count: number): void {
  const needed = count * POSE_FLOAT_COUNT;
  if (xyz.length >= needed) {
    return;
  }
  let nextLength = xyz.length;
  while (nextLength < needed) {
    nextLength *= 2;
  }
  const grown = new Float32Array(nextLength);
  grown.set(xyz);
  xyz = grown;
}

function setPose(sessionId: string, x: number, y: number, z: number): void {
  let index = indexBySession.get(sessionId);
  if (index === undefined) {
    index = peerCount;
    peerCount += 1;
    sessionIds[index] = sessionId;
    indexBySession.set(sessionId, index);
    ensurePeerCapacity(peerCount);
  }
  const offset = index * POSE_FLOAT_COUNT;
  xyz[offset] = x;
  xyz[offset + 1] = y;
  xyz[offset + 2] = z;
}

function removePeer(sessionId: string): void {
  const index = indexBySession.get(sessionId);
  if (index === undefined) {
    return;
  }
  const last = peerCount - 1;
  if (index !== last) {
    const lastId = sessionIds[last]!;
    sessionIds[index] = lastId;
    indexBySession.set(lastId, index);
    const dest = index * POSE_FLOAT_COUNT;
    const src = last * POSE_FLOAT_COUNT;
    xyz[dest] = xyz[src]!;
    xyz[dest + 1] = xyz[src + 1]!;
    xyz[dest + 2] = xyz[src + 2]!;
  }
  indexBySession.delete(sessionId);
  peerCount -= 1;
  sessionIds.length = peerCount;
}

function broadcastWorld(): void {
  // sessionIds.length === peerCount, so one Buffer view is shared by every send.
  const payload = snapshot.encodePacked(sessionIds, xyz, peerCount);
  broadCastBinaryToClients(payload, sessionIds, "sync");
}

export default defineAgent({
  onClientJoin({ sessionId }) {
    setPose(sessionId, 0, 0, 0);
    broadcastWorld();
  },

  onClientLeave({ sessionId }) {
    removePeer(sessionId);
    broadcastWorld();
  },

  onDataChannelBinary({ sessionId, rawBinary }) {
    let index = indexBySession.get(sessionId);
    if (index === undefined) {
      setPose(sessionId, 0, 0, 0);
      index = indexBySession.get(sessionId);
      if (index === undefined) {
        return;
      }
    }
    if (!decodePoseInto(rawBinary, xyz, index * POSE_FLOAT_COUNT)) {
      return;
    }
    broadcastWorld();
  },
});
