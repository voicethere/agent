/**
 * Redis-backed world sync for redis-sync-smoke (Advanced tier + project Redis).
 *
 * The world is a 128-slot x 6 B blob in Redis (`e2e:redis-sync:world:v2`, layout in
 * `world-layout.ts`). Each client owns a fixed slot and publishes a 12-byte `ArrayBuffer`
 * `Float32Array([clientIndex, x, y])` on the sync DataChannel. The agent quantizes the pose
 * once and writes only that slot with `SETRANGE` (atomic, no read-modify-write).
 *
 * Each runner pod runs a 20Hz loop: one Redis GET, a diff against the world it last
 * broadcast, and one delta frame (changed slots only) to all local sessions; an empty delta is
 * not sent. A joining session gets a keyframe built from the same last-broadcast world, and
 * every session gets a keyframe every KEYFRAME_INTERVAL_MS as a safety net.
 *
 * Buffers are allocated once per pod: two 768 B worlds swapped by reference and one frame
 * scratch buffer (the send path copies synchronously, see test/binary-send-copy.test.ts).
 *
 * Build:
 *   npx @voicethere/agent build --entry templates/redis-sync/agent.ts --outfile dist/agent.js
 */
import { Redis } from "ioredis";
import {
  agentLog,
  broadCastBinaryToClients,
  defineAgent,
  sendBinaryToClient,
} from "@voicethere/agent";

import {
  createEmptyWorldBuffer,
  decodePositionBuffer,
  encodeDeltaInto,
  encodeKeyframeInto,
  encodeSlotInto,
  MAX_FRAME_BYTES,
  normalizeWorldBuffer,
  REDIS_WORLD_KEY,
  slotOffset,
  SLOT_BYTES,
  writePeerSlot,
} from "./world-layout.js";

const WORLD_BROADCAST_HZ = 20;
const WORLD_BROADCAST_INTERVAL_MS = Math.floor(1000 / WORLD_BROADCAST_HZ);
export const KEYFRAME_INTERVAL_MS = 1000;
const KEYFRAME_EVERY_TICKS = Math.round(
  KEYFRAME_INTERVAL_MS / WORLD_BROADCAST_INTERVAL_MS,
);

const connectedSessions = new Set<string>();
/** Same members as connectedSessions; array form for the per-tick broadcast. */
const connectedSessionList: string[] = [];
const sessionClientIndex = new Map<string, number>();
/** `world` is filled by the Redis GET (or memory-mode writes); `lastSent` is what was broadcast. */
let world = createEmptyWorldBuffer();
let lastSent = createEmptyWorldBuffer();
/** One frame scratch buffer; the frame sent is a subarray of it. */
const frameScratch = Buffer.allocUnsafe(MAX_FRAME_BYTES);
const slotScratch = Buffer.allocUnsafe(SLOT_BYTES);
let redis: Redis | null = null;
let broadcastTimer: NodeJS.Timeout | null = null;
let tickCount = 0;
let tickInFlight = false;
let droppedPoses = 0;

/** Number of inbound poses dropped as invalid (non-finite or out-of-range index). */
export function getDroppedPoseCount(): number {
  return droppedPoses;
}

function sendFrame(length: number, targetSessionId?: string): void {
  const payload = frameScratch.subarray(0, length);
  if (targetSessionId) {
    try {
      sendBinaryToClient(targetSessionId, payload, "sync");
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      agentLog(
        "error",
        `world send failed session=${targetSessionId}: ${detail}`,
      );
    }
    return;
  }
  if (connectedSessionList.length === 0) return;
  try {
    broadCastBinaryToClients(payload, connectedSessionList, "sync");
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    agentLog("error", `world broadcast send failed: ${detail}`);
  }
}

/** Remember what this tick broadcast: swap with Redis, copy in memory mode (world is the state). */
function commitLastSent(): void {
  if (redis) {
    const previous = lastSent;
    lastSent = world;
    world = previous;
    return;
  }
  lastSent.set(world);
}

/** Copy the Redis blob into `world` in place; the GET reply is the only allocation. */
async function loadWorldFromRedis(): Promise<void> {
  if (!redis) return;
  const raw = await redis.getBuffer(REDIS_WORLD_KEY);
  normalizeWorldBuffer(raw, world);
}

async function broadcastTick(): Promise<void> {
  await loadWorldFromRedis();
  if (connectedSessionList.length === 0) return;
  tickCount += 1;
  if (tickCount % KEYFRAME_EVERY_TICKS === 0) {
    sendFrame(encodeKeyframeInto(frameScratch, world));
  } else {
    const length = encodeDeltaInto(frameScratch, world, lastSent);
    if (length > 0) sendFrame(length);
  }
  commitLastSent();
}

function logBroadcastError(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  agentLog("error", `world broadcast failed: ${detail}`);
}

function onBroadcastTick(): void {
  if (tickInFlight) return;
  tickInFlight = true;
  void broadcastTick()
    .catch(logBroadcastError)
    .finally(() => {
      tickInFlight = false;
    });
}

function startBroadcastLoopIfNeeded(): void {
  if (broadcastTimer || connectedSessions.size === 0) {
    return;
  }
  broadcastTimer = setInterval(onBroadcastTick, WORLD_BROADCAST_INTERVAL_MS);
  agentLog("info", `world loop started (${WORLD_BROADCAST_HZ}Hz)`);
}

function stopBroadcastLoopIfNeeded(): void {
  if (connectedSessions.size > 0 || !broadcastTimer) {
    return;
  }
  clearInterval(broadcastTimer);
  broadcastTimer = null;
  agentLog("info", "world loop stopped");
}

async function patchWorldSlot(
  clientIndex: number,
  x: number,
  y: number,
  active: number,
): Promise<void> {
  if (!redis) {
    writePeerSlot(world, clientIndex, x, y, active);
    return;
  }
  const slot = encodeSlotInto(slotScratch, clientIndex, x, y, active);
  await redis.setrange(
    REDIS_WORLD_KEY,
    slotOffset(clientIndex),
    slot as Buffer,
  );
}

defineAgent({
  async onAgentStart({ env }) {
    const redisUrl = env.AGENT_REDIS_URL ?? process.env.AGENT_REDIS_URL;
    if (!redisUrl?.trim()) {
      agentLog(
        "warn",
        "AGENT_REDIS_URL unset — redis-sync fixture falls back to per-pod memory only",
      );
      return;
    }

    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    await redis.connect();
    agentLog(
      "info",
      "redis-sync agent connected to project Redis world buffer",
    );
  },

  async onClientJoin({ sessionId }) {
    if (!connectedSessions.has(sessionId)) {
      connectedSessions.add(sessionId);
      connectedSessionList.push(sessionId);
    }
    startBroadcastLoopIfNeeded();
    // Keyframe from the last-broadcast world: the same baseline the next shared delta applies to.
    sendFrame(encodeKeyframeInto(frameScratch, lastSent), sessionId);
  },

  async onClientLeave({ sessionId }) {
    if (connectedSessions.delete(sessionId)) {
      const index = connectedSessionList.indexOf(sessionId);
      if (index !== -1) {
        connectedSessionList.splice(index, 1);
      }
    }
    const clientIndex = sessionClientIndex.get(sessionId);
    sessionClientIndex.delete(sessionId);
    stopBroadcastLoopIfNeeded();
    if (clientIndex === undefined) {
      return;
    }
    try {
      await patchWorldSlot(clientIndex, 0, 0, 0);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      agentLog("error", `world leave patch failed: ${detail}`);
    }
  },

  async onDataChannelBinary(ctx) {
    const position = decodePositionBuffer(ctx.rawBinary);
    if (!position) {
      if (ctx.rawBinary && ctx.rawBinary.byteLength >= 12) {
        droppedPoses += 1;
        agentLog("warn", `dropped invalid pose (total ${droppedPoses})`);
      }
      return;
    }
    sessionClientIndex.set(ctx.sessionId, position.clientIndex);
    try {
      await patchWorldSlot(position.clientIndex, position.x, position.y, 1);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      agentLog("error", `world position patch failed: ${detail}`);
    }
  },
});
