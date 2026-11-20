/**
 * Super-simple world sync — one in-memory agent, JSON DataChannel messages, no Redis.
 *
 * Clients send `{ type: "pose", x, y, z }` (or `{ x, y, z }`) on the sync channel.
 * The agent stores the latest pose per session and broadcasts
 * `{ type: "world", poses }` to every connected peer. A pose only marks the world
 * dirty; a 30 Hz tick (BROADCAST_HZ) sends one shared frame when dirty, so the
 * cost per session is at most 30 frames/s however many peers send poses. Join and
 * leave broadcast at once. The tick runs while at least one peer is connected.
 *
 * Build:
 *   npx @voicethere/agent build --entry templates/world-sync/agent.ts --outfile dist/agent.js
 */
import { defineAgent, sendToClient } from "@voicethere/agent";

export type Pose = { x: number; y: number; z: number };

export const BROADCAST_HZ = 30;
const BROADCAST_INTERVAL_MS = Math.floor(1000 / BROADCAST_HZ);

const poses = new Map<string, Pose>();
let dirty = false;
let broadcastTimer: ReturnType<typeof setInterval> | null = null;

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parsePoseMessage(message: unknown): Pose | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const record = message as {
    type?: unknown;
    x?: unknown;
    y?: unknown;
    z?: unknown;
  };
  if (record.type !== undefined && record.type !== "pose") {
    return null;
  }
  if (
    !isFiniteNumber(record.x) ||
    !isFiniteNumber(record.y) ||
    !isFiniteNumber(record.z)
  ) {
    return null;
  }
  return { x: record.x, y: record.y, z: record.z };
}

function broadcastWorld(): void {
  dirty = false;
  const payload = {
    type: "world",
    poses: Object.fromEntries(poses),
  };
  for (const sessionId of poses.keys()) {
    sendToClient(sessionId, payload);
  }
}

function startTickIfNeeded(): void {
  if (broadcastTimer || poses.size === 0) return;
  broadcastTimer = setInterval(() => {
    if (dirty) broadcastWorld();
  }, BROADCAST_INTERVAL_MS);
}

function stopTickIfIdle(): void {
  if (poses.size > 0 || !broadcastTimer) return;
  clearInterval(broadcastTimer);
  broadcastTimer = null;
  dirty = false;
}

export default defineAgent({
  onClientJoin({ sessionId }) {
    poses.set(sessionId, { x: 0, y: 0, z: 0 });
    startTickIfNeeded();
    broadcastWorld();
  },

  onClientLeave({ sessionId }) {
    poses.delete(sessionId);
    broadcastWorld();
    stopTickIfIdle();
  },

  onDataChannelMessage({ sessionId, message }) {
    const pose = parsePoseMessage(message);
    if (!pose) return;
    poses.set(sessionId, pose);
    startTickIfNeeded();
    dirty = true;
  },
});
