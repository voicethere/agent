/**
 * Redis-backed world buffer sync for redis-sync-smoke (Advanced tier + project Redis).
 *
 * Game-style layout: one Float32Array world blob in Redis (`e2e:redis-sync:world`).
 * Each client owns a fixed slot and publishes `{ type: "position", clientIndex, x, y }`.
 * Each runner pod runs its own broadcast loop: one Redis GET per tick, then binary
 * fan-out on voicethere-sync to all local sessions (no pub/sub). Clients patch
 * out of sync; the 20Hz server tick is the authoritative sync path.
 *
 * Slot writes use a Lua read-modify-write so concurrent patches from many sessions
 * cannot clobber each other (WATCH/MULTI lost slots under 30-way connect storms).
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
  normalizeWorldBuffer,
  peerSlotOffset,
  PEER_SLOT_BYTE_LENGTH,
  PEER_STRIDE,
  REDIS_WORLD_KEY,
  WORLD_BYTE_LENGTH,
  writePeerSlot,
  LUA_PATCH_PEER_SLOT,
} from "./world-layout.js";

const WORLD_BROADCAST_HZ = 20;
const WORLD_BROADCAST_INTERVAL_MS = Math.floor(1000 / WORLD_BROADCAST_HZ);

const connectedSessions = new Set<string>();
/** Same members as connectedSessions; array form for the per-tick broadcast. */
const connectedSessionList: string[] = [];
const sessionClientIndex = new Map<string, number>();
/** The one world buffer: Redis GETs copy into it, every broadcast sends this view. */
const localWorld = createEmptyWorldBuffer();
const localWorldBytes = Buffer.from(
  localWorld.buffer,
  localWorld.byteOffset,
  localWorld.byteLength,
);
let redis: Redis | null = null;
let broadcastTimer: NodeJS.Timeout | null = null;

function parsePositionMessage(
  message: unknown,
): { clientIndex: number; x: number; y: number } | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const record = message as {
    type?: unknown;
    clientIndex?: unknown;
    x?: unknown;
    y?: unknown;
  };
  if (record.type !== "position") {
    return null;
  }
  if (
    typeof record.clientIndex !== "number" ||
    !Number.isFinite(record.clientIndex) ||
    record.clientIndex < 0
  ) {
    return null;
  }
  if (typeof record.x !== "number" || !Number.isFinite(record.x)) {
    return null;
  }
  if (typeof record.y !== "number" || !Number.isFinite(record.y)) {
    return null;
  }
  return {
    clientIndex: record.clientIndex,
    x: record.x,
    y: record.y,
  };
}

const PEER_SLOT = new Float32Array(PEER_STRIDE);
const PEER_SLOT_BUF = Buffer.from(
  PEER_SLOT.buffer,
  PEER_SLOT.byteOffset,
  PEER_SLOT.byteLength,
);

function encodePeerSlot(
  clientIndex: number,
  x: number,
  y: number,
  active: number,
): Buffer {
  PEER_SLOT[0] = clientIndex;
  PEER_SLOT[1] = x;
  PEER_SLOT[2] = y;
  PEER_SLOT[3] = active;
  return PEER_SLOT_BUF;
}

function broadcastWorldBuffer(targetSessionId?: string): void {
  const payload = localWorldBytes;
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
    // payload is already a Buffer: forwarded as-is, one call, no Set iterator.
    broadCastBinaryToClients(payload, connectedSessionList, "sync");
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    agentLog("error", `world broadcast send failed: ${detail}`);
  }
}

/** Copy the Redis blob into `localWorld` in place; the GET reply is the only allocation. */
async function loadWorldFromRedis(): Promise<void> {
  if (!redis) return;
  const raw = await redis.getBuffer(REDIS_WORLD_KEY);
  normalizeWorldBuffer(raw, localWorld);
}

async function broadcastWorldFromRedis(
  targetSessionId?: string,
): Promise<void> {
  await loadWorldFromRedis();
  broadcastWorldBuffer(targetSessionId);
}

function logBroadcastError(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  agentLog("error", `world broadcast failed: ${detail}`);
}

function onBroadcastTick(): void {
  void broadcastWorldFromRedis().catch(logBroadcastError);
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
    writePeerSlot(localWorld, clientIndex, x, y, active);
    return;
  }

  const byteOffset = peerSlotOffset(clientIndex) * 4;
  const slot = encodePeerSlot(clientIndex, x, y, active);
  if (slot.byteLength !== PEER_SLOT_BYTE_LENGTH) {
    throw new Error(
      `peer slot encode length ${slot.byteLength} != ${PEER_SLOT_BYTE_LENGTH}`,
    );
  }
  await redis.eval(
    LUA_PATCH_PEER_SLOT,
    1,
    REDIS_WORLD_KEY,
    String(byteOffset),
    slot,
    String(WORLD_BYTE_LENGTH),
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
    await broadcastWorldFromRedis(sessionId);
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

  async onDataChannelMessage(ctx) {
    const position = parsePositionMessage(ctx.message);
    if (!position) {
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
