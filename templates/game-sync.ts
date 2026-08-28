/**
 * Multiplayer object-sync template with ownership checks.
 *
 * World layout:
 * - one global Float32Array (fixed MAX_LIVE_OBJECTS slots when Redis is enabled)
 * - each tracked object uses exactly 9 floats:
 *   [objectId, posX, posY, posZ, posW, dirX, dirY, dirZ, dirW]
 *
 * With project Redis (`AGENT_REDIS_URL`), the world blob is shared across runner
 * workers (key `game-sync:world`). One worker holds a sim lock per tick, runs
 * physics, and writes the blob; every worker GET+broadcasts to local sessions.
 *
 * Control messages:
 * - `{ type: "register" }` -> allocates (or reuses) one 9-float slot
 * - server replies `{ type: "register_ack", objectId }`
 * - `{ type: "register_nack", reason: "world_full", maxObjects: 25 }` when cap reached
 * - `{ type: "unregister" }` or `{ type: "remove", objectId?: number }` -> releases owned object(s)
 * - `{ type: "unregister_ack", objectId }` or `{ type: "unregister_nack", reason }`
 *
 * Simulation:
 * - server-authoritative movement at 60Hz
 * - wall bounce + object-object elastic collisions on server
 * - clients render server snapshots; client binary writes are ignored
 *
 * Broadcast:
 * - 60Hz world-state broadcast starts when at least 1 client is connected
 * - stops when connected client count drops below 1
 *
 * Build:
 *   npx @voicethere/agent build --entry templates/game-sync.ts
 */
import Redis from "ioredis";
import {
  agentLog,
  defineAgent,
  sendBinaryToClient,
  sendToClient,
} from "@voicethere/agent";

import {
  MAX_LIVE_OBJECTS,
  parseChatCommand,
  parseRegisterCommand,
  parseUnregisterCommand,
  REGISTER_NACK_REASON_WORLD_FULL,
  UNREGISTER_NACK_REASON_NOT_FOUND,
  UNREGISTER_NACK_REASON_NOT_OWNER,
} from "./game-sync-protocol.js";
import {
  LUA_ALLOCATE_OBJECT,
  LUA_RELEASE_OBJECT,
  REDIS_EVAL_KEYS,
} from "./game-sync-redis.js";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  OBJECT_RADIUS,
  simulateWorldStep,
} from "./game-sync-sim.js";
import {
  collectActiveObjectIds,
  countLiveObjects,
  createEmptyWorldBuffer,
  findFirstEmptySlot,
  markSlotFree,
  normalizeWorldBuffer,
  objectIdToSlot,
  OBJECT_SLOT_BYTE_LENGTH,
  REDIS_SIM_LOCK_KEY,
  REDIS_WORLD_KEY,
  slotToObjectId,
  writeObjectSlot,
} from "./game-sync-world-layout.js";

const BROADCAST_HZ = 60;
const BROADCAST_INTERVAL_MS = Math.floor(1000 / BROADCAST_HZ);
const SIM_LOCK_TTL_MS = BROADCAST_INTERVAL_MS * 2;
const MIN_SPEED = 90;
const MAX_SPEED = 180;

const connectedSessions = new Set<string>();
const objectOwners = new Map<number, string>();
const sessionObjects = new Map<string, Set<number>>();
const freeSlots: number[] = [];

let worldState = createEmptyWorldBuffer();
let redis: Redis | null = null;
let broadcastTimer: NodeJS.Timeout | null = null;

interface TrackedObjectInfo {
  objectId: number;
  ownerSessionId: string;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomVelocity(): number {
  return (Math.random() < 0.5 ? -1 : 1) * rand(MIN_SPEED, MAX_SPEED);
}

function randomInitialTail(): Buffer {
  const floats = new Float32Array([
    rand(OBJECT_RADIUS, BOARD_WIDTH - OBJECT_RADIUS),
    rand(OBJECT_RADIUS, BOARD_HEIGHT - OBJECT_RADIUS),
    0,
    1,
    randomVelocity(),
    randomVelocity(),
    0,
    0,
  ]);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

function attachObjectToSession(sessionId: string, objectId: number): void {
  let owned = sessionObjects.get(sessionId);
  if (!owned) {
    owned = new Set<number>();
    sessionObjects.set(sessionId, owned);
  }
  owned.add(objectId);
  objectOwners.set(objectId, sessionId);
}

function detachObjectFromSession(objectId: number): void {
  const owner = objectOwners.get(objectId);
  if (owner) {
    const owned = sessionObjects.get(owner);
    owned?.delete(objectId);
    if (owned && owned.size === 0) {
      sessionObjects.delete(owner);
    }
  }
  objectOwners.delete(objectId);
}

function allocateSlotInMemory(): number | null {
  if (countLiveObjects(worldState) >= MAX_LIVE_OBJECTS) {
    return null;
  }

  const reused = freeSlots.shift();
  if (reused !== undefined) {
    return reused;
  }

  return findFirstEmptySlot(worldState);
}

function releaseObjectInMemory(objectId: number): void {
  const slot = objectIdToSlot(objectId);
  if (slot < 0 || slot >= MAX_LIVE_OBJECTS) return;

  markSlotFree(worldState, slot);
  if (!freeSlots.includes(slot)) {
    freeSlots.push(slot);
    freeSlots.sort((a, b) => a - b);
  }
}

function registerObjectInMemory(sessionId: string): number | null {
  const slot = allocateSlotInMemory();
  if (slot === null) {
    return null;
  }

  const objectId = slotToObjectId(slot);
  writeObjectSlot(
    worldState,
    slot,
    objectId,
    rand(OBJECT_RADIUS, BOARD_WIDTH - OBJECT_RADIUS),
    rand(OBJECT_RADIUS, BOARD_HEIGHT - OBJECT_RADIUS),
    0,
    1,
    randomVelocity(),
    randomVelocity(),
    0,
    0,
  );
  attachObjectToSession(sessionId, objectId);
  return objectId;
}

async function registerObjectInRedis(
  sessionId: string,
): Promise<number | null> {
  if (!redis) {
    return registerObjectInMemory(sessionId);
  }

  const result = await redis.eval(
    LUA_ALLOCATE_OBJECT,
    1,
    REDIS_EVAL_KEYS.worldKey,
    REDIS_EVAL_KEYS.worldByteLength,
    REDIS_EVAL_KEYS.slotByteLength,
    REDIS_EVAL_KEYS.maxSlots,
    randomInitialTail(),
    REDIS_EVAL_KEYS.headers,
  );

  const objectId = Number(result);
  if (!Number.isFinite(objectId) || objectId < 1) {
    return null;
  }

  attachObjectToSession(sessionId, objectId);
  return objectId;
}

async function releaseObjectInRedis(objectId: number): Promise<boolean> {
  detachObjectFromSession(objectId);
  if (!redis) {
    releaseObjectInMemory(objectId);
    return true;
  }

  const released = await redis.eval(
    LUA_RELEASE_OBJECT,
    1,
    REDIS_EVAL_KEYS.worldKey,
    REDIS_EVAL_KEYS.worldByteLength,
    REDIS_EVAL_KEYS.slotByteLength,
    REDIS_EVAL_KEYS.maxSlots,
    String(objectId),
    REDIS_EVAL_KEYS.headers,
  );
  return Number(released) === 1;
}

function highestOwnedObjectId(sessionId: string): number | null {
  const owned = sessionObjects.get(sessionId);
  if (!owned || owned.size === 0) return null;
  return Math.max(...owned);
}

async function unregisterObject(
  sessionId: string,
  objectId?: number,
): Promise<{ ok: true; objectId: number } | { ok: false; reason: string }> {
  const owned = sessionObjects.get(sessionId);
  if (!owned || owned.size === 0) {
    return { ok: false, reason: UNREGISTER_NACK_REASON_NOT_FOUND };
  }

  let targetId = objectId;
  if (targetId === undefined) {
    const highest = highestOwnedObjectId(sessionId);
    if (highest === null) {
      return { ok: false, reason: UNREGISTER_NACK_REASON_NOT_FOUND };
    }
    targetId = highest;
  }

  if (!owned.has(targetId)) {
    if (objectId !== undefined) {
      return { ok: false, reason: UNREGISTER_NACK_REASON_NOT_OWNER };
    }
    return { ok: false, reason: UNREGISTER_NACK_REASON_NOT_FOUND };
  }

  notifyObjectReleased(targetId, sessionId);
  await releaseObjectInRedis(targetId);
  return { ok: true, objectId: targetId };
}

function trackedObjectsSnapshot(): TrackedObjectInfo[] {
  const objects: TrackedObjectInfo[] = [];
  for (const [objectId, ownerSessionId] of objectOwners) {
    objects.push({ objectId, ownerSessionId });
  }
  objects.sort((a, b) => a.objectId - b.objectId);
  return objects;
}

function notifyObjectRegistered(
  objectId: number,
  ownerSessionId: string,
): void {
  for (const sessionId of connectedSessions) {
    if (sessionId === ownerSessionId) continue;
    sendToClient(sessionId, {
      type: "object_registered",
      objectId,
      ownerSessionId,
    });
  }
}

function notifyObjectReleased(objectId: number, ownerSessionId: string): void {
  for (const sessionId of connectedSessions) {
    if (sessionId === ownerSessionId) continue;
    sendToClient(sessionId, {
      type: "object_released",
      objectId,
      ownerSessionId,
    });
  }
}

function copyWorldBuffer(world: Float32Array): Buffer {
  return Buffer.from(world.buffer, world.byteOffset, world.byteLength);
}

function broadcastWorldBuffer(world: Float32Array): void {
  if (connectedSessions.size === 0) return;
  const payload = copyWorldBuffer(world);
  for (const sessionId of connectedSessions) {
    sendBinaryToClient(sessionId, payload, "sync");
  }
}

async function loadWorldFromRedis(): Promise<Float32Array> {
  if (!redis) {
    return new Float32Array(worldState);
  }
  const raw = await redis.getBuffer(REDIS_WORLD_KEY);
  return normalizeWorldBuffer(raw);
}

async function saveWorldToRedis(world: Float32Array): Promise<void> {
  if (!redis) return;
  await redis.setBuffer(REDIS_WORLD_KEY, copyWorldBuffer(world));
}

async function runSimulationTick(): Promise<void> {
  if (!redis) {
    const activeObjectIds = [...objectOwners.keys()];
    simulateWorldStep(worldState, 1 / BROADCAST_HZ, activeObjectIds);
    broadcastWorldBuffer(worldState);
    return;
  }

  const lockAcquired = await redis.set(
    REDIS_SIM_LOCK_KEY,
    "1",
    "PX",
    SIM_LOCK_TTL_MS,
    "NX",
  );
  if (lockAcquired === "OK") {
    const world = await loadWorldFromRedis();
    const activeObjectIds = collectActiveObjectIds(world);
    simulateWorldStep(world, 1 / BROADCAST_HZ, activeObjectIds);
    await saveWorldToRedis(world);
    worldState = world;
  }

  const world = await loadWorldFromRedis();
  worldState = world;
  broadcastWorldBuffer(world);
}

function startBroadcastLoopIfNeeded(): void {
  if (broadcastTimer) return;
  if (connectedSessions.size < 1) return;

  broadcastTimer = setInterval(() => {
    if (connectedSessions.size < 1) {
      if (broadcastTimer) {
        clearInterval(broadcastTimer);
        broadcastTimer = null;
      }
      return;
    }
    void runSimulationTick().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      agentLog("error", `world tick failed: ${detail}`);
    });
  }, BROADCAST_INTERVAL_MS);

  agentLog("info", `world loop started (${BROADCAST_HZ}Hz)`);
}

function stopBroadcastLoopIfNeeded(): void {
  if (connectedSessions.size >= 1) return;
  if (!broadcastTimer) return;
  clearInterval(broadcastTimer);
  broadcastTimer = null;
  agentLog("info", "world loop stopped");
}

async function ensureRedisWorldInitialized(): Promise<void> {
  if (!redis) return;
  const existing = await redis.getBuffer(REDIS_WORLD_KEY);
  if (!existing || existing.byteLength === 0) {
    const empty = createEmptyWorldBuffer();
    await redis.setBuffer(REDIS_WORLD_KEY, copyWorldBuffer(empty));
  }
}

defineAgent({
  async onAgentStart({ env }) {
    const redisUrl = env.AGENT_REDIS_URL ?? process.env.AGENT_REDIS_URL;
    if (!redisUrl?.trim()) {
      agentLog(
        "warn",
        "AGENT_REDIS_URL unset — game-sync uses per-worker in-memory world only",
      );
      worldState = createEmptyWorldBuffer();
      return;
    }

    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    await redis.connect();
    worldState = createEmptyWorldBuffer();
    await ensureRedisWorldInitialized();
    agentLog("info", "game-sync agent connected to project Redis world buffer");
  },

  onClientJoin({ sessionId }) {
    connectedSessions.add(sessionId);
    startBroadcastLoopIfNeeded();
    sendToClient(sessionId, {
      type: "world_snapshot",
      objects: trackedObjectsSnapshot(),
    });
    agentLog("info", `join ${sessionId} connected=${connectedSessions.size}`);
  },

  async onClientLeave({ sessionId }) {
    connectedSessions.delete(sessionId);

    const owned = sessionObjects.get(sessionId);
    if (owned) {
      for (const objectId of [...owned]) {
        notifyObjectReleased(objectId, sessionId);
        await releaseObjectInRedis(objectId);
      }
      sessionObjects.delete(sessionId);
    }

    stopBroadcastLoopIfNeeded();
    agentLog(
      "info",
      `leave ${sessionId} connected=${connectedSessions.size} live=${countLiveObjects(worldState)}`,
    );
  },

  async onDataChannelMessage(ctx) {
    if (parseRegisterCommand(ctx.message)) {
      const objectId = redis
        ? await registerObjectInRedis(ctx.sessionId)
        : registerObjectInMemory(ctx.sessionId);
      if (objectId === null) {
        sendToClient(ctx.sessionId, {
          type: "register_nack",
          reason: REGISTER_NACK_REASON_WORLD_FULL,
          maxObjects: MAX_LIVE_OBJECTS,
        });
        agentLog(
          "info",
          `register_nack world_full session=${ctx.sessionId} redis=${Boolean(redis)}`,
        );
        return;
      }
      sendToClient(ctx.sessionId, { type: "register_ack", objectId });
      notifyObjectRegistered(objectId, ctx.sessionId);
      agentLog(
        "info",
        `register session=${ctx.sessionId} objectId=${objectId}`,
      );
      return;
    }

    const unregister = parseUnregisterCommand(ctx.message);
    if (unregister) {
      const result = await unregisterObject(ctx.sessionId, unregister.objectId);
      if (!result.ok) {
        sendToClient(ctx.sessionId, {
          type: "unregister_nack",
          reason: result.reason,
        });
        agentLog(
          "info",
          `unregister_nack session=${ctx.sessionId} reason=${result.reason}`,
        );
        return;
      }
      sendToClient(ctx.sessionId, {
        type: "unregister_ack",
        objectId: result.objectId,
      });
      agentLog(
        "info",
        `unregister_ack session=${ctx.sessionId} objectId=${result.objectId}`,
      );
      return;
    }

    const chat = parseChatCommand(ctx.message);
    if (!chat) return;
    for (const sessionId of connectedSessions) {
      sendToClient(sessionId, {
        type: "chat_broadcast",
        senderSessionId: ctx.sessionId,
        text: chat.text,
      });
    }
  },

  onDataChannelBinary(ctx) {
    void ctx;
  },
});

// Re-export layout helpers for unit tests.
export {
  countLiveObjects,
  findFirstEmptySlot,
  markSlotFree,
  readSlotObjectId,
  slotToObjectId,
  writeObjectSlot,
} from "./game-sync-world-layout.js";
export { simulateWorldStep } from "./game-sync-sim.js";
