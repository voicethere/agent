/**
 * Multiplayer object-sync template with ownership checks.
 *
 * World layout:
 * - one global Float32Array (fixed MAX_LIVE_OBJECTS slots when Redis is enabled)
 * - each tracked object uses exactly 9 floats:
 *   [objectId, posX, posY, posZ, posW, dirX, dirY, dirZ, dirW]
 *
 * With project Redis (`AGENT_REDIS_URL`), the world blob is shared across runner
 * workers (key `game-sync:world`). World writes (allocate/release Lua, sim SET)
 * serialize on `game-sync:sim-lock`; one holder runs physics per tick.
 *
 * Control messages:
 * - `{ type: "register" }` -> allocates (or reuses) one 9-float slot
 * - server replies `{ type: "register_ack", objectId }`
 * - `{ type: "register_nack", reason: "world_full", maxObjects: 25 }` when cap reached
 * - `{ type: "remove", objectId }` or `{ type: "unregister", objectId?: number }` ->
 *   zeros that live slot (objectId required for click-to-remove; omit objectId on
 *   unregister to drop the highest object owned by this session)
 * - `{ type: "unregister_ack", objectId }` or `{ type: "unregister_nack", reason }`
 *
 * Simulation:
 * - server-authoritative movement at 60Hz
 * - wall bounce + object-object elastic collisions on server
 * - clients render server snapshots; client binary writes are ignored
 * - with project Redis, the sim loop keeps running with zero connected clients so
 *   objects persist and keep moving after everyone disconnects
 *
 * Broadcast:
 * - 60Hz world-state broadcast while the sim loop runs (no-op send when 0 sessions)
 *
 * Build:
 *   npx @voicethere/agent build --entry templates/game-sync/agent.ts
 */
import { Redis } from "ioredis";
import {
  agentLog,
  broadCastBinaryToClients,
  defineAgent,
  sendToClient,
} from "@voicethere/agent";

import {
  MAX_LIVE_OBJECTS,
  parseChatCommand,
  parseRegisterCommand,
  parseUnregisterCommand,
  resolveRemoveTarget,
  REGISTER_NACK_REASON_WORLD_FULL,
  UNREGISTER_NACK_REASON_NOT_FOUND,
} from "./protocol.js";
import {
  LUA_ALLOCATE_OBJECT,
  LUA_RELEASE_OBJECT,
  REDIS_EVAL_KEYS,
} from "./redis.js";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  OBJECT_RADIUS,
  simulateWorldStep,
} from "./sim.js";
import {
  clampSimulationDtSec,
  collectActiveObjectIdsInto,
  countLiveObjects,
  createEmptyWorldBuffer,
  findFirstEmptySlot,
  liveWorldSnapshot,
  markSlotFree,
  normalizeWorldBuffer,
  objectIdToSlot,
  planRedisSimTick,
  REDIS_SIM_LOCK_KEY,
  REDIS_WORLD_KEY,
  slotToObjectId,
  writeObjectSlot,
} from "./world-layout.js";

const BROADCAST_HZ = 60;
const BROADCAST_INTERVAL_MS = Math.floor(1000 / BROADCAST_HZ);
const SIM_LOCK_TTL_MS = BROADCAST_INTERVAL_MS * 2;
const SIM_LOCK_RETRY_MS = 5;
const MIN_SPEED = 90;
const MAX_SPEED = 180;

const connectedSessions = new Set<string>();
/** Same members as connectedSessions; array form lets the broadcast skip Set iteration. */
const connectedSessionList: string[] = [];
const objectOwners = new Map<number, string>();
const sessionObjects = new Map<string, Set<number>>();
const freeSlots: number[] = [];

/** The one world buffer: Redis loads copy into it, sim/broadcast/SET read from it. */
const worldState = createEmptyWorldBuffer();
const worldStateBytes = Buffer.from(
  worldState.buffer,
  worldState.byteOffset,
  worldState.byteLength,
);
let redis: Redis | null = null;
let broadcastTimer: NodeJS.Timeout | null = null;
let worldMutationChain: Promise<void> = Promise.resolve();
let lastTickTimeMs = 0;

function withWorldMutation<T>(fn: () => Promise<T>): Promise<T> {
  const run = worldMutationChain.then(fn);
  worldMutationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withRedisSimLock<T>(
  fn: () => Promise<T>,
  options?: { retryUntilAcquired?: boolean },
): Promise<T | null> {
  if (!redis) {
    return fn();
  }

  const retryUntilAcquired = options?.retryUntilAcquired ?? true;

  while (true) {
    const lockAcquired = await redis.set(
      REDIS_SIM_LOCK_KEY,
      "1",
      "PX",
      SIM_LOCK_TTL_MS,
      "NX",
    );
    if (lockAcquired === "OK") {
      try {
        return await fn();
      } finally {
        await redis.del(REDIS_SIM_LOCK_KEY);
      }
    }
    if (!retryUntilAcquired) {
      return null;
    }
    await sleep(SIM_LOCK_RETRY_MS);
  }
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomVelocity(): number {
  return (Math.random() < 0.5 ? -1 : 1) * rand(MIN_SPEED, MAX_SPEED);
}

const INITIAL_TAIL = new Float32Array(8);
const INITIAL_TAIL_BUF = Buffer.from(
  INITIAL_TAIL.buffer,
  INITIAL_TAIL.byteOffset,
  INITIAL_TAIL.byteLength,
);

function randomInitialTail(): Buffer {
  INITIAL_TAIL[0] = rand(OBJECT_RADIUS, BOARD_WIDTH - OBJECT_RADIUS);
  INITIAL_TAIL[1] = rand(OBJECT_RADIUS, BOARD_HEIGHT - OBJECT_RADIUS);
  INITIAL_TAIL[2] = 0;
  INITIAL_TAIL[3] = 1;
  INITIAL_TAIL[4] = randomVelocity();
  INITIAL_TAIL[5] = randomVelocity();
  INITIAL_TAIL[6] = 0;
  INITIAL_TAIL[7] = 0;
  return INITIAL_TAIL_BUF;
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
  await loadWorldFromRedis();
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
  if (Number(released) === 1) {
    await loadWorldFromRedis();
  }
  return Number(released) === 1;
}

async function unregisterObject(
  sessionId: string,
  objectId?: number,
): Promise<{ ok: true; objectId: number } | { ok: false; reason: string }> {
  const owned = sessionObjects.get(sessionId);
  const target = resolveRemoveTarget(objectId, owned);
  if (!target.ok) {
    return target;
  }

  const previousOwner = objectOwners.get(target.objectId) ?? sessionId;
  notifyObjectReleased(target.objectId, previousOwner);
  const released = await withWorldMutation(async () => {
    if (!redis) {
      return releaseObjectInRedis(target.objectId);
    }
    const result = await withRedisSimLock(() =>
      releaseObjectInRedis(target.objectId),
    );
    return result === true;
  });
  if (!released) {
    return { ok: false, reason: UNREGISTER_NACK_REASON_NOT_FOUND };
  }
  return { ok: true, objectId: target.objectId };
}

function broadcastWorldSnapshot(): void {
  const objects = liveWorldSnapshot(worldState, objectOwners);
  for (const sessionId of connectedSessions) {
    sendToClient(sessionId, { type: "world_snapshot", objects });
  }
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

function broadcastWorldBuffer(): void {
  if (connectedSessionList.length === 0) return;
  // worldStateBytes is already a Buffer: forwarded as-is, one call, no iterator.
  broadCastBinaryToClients(worldStateBytes, connectedSessionList, "sync");
}

/**
 * Copy the Redis blob into `worldState` in place (the GET reply is the only
 * per-tick allocation; it is a fresh socket Buffer we cannot avoid).
 */
async function loadWorldFromRedis(): Promise<void> {
  if (!redis) return;
  const raw = await redis.getBuffer(REDIS_WORLD_KEY);
  normalizeWorldBuffer(raw, worldState);
}

async function saveWorldToRedis(): Promise<void> {
  if (!redis) return;
  await redis.set(REDIS_WORLD_KEY, worldStateBytes);
}

/** Live object ids for the current tick; filled in place, never reallocated. */
const activeObjectIds = new Int32Array(MAX_LIVE_OBJECTS);

const SIM_LOCK_TRY_ONCE = { retryUntilAcquired: false } as const;
const SIM_TICK_PLAN_INPUT = { lockAcquired: false, connectedSessions } as const;

/**
 * Elapsed seconds since the previous tick body ran. Measured inside the
 * serialized mutation chain so queued ticks never share or overwrite a dt.
 */
function takeTickDtSec(): number {
  const now = Date.now();
  const dt = clampSimulationDtSec(
    lastTickTimeMs === 0 ? 0 : now - lastTickTimeMs,
    BROADCAST_HZ,
  );
  lastTickTimeMs = now;
  return dt;
}

function stepWorldInPlace(): void {
  const dt = takeTickDtSec();
  const count = collectActiveObjectIdsInto(worldState, activeObjectIds);
  simulateWorldStep(worldState, dt, activeObjectIds, count);
}

async function stepWorldInMemory(): Promise<void> {
  stepWorldInPlace();
}

async function stepWorldWithRedis(): Promise<boolean> {
  await loadWorldFromRedis();
  stepWorldInPlace();
  await saveWorldToRedis();
  broadcastWorldBuffer();
  return true;
}

async function runRedisTick(): Promise<void> {
  const lockResult = await withRedisSimLock(
    stepWorldWithRedis,
    SIM_LOCK_TRY_ONCE,
  );
  if (lockResult !== null) return;
  takeTickDtSec();
  if (planRedisSimTick(SIM_TICK_PLAN_INPUT) === "relay") {
    await loadWorldFromRedis();
    broadcastWorldBuffer();
  }
}

// Tick bodies are module-level functions (no per-tick closures or option objects).
async function runSimulationTick(): Promise<void> {
  if (!redis) {
    await withWorldMutation(stepWorldInMemory);
    broadcastWorldBuffer();
    return;
  }
  await withWorldMutation(runRedisTick);
}

function logTickError(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  agentLog("error", `world tick failed: ${detail}`);
}

function onBroadcastTick(): void {
  if (!redis && connectedSessions.size < 1) {
    if (broadcastTimer) {
      clearInterval(broadcastTimer);
      broadcastTimer = null;
    }
    return;
  }
  void runSimulationTick().catch(logTickError);
}

function startBroadcastLoopIfNeeded(): void {
  if (broadcastTimer) return;
  if (!redis && connectedSessions.size < 1) return;

  broadcastTimer = setInterval(onBroadcastTick, BROADCAST_INTERVAL_MS);
  agentLog("info", `world loop started (${BROADCAST_HZ}Hz)`);
}

function stopBroadcastLoopIfNeeded(): void {
  if (redis) return;
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
    await redis.set(REDIS_WORLD_KEY, worldStateBytes);
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
      return;
    }

    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    await redis.connect();
    await ensureRedisWorldInitialized();
    await loadWorldFromRedis();
    startBroadcastLoopIfNeeded();
    agentLog("info", "game-sync agent connected to project Redis world buffer");
  },

  async onClientJoin({ sessionId }) {
    if (!connectedSessions.has(sessionId)) {
      connectedSessions.add(sessionId);
      connectedSessionList.push(sessionId);
    }
    startBroadcastLoopIfNeeded();
    await loadWorldFromRedis();
    sendToClient(sessionId, {
      type: "world_snapshot",
      objects: liveWorldSnapshot(worldState, objectOwners),
    });
    agentLog("info", `join ${sessionId} connected=${connectedSessions.size}`);
  },

  async onClientLeave({ sessionId }) {
    if (connectedSessions.delete(sessionId)) {
      const index = connectedSessionList.indexOf(sessionId);
      if (index !== -1) {
        connectedSessionList.splice(index, 1);
      }
    }
    for (const [objectId, ownerSessionId] of objectOwners) {
      if (ownerSessionId === sessionId) {
        objectOwners.delete(objectId);
      }
    }
    sessionObjects.delete(sessionId);
    stopBroadcastLoopIfNeeded();
    agentLog(
      "info",
      `leave ${sessionId} connected=${connectedSessions.size} live=${countLiveObjects(worldState)}`,
    );
  },

  async onDataChannelMessage(ctx) {
    if (parseRegisterCommand(ctx.message)) {
      const objectId = await withWorldMutation(async () => {
        if (!redis) {
          return registerObjectInMemory(ctx.sessionId);
        }
        const result = await withRedisSimLock(() =>
          registerObjectInRedis(ctx.sessionId),
        );
        return result;
      });
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
      broadcastWorldSnapshot();
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
      broadcastWorldSnapshot();
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
} from "./world-layout.js";
export { simulateWorldStep } from "./sim.js";
