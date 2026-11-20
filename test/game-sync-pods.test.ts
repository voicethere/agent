/**
 * game-sync correctness with several pods on one project Redis
 * (plan 2026-11-20-sync-template-efficiency, chunk 1 failing tests; chunk 3 fixes).
 *
 * Skipped by default: both fail on main. Run with SYNC_EFFICIENCY_BUG_TESTS=1
 * (and a reachable Redis, see helpers/test-redis.ts) to see the failures.
 *
 * Each pod is a fresh import of templates/game-sync/agent.ts (own module state);
 * `defineAgent` is mocked so the handlers are called directly. The template's
 * setInterval is captured, never fired by a clock: the test runs each pod's tick
 * on demand and waits until that pod has no Redis command in flight.
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
  REDIS_SIM_LOCK_KEY,
  REDIS_WORLD_KEY,
  writeObjectSlot,
  createEmptyWorldBuffer,
} from "../templates/game-sync/world-layout.js";
import { agentMockFactory, loadPod } from "./helpers/sync-pods.js";
import { openTestRedis, type TestRedis } from "./helpers/test-redis.js";

vi.mock("@voicethere/agent", (importOriginal) =>
  agentMockFactory(importOriginal as () => Promise<Record<string, unknown>>),
);

type RedisHooks = { evalDelayMs: number; pending: number };
const hooks = vi.hoisted(() => ({ evalDelayMs: 0, pending: 0 }) as RedisHooks);

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
      if (hooks.evalDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, hooks.evalDelayMs));
      }
      return (super.eval as (...a: unknown[]) => Promise<unknown>)(...args);
    }
  }
  return { ...actual, Redis: TrackedRedis, default: TrackedRedis };
});

const RUN_BUG_TESTS = process.env.SYNC_EFFICIENCY_BUG_TESTS === "1";
const harness: TestRedis | null = RUN_BUG_TESTS ? await openTestRedis() : null;

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

type Pod = { tick: () => void };

const intervalCallbacks: Array<() => void> = [];

async function startPod(): Promise<Pod> {
  const before = intervalCallbacks.length;
  const pod = await loadPod(
    () => import("../templates/game-sync/agent.js"),
    () => vi.resetModules(),
  );
  await pod.onAgentStart?.({ env: { AGENT_REDIS_URL: harness!.url } } as never);
  if (intervalCallbacks.length !== before + 1) {
    throw new Error("game-sync pod did not start exactly one sim interval");
  }
  const tick = intervalCallbacks[intervalCallbacks.length - 1]!;
  return { tick };
}

async function readObjectX(): Promise<number> {
  const world = normalizeWorldBuffer(
    await harness!.redis.getBuffer(REDIS_WORLD_KEY),
  );
  return world[1]!;
}

describe.skipIf(!harness)(
  "game-sync pods on one Redis (skipped until chunk 3: fails on main)",
  () => {
    beforeEach(async () => {
      hooks.evalDelayMs = 0;
      vi.spyOn(globalThis, "setInterval").mockImplementation(((
        callback: () => void,
      ) => {
        intervalCallbacks.push(callback);
        return { unref() {}, ref() {} } as unknown as NodeJS.Timeout;
      }) as typeof setInterval);
      await harness!.redis.del(REDIS_WORLD_KEY, REDIS_SIM_LOCK_KEY);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      hooks.evalDelayMs = 0;
      await waitRedisIdle();
      await harness!.redis.del(REDIS_WORLD_KEY, REDIS_SIM_LOCK_KEY);
    });

    afterAll(async () => {
      await harness?.close();
    });

    it("TestSimLockReleaseKeepsOtherHolder", async () => {
      const podA = await loadPod(
        () => import("../templates/game-sync/agent.js"),
        () => vi.resetModules(),
      );
      await podA.onAgentStart?.({
        env: { AGENT_REDIS_URL: harness!.url },
      } as never);
      await podA.onClientJoin?.({ sessionId: "lock-a" } as never);

      // A's register holds the sim lock across a slow allocate (300 ms > 32 ms TTL).
      hooks.evalDelayMs = 300;
      const registered = podA.onDataChannelMessage?.({
        sessionId: "lock-a",
        message: { type: "register" },
      } as never);

      await vi.waitFor(
        async () => {
          expect(await harness!.redis.get(REDIS_SIM_LOCK_KEY)).not.toBeNull();
        },
        { timeout: 1_000, interval: 1 },
      );
      // A's lock expires while A is still inside its critical section.
      await vi.waitFor(
        async () => {
          expect(await harness!.redis.get(REDIS_SIM_LOCK_KEY)).toBeNull();
        },
        { timeout: 1_000, interval: 2 },
      );
      // Pod B takes the lock.
      expect(
        await harness!.redis.set(
          REDIS_SIM_LOCK_KEY,
          "holder-b",
          "PX",
          10_000,
          "NX",
        ),
      ).toBe("OK");

      await registered;
      // A's release must not delete B's lock.
      expect(await harness!.redis.get(REDIS_SIM_LOCK_KEY)).toBe("holder-b");
      await podA.onClientLeave?.({ sessionId: "lock-a" } as never);
    });

    it("two pods ticking in one 16 ms window simulate wall time once", async () => {
      // One object moving +x at 100 px/s, far from walls.
      const VX = 100;
      const world = createEmptyWorldBuffer();
      writeObjectSlot(world, 0, 1, 400, 300, 0, 1, VX, 0, 0, 0);
      await harness!.redis.set(
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
  },
);
