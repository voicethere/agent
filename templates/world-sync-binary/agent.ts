/**
 * Single-agent binary world sync — no Redis.
 *
 * Clients send an ArrayBuffer of 3 float32 values `[x, y, z]` on the sync
 * DataChannel. The agent stores the latest pose per session and broadcasts a
 * packed world snapshot with `sendBinaryToClient`.
 *
 * Build:
 *   npx @voicethere/agent build --entry templates/world-sync-binary/agent.ts --outfile dist/agent.js
 */
import { defineAgent, sendBinaryToClient } from "@voicethere/agent";

import {
  decodePoseBuffer,
  encodeWorldSnapshot,
  type Pose,
} from "./protocol.js";

const poses = new Map<string, Pose>();

function broadcastWorld(): void {
  const payload = encodeWorldSnapshot(
    [...poses.entries()].map(([sessionId, pose]) => ({ sessionId, pose })),
  );
  for (const sessionId of poses.keys()) {
    sendBinaryToClient(sessionId, payload, "sync");
  }
}

export default defineAgent({
  onClientJoin({ sessionId }) {
    poses.set(sessionId, { x: 0, y: 0, z: 0 });
    broadcastWorld();
  },

  onClientLeave({ sessionId }) {
    poses.delete(sessionId);
    broadcastWorld();
  },

  onDataChannelBinary({ sessionId, rawBinary }) {
    const pose = decodePoseBuffer(rawBinary);
    if (!pose) return;
    poses.set(sessionId, pose);
    broadcastWorld();
  },
});
