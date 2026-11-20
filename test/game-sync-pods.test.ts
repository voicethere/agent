/**
 * game-sync correctness with several pods on one project Redis
 * (plan 2026-11-20-sync-template-efficiency, chunk 1 failing tests; chunk 3 fixed them).
 *
 * Both failed on bc68e5f's template. Needs a reachable Redis (helpers/test-redis.ts);
 * skipped without one, like the other Redis tests.
 *
 * Each pod is a fresh import of templates/game-sync/agent.ts (own module state);
 * `defineAgent` is mocked so the handlers are called directly. The template's
 * setInterval is captured, never fired by a clock: the test runs each pod's tick
 * on demand and waits until that pod has no Redis command in flight.
 *
 * db 14: game-sync-redis-agent.test.ts uses the same keys on db 15.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  normalizeWorldBuffer,
  REDIS_SIM_AT_KEY,
  REDIS_SIM_LOCK_KEY,
  REDIS_WORLD_KEY,
  writeObjectSlot,
  createEmptyWorldBuffer,
} from "../templates/game-sync/world-layout.js";
import { Redis } from "ioredis";

import {
  agentMockFactory,
  loadPod,
  meterState,
  resetMeter,
} from "./helpers/sync-pods.js";
import { openTestRedis, type TestRedis } from "./helpers/test-redis.js";

vi.mock("@voicethere/agent", (importOriginal) =>
  agentMockFactory(importOriginal as () => Promise<Record<string, unknown>>),
);

type RedisHooks = { evalGate: Promise<void> | null; pending: number };
const hooks = vi.hoisted(() => ({ evalGate: null, pending: 0 }) as RedisHooks);

vi.mock("ioredis", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("ioredis");
  class TrackedRedis extends actual.Redis {
    override sendCommand(
      ...args: Parameters<InstanceType<typeof actual.Redis>["sendCommand"]>
    ): ReturnType<InstanceType<typeof actual.Redis>["sendCommand"]> {
      hooks.pending += 1;
      const done = () => {
        hooks.pending -= 1;
      };
      args[0].promise.then(done, done);
      return super.sendCommand(...args);
    }

    override async eval(...args: unknown[]): Promise<unknown> {
      if (hooks.evalGate) await hooks.evalGate;
      return (super.eval as (...a: unknown[]) => Promise<unknown>)(...args);
    }
  }
  return { ...actual, Redis: TrackedRedis, default: TrackedRedis };
});

const harness: TestRedis | null = await openTestRedis();
/** db 14: game-sync-redis-agent.test.ts uses the same keys on db 15. */
const podsUrl = harness
  ? (() => {
      const u = new URL(harness.url);
      u.pathname = "/14";
      return u.toString();
    })()
  : "";
/** This file's own client for every seed, read and DEL (db 14). */
const podsRedis: Redis | null = harness
  ? new Redis(podsUrl, { maxRetriesPerRequest: 1 })
  : null;

/** No Redis command in flight across two macrotask turns: the tick chain ended. */
async function waitRedisIdle(timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let idleTurns = 0;
  while (idleTurns < 2) {
    if (Date.now() > deadline) throw new Error("redis did not go idle");
    await new Promise((resolve) => setImmediate(resolve));
    idleTurns = hooks.pending === 0 ? idleTurns + 1 : 0;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type Pod = { tick: () => void; join: (sessionId: string) => Promise<void> };

const intervalCallbacks: Array<() => void> = [];

async function startPod(): Promise<Pod> {
  const before = intervalCallbacks.length;
  const pod = await loadPod(
    () => import("../templates/game-sync/agent.js"),
    () => vi.resetModules(),
  );
  await pod.onAgentStart?.({ env: { AGENT_REDIS_URL: podsUrl } } as never);
  if (intervalCallbacks.length !== before + 1) {
    throw new Error("game-sync pod did not start exactly one sim interval");
  }
  const tick = intervalCallbacks[intervalCallbacks.length - 1]!;
  const join = async (sessionId: string): Promise<void> => {
    await pod.onClientJoin?.({ sessionId } as never);
  };
  return { tick, join };
}

async function readObjectX(): Promise<number> {
  const world = normalizeWorldBuffer(
    await podsRedis!.getBuffer(REDIS_WORLD_KEY),
  );
  return world[1]!;
}

describe.skipIf(!harness)("game-sync pods on one Redis", () => {
  beforeEach(async () => {
    hooks.evalGate = null;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: () => void,
    ) => {
      intervalCallbacks.push(callback);
      return { unref() {}, ref() {} } as unknown as NodeJS.Timeout;
    }) as typeof setInterval);
    await podsRedis!.del(REDIS_WORLD_KEY, REDIS_SIM_LOCK_KEY, REDIS_SIM_AT_KEY);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    hooks.evalGate = null;
    await waitRedisIdle();
    await podsRedis!.del(REDIS_WORLD_KEY, REDIS_SIM_LOCK_KEY, REDIS_SIM_AT_KEY);
  });

  afterAll(async () => {
    podsRedis?.disconnect();
    await harness?.close();
  });

  it("TestSimLockReleaseKeepsOtherHolder", async () => {
    const podA = await loadPod(
      () => import("../templates/game-sync/agent.js"),
      () => vi.resetModules(),
    );
    await podA.onAgentStart?.({
      env: { AGENT_REDIS_URL: podsUrl },
    } as never);
    await podA.onClientJoin?.({ sessionId: "lock-a" } as never);

    // A's register parks inside its critical section (allocate eval) holding
    // the sim lock until the test releases it, past the 32 ms TTL.
    let release!: () => void;
    hooks.evalGate = new Promise<void>((r) => {
      release = r;
    });
    const registered = podA.onDataChannelMessage?.({
      sessionId: "lock-a",
      message: { type: "register" },
    } as never);

    await vi.waitFor(
      async () => {
        expect(await podsRedis!.get(REDIS_SIM_LOCK_KEY)).not.toBeNull();
      },
      { timeout: 1_000, interval: 1 },
    );
    // A's lock expires while A is still inside its critical section.
    await vi.waitFor(
      async () => {
        expect(await podsRedis!.get(REDIS_SIM_LOCK_KEY)).toBeNull();
      },
      { timeout: 1_000, interval: 2 },
    );
    // Pod B takes the lock.
    expect(
      await podsRedis!.set(REDIS_SIM_LOCK_KEY, "holder-b", "PX", 10_000, "NX"),
    ).toBe("OK");

    hooks.evalGate = null;
    release();
    await registered;
    // A's release must not delete B's lock.
    expect(await podsRedis!.get(REDIS_SIM_LOCK_KEY)).toBe("holder-b");
    await podA.onClientLeave?.({ sessionId: "lock-a" } as never);
  });

  it("two pods ticking in one 16 ms window simulate wall time once", async () => {
    // One object moving +x at 100 px/s, far from walls.
    const VX = 100;
    const world = createEmptyWorldBuffer();
    writeObjectSlot(world, 0, 1, 400, 300, 0, 1, VX, 0, 0, 0);
    await podsRedis!.set(
      REDIS_WORLD_KEY,
      Buffer.from(world.buffer, world.byteOffset, world.byteLength),
    );

    const podA = await startPod();
    const podB = await startPod();

    const primeStart = Date.now();
    podA.tick();
    await waitRedisIdle();
    podB.tick();
    await waitRedisIdle();
    const xAfterPrime = await readObjectX();

    await sleep(25);

    // Both pods' 16 ms timers fire in the same window.
    podA.tick();
    await waitRedisIdle();
    podB.tick();
    await waitRedisIdle();
    const wallSec = (Date.now() - primeStart) / 1000;
    const simulatedSec = ((await readObjectX()) - xAfterPrime) / VX;

    // The world advanced at most the wall time since the first prime tick
    // (+1 ms float slack). Today each pod steps its own dt, so two pods ~= 2x.
    expect(simulatedSec).toBeLessThanOrEqual(wallSec + 0.001);
    expect(simulatedSec).toBeGreaterThan(0);
  });

  it("a step whose lock lapsed before the commit writes nothing", async () => {
    const world = createEmptyWorldBuffer();
    writeObjectSlot(world, 0, 1, 400, 300, 0, 1, 100, 0, 0, 0);
    const seeded = Buffer.from(
      world.buffer,
      world.byteOffset,
      world.byteLength,
    );
    await podsRedis!.set(REDIS_WORLD_KEY, seeded);

    const podA = await startPod();
    // Park A's commit (an eval) past the 32 ms lock TTL.
    let release!: () => void;
    hooks.evalGate = new Promise<void>((r) => {
      release = r;
    });
    podA.tick();
    await vi.waitFor(
      async () => {
        expect(await podsRedis!.get(REDIS_SIM_LOCK_KEY)).not.toBeNull();
      },
      { timeout: 1_000, interval: 1 },
    );
    await vi.waitFor(
      async () => {
        expect(await podsRedis!.get(REDIS_SIM_LOCK_KEY)).toBeNull();
      },
      { timeout: 1_000, interval: 2 },
    );
    expect(
      await podsRedis!.set(REDIS_SIM_LOCK_KEY, "holder-b", "PX", 10_000, "NX"),
    ).toBe("OK");

    hooks.evalGate = null;
    release();
    await waitRedisIdle();
    // The commit is conditional on A's token: no world write, no sim-at, B's lock intact.
    expect((await podsRedis!.getBuffer(REDIS_WORLD_KEY))!.equals(seeded)).toBe(
      true,
    );
    expect(await podsRedis!.get(REDIS_SIM_AT_KEY)).toBeNull();
    expect(await podsRedis!.get(REDIS_SIM_LOCK_KEY)).toBe("holder-b");
  });

  it("a pod relays a frame only when sim-at advanced", async () => {
    const world = createEmptyWorldBuffer();
    writeObjectSlot(world, 0, 1, 400, 300, 0, 1, 100, 0, 0, 0);
    await podsRedis!.set(
      REDIS_WORLD_KEY,
      Buffer.from(world.buffer, world.byteOffset, world.byteLength),
    );
    // A sim-at in the future: no pod ever steps (dt < one interval), so the test
    // controls exactly when sim-at advances.
    const future = Date.now() + 3_600_000;
    await podsRedis!.set(REDIS_SIM_AT_KEY, String(future));

    const pod = await startPod();
    await pod.join("relay-a");
    resetMeter();
    const frames = () =>
      meterState().sends.filter(
        (send) => send.sessionId === "relay-a" && send.kind === "binary",
      ).length;
    const tickTwice = async () => {
      for (let i = 0; i < 2; i += 1) {
        pod.tick();
        await waitRedisIdle();
      }
    };

    await tickTwice();
    expect(frames()).toBe(1);
    await tickTwice();
    await tickTwice();
    expect(frames()).toBe(1);

    await podsRedis!.set(REDIS_SIM_AT_KEY, String(future + 1));
    await tickTwice();
    expect(frames()).toBe(2);
  });
});
