/**
 * Super-simple world sync — one in-memory agent, JSON DataChannel messages, no Redis.
 *
 * Clients send `{ type: "pose", x, y, z }` (or `{ x, y, z }`) on the sync channel.
 * The agent stores the latest pose per session and broadcasts
 * `{ type: "world", poses }` to every connected peer.
 *
 * Build:
 *   npx @voicethere/agent build --entry templates/world-sync/agent.ts --outfile dist/agent.js
 */
import { defineAgent, sendToClient } from "@voicethere/agent";

export type Pose = { x: number; y: number; z: number };

const poses = new Map<string, Pose>();

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parsePoseMessage(message: unknown): Pose | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const record = message as { type?: unknown; x?: unknown; y?: unknown; z?: unknown };
  if (record.type !== undefined && record.type !== "pose") {
    return null;
  }
  if (!isFiniteNumber(record.x) || !isFiniteNumber(record.y) || !isFiniteNumber(record.z)) {
    return null;
  }
  return { x: record.x, y: record.y, z: record.z };
}

function broadcastWorld(): void {
  const payload = {
    type: "world",
    poses: Object.fromEntries(poses),
  };
  for (const sessionId of poses.keys()) {
    sendToClient(sessionId, payload);
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

  onDataChannelMessage({ sessionId, message }) {
    const pose = parsePoseMessage(message);
    if (!pose) return;
    poses.set(sessionId, pose);
    broadcastWorld();
  },
});
