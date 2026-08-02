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
import Redis from "ioredis";
import { agentLog, defineAgent, sendBinaryToClient } from "@voicethere/agent";

import {
  createEmptyWorldBuffer,
  normalizeWorldBuffer,
  peerSlotOffset,
  PEER_SLOT_BYTE_LENGTH,
  REDIS_WORLD_KEY,
  WORLD_BYTE_LENGTH,
  writePeerSlot,
} from "./world-layout.js";

/** Atomic splice of one peer slot (16 bytes) into the world blob. */
const LUA_PATCH_PEER_SLOT = `
local key = KEYS[1]
local offset = tonumber(ARGV[1])
local slot = ARGV[2]
local size = tonumber(ARGV[3])
local world = redis.call('GET', key)
if not world then
  world = string.rep(string.char(0), size)
elseif #world < size then
  world = world .. string.rep(string.char(0), size - #world)
elseif #world > size then
  world = string.sub(world, 1, size)
end
world = string.sub(world, 1, offset) .. slot .. string.sub(world, offset + #slot + 1)
redis.call('SET', key, world)
return size
`;

const WORLD_BROADCAST_HZ = 20;
const WORLD_BROADCAST_INTERVAL_MS = Math.floor(1000 / WORLD_BROADCAST_HZ);

const connectedSessions = new Set<string>();
const sessionClientIndex = new Map<string, number>();
let localWorld = createEmptyWorldBuffer();
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

function copyWorldBuffer(world: Float32Array): Buffer {
  return Buffer.from(world.buffer, world.byteOffset, world.byteLength);
}

function encodePeerSlot(
  clientIndex: number,
  x: number,
  y: number,
  active: number,
): Buffer {
  const floats = new Float32Array([clientIndex, x, y, active]);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

function broadcastWorldBuffer(
  world: Float32Array,
  targetSessionId?: string,
): void {
  const payload = copyWorldBuffer(world);
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
  for (const sessionId of connectedSessions) {
    try {
      sendBinaryToClient(sessionId, payload, "sync");
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      agentLog("error", `world send failed session=${sessionId}: ${detail}`);
    }
  }
}

async function loadWorldFromRedis(): Promise<Float32Array> {
  if (!redis) {
    return new Float32Array(localWorld);
  }
  const raw = await redis.getBuffer(REDIS_WORLD_KEY);
  return normalizeWorldBuffer(raw);
}

async function broadcastWorldFromRedis(
  targetSessionId?: string,
): Promise<void> {
  const world = await loadWorldFromRedis();
  broadcastWorldBuffer(world, targetSessionId);
}

function startBroadcastLoopIfNeeded(): void {
  if (broadcastTimer || connectedSessions.size === 0) {
    return;
  }
  broadcastTimer = setInterval(() => {
    void broadcastWorldFromRedis().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      agentLog("error", `world broadcast failed: ${detail}`);
    });
  }, WORLD_BROADCAST_INTERVAL_MS);
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
    connectedSessions.add(sessionId);
    startBroadcastLoopIfNeeded();
    await broadcastWorldFromRedis(sessionId);
  },

  async onClientLeave({ sessionId }) {
    connectedSessions.delete(sessionId);
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
