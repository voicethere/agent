/**
 * Multiplayer object-sync template with ownership checks.
 *
 * World layout:
 * - one global Float32Array (fixed MAX_LIVE_OBJECTS slots when Redis is enabled)
 * - each tracked object uses exactly 9 floats:
 *   [objectId, posX, posY, posZ, posW, dirX, dirY, dirZ, dirW]
 *
 * With project Redis (`AGENT_REDIS_URL`), the world blob (float32) is shared across
 * runner workers (key `game-sync:world`). World writes (allocate/release Lua, sim
 * commit) serialize on `game-sync:sim-lock`. The lock holds a random per-attempt token:
 * it is released by compare-and-delete, and every world write is conditional on the
 * token. The world is stored with `game-sync:sim-at` (Redis clock, ms); a step takes
 * dt = now - sim-at and is skipped when dt is under one sim interval, so any number of
 * pods simulate wall time once.
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
 * - server-authoritative movement at 60Hz (SIM_HZ)
 * - wall bounce + object-object elastic collisions on server
 * - clients render server snapshots; client binary writes are ignored
 * - with project Redis, the sim loop keeps running with zero connected clients so
 *   objects persist and keep moving after everyone disconnects
 *
 * Broadcast:
 * - 30Hz (BROADCAST_HZ, every 2nd sim tick) quantized world frame while the sim loop
 *   runs: u8 format 2, u8 version 1, u16le objectCount, then 18 B per live object (see
 *   world-layout.ts). Followers relay only when sim-at advanced.
 *
 * Build:
 *   npx @voicethere/agent build --entry templates/game-sync/agent.ts
 */
import { randomUUID } from "node:crypto";
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
  LUA_COMMIT_WORLD,
  LUA_READ_WORLD,
  LUA_RELEASE_LOCK,
  LUA_RELEASE_OBJECT,
  REDIS_EVAL_KEYS,
} from "./redis.js";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  BROADCAST_HZ,
  MAX_SPEED,
  MIN_SPEED,
  OBJECT_RADIUS,
  SIM_HZ,
  simulateWorldStep,
} from "./sim.js";
import {
  clampSimulationDtSec,
  collectActiveObjectIdsInto,
  countLiveObjects,
  createEmptyWorldBuffer,
  encodeLiveObjectsInto,
  findFirstEmptySlot,
  liveWorldSnapshot,
  markSlotFree,
  normalizeWorldBuffer,
  objectIdToSlot,
  MAX_FRAME_BYTES,
  planRedisSimTick,
  REDIS_SIM_AT_KEY,
  REDIS_SIM_LOCK_KEY,
  REDIS_WORLD_KEY,
  slotToObjectId,
  writeObjectSlot,
} from "./world-layout.js";

const SIM_INTERVAL_MS = Math.floor(1000 / SIM_HZ);
/** Every 2nd sim tick broadcasts (60 Hz sim, 30 Hz send). */
const BROADCAST_EVERY_N_TICKS = Math.round(SIM_HZ / BROADCAST_HZ);
const SIM_LOCK_TTL_MS = SIM_INTERVAL_MS * 2;
const SIM_LOCK_RETRY_MS = 5;
/** Allocate/release Lua result when the lock no longer holds this pod's token. */
const LUA_LOCK_LOST = -3;

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
let tickCount = 0;
/** One broadcast scratch frame per pod; the frame sent is a subarray of it (IPC copies synchronously). */
const frameScratch = Buffer.alloc(MAX_FRAME_BYTES);
/** From the last Redis read: stored sim-at (0 = none) and Redis' clock, both ms. */
let lastReadSimAt = 0;
let lastReadNowMs = 0;
/** sim-at of the last frame this pod broadcast; followers relay only when it advanced. */
let lastRelayedSimAt = 0;

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

async function releaseSimLock(token: string): Promise<void> {
  if (!redis) return;
  // Compare-and-delete: a holder whose TTL lapsed never deletes the next holder's lock.
  await redis.eval(LUA_RELEASE_LOCK, 1, REDIS_SIM_LOCK_KEY, token);
}

async function withRedisSimLock<T>(
  fn: (token: string) => Promise<T>,
  options?: { retryUntilAcquired?: boolean },
): Promise<T | null> {
  if (!redis) {
    return fn("");
  }

  const retryUntilAcquired = options?.retryUntilAcquired ?? true;
  const token = randomUUID();

  while (true) {
    const lockAcquired = await redis.set(
      REDIS_SIM_LOCK_KEY,
      token,
      "PX",
      SIM_LOCK_TTL_MS,
      "NX",
    );
    if (lockAcquired === "OK") {
      try {
        return await fn(token);
      } finally {
        await releaseSimLock(token);
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
  token: string,
): Promise<number | null> {
  if (!redis) {
    return registerObjectInMemory(sessionId);
  }

  const result = await redis.eval(
    LUA_ALLOCATE_OBJECT,
    2,
    REDIS_EVAL_KEYS.worldKey,
    REDIS_EVAL_KEYS.lockKey,
    REDIS_EVAL_KEYS.worldByteLength,
    REDIS_EVAL_KEYS.slotByteLength,
    REDIS_EVAL_KEYS.maxSlots,
    randomInitialTail(),
    REDIS_EVAL_KEYS.headers,
    token,
  );

  const objectId = Number(result);
  if (objectId === LUA_LOCK_LOST) {
    agentLog("warn", "register skipped: sim lock lost before the world write");
    return null;
  }
  if (!Number.isFinite(objectId) || objectId < 1) {
    return null;
  }

  attachObjectToSession(sessionId, objectId);
  await loadWorldFromRedis();
  return objectId;
}

async function releaseObjectInRedis(
  objectId: number,
  token: string,
): Promise<boolean> {
  detachObjectFromSession(objectId);
  if (!redis) {
    releaseObjectInMemory(objectId);
    return true;
  }

  const released = await redis.eval(
    LUA_RELEASE_OBJECT,
    2,
    REDIS_EVAL_KEYS.worldKey,
    REDIS_EVAL_KEYS.lockKey,
    REDIS_EVAL_KEYS.worldByteLength,
    REDIS_EVAL_KEYS.slotByteLength,
    REDIS_EVAL_KEYS.maxSlots,
    String(objectId),
    REDIS_EVAL_KEYS.headers,
    token,
  );
  if (Number(released) === LUA_LOCK_LOST) {
    agentLog("warn", "release skipped: sim lock lost before the world write");
  }
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
      return releaseObjectInRedis(target.objectId, "");
    }
    const result = await withRedisSimLock((token) =>
      releaseObjectInRedis(target.objectId, token),
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
  // Live objects only, quantized into the pod's one scratch buffer; one fan-out call.
  const length = encodeLiveObjectsInto(frameScratch, worldState);
  broadCastBinaryToClients(
    frameScratch.subarray(0, length),
    connectedSessionList,
    "sync",
  );
}

/**
 * One Lua read of the world, the stored sim-at and Redis' clock. The world is copied into
 * `worldState` in place (the reply is the only per-tick allocation we cannot avoid); sim-at
 * and now land in `lastReadSimAt` / `lastReadNowMs`.
 */
async function loadWorldFromRedis(): Promise<void> {
  if (!redis) return;
  const reply = (await redis.callBuffer(
    "EVAL",
    LUA_READ_WORLD,
    2,
    REDIS_WORLD_KEY,
    REDIS_SIM_AT_KEY,
  )) as Buffer[];
  normalizeWorldBuffer(reply[0], worldState);
  lastReadSimAt = reply[1]!.byteLength > 0 ? Number(reply[1]!.toString()) : 0;
  lastReadNowMs = Number(reply[2]!.toString());
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
    SIM_HZ,
  );
  lastTickTimeMs = now;
  return dt;
}

function stepWorldInPlace(dtSec: number): void {
  const count = collectActiveObjectIdsInto(worldState, activeObjectIds);
  simulateWorldStep(worldState, dtSec, activeObjectIds, count);
}

async function stepWorldInMemory(): Promise<void> {
  stepWorldInPlace(takeTickDtSec());
}

type StepOutcome = "stepped" | "skipped" | "lost";

/**
 * Leader step under the sim lock: dt comes from the stored sim-at (Redis clock). Below one
 * sim interval another pod already stepped this interval, so skip. The commit writes the
 * world and sim-at together only while the lock still holds `token`.
 */
async function stepWorldWithRedis(token: string): Promise<StepOutcome> {
  if (!redis) return "lost";
  await loadWorldFromRedis();
  const simAt = lastReadSimAt;
  const now = lastReadNowMs;
  if (simAt !== 0 && now - simAt < SIM_INTERVAL_MS) return "skipped";
  stepWorldInPlace(clampSimulationDtSec(simAt === 0 ? 0 : now - simAt, SIM_HZ));
  const written = await redis.eval(
    LUA_COMMIT_WORLD,
    3,
    REDIS_SIM_LOCK_KEY,
    REDIS_WORLD_KEY,
    REDIS_SIM_AT_KEY,
    token,
    worldStateBytes,
    String(now),
  );
  if (Number(written) !== 1) return "lost";
  lastReadSimAt = now;
  return "stepped";
}

async function runRedisTick(): Promise<void> {
  tickCount += 1;
  const broadcastDue = tickCount % BROADCAST_EVERY_N_TICKS === 0;
  const outcome = await withRedisSimLock(stepWorldWithRedis, SIM_LOCK_TRY_ONCE);
  if (outcome === "lost") return;
  if (outcome === null) {
    if (!broadcastDue) return;
    if (planRedisSimTick(SIM_TICK_PLAN_INPUT) !== "relay") return;
    await loadWorldFromRedis();
  }
  if (!broadcastDue || connectedSessionList.length === 0) return;
  // Relay only when sim-at advanced since this pod's last frame.
  if (lastReadSimAt <= lastRelayedSimAt) return;
  lastRelayedSimAt = lastReadSimAt;
  broadcastWorldBuffer();
}

// Tick bodies are module-level functions (no per-tick closures or option objects).
async function runSimulationTick(): Promise<void> {
  if (!redis) {
    tickCount += 1;
    await withWorldMutation(stepWorldInMemory);
    if (tickCount % BROADCAST_EVERY_N_TICKS === 0) broadcastWorldBuffer();
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

  broadcastTimer = setInterval(onBroadcastTick, SIM_INTERVAL_MS);
  agentLog(
    "info",
    `world loop started (sim ${SIM_HZ}Hz, broadcast ${BROADCAST_HZ}Hz)`,
  );
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
        const result = await withRedisSimLock((token) =>
          registerObjectInRedis(ctx.sessionId, token),
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
