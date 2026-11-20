import { describe, expect, it } from "vitest";

import { planRedisStepDtSec } from "../templates/game-sync/world-layout.js";

/** Redis-clock ticks of one pod: gaps alternate +15 / +17 ms (a 16 ms timer with jitter). */
function jitteredTicks(startMs: number, offsetMs: number, spanMs: number) {
  const ticks: number[] = [];
  let t = startMs + offsetMs;
  let gap = 15;
  while (t <= startMs + offsetMs + spanMs) {
    ticks.push(t);
    t += gap;
    gap = gap === 15 ? 17 : 15;
  }
  return ticks;
}

type Run = {
  steps: number;
  sumDt: number;
  firstStepNow: number;
  lastNow: number;
};

/** Shared stored sim-at, as the Redis `game-sync:sim-at` key. */
function runPods(
  podOffsets: number[],
  spanMs: number,
): Run & { broadcasts: number[] } {
  const events = podOffsets
    .flatMap((offset, pod) =>
      jitteredTicks(1_000_000, offset, spanMs).map((now) => ({ pod, now })),
    )
    .sort((a, b) => a.now - b.now || a.pod - b.pod);
  let simAt = 0;
  const run: Run = { steps: 0, sumDt: 0, firstStepNow: 0, lastNow: 0 };
  const tickCount = podOffsets.map(() => 0);
  const lastRelayed = podOffsets.map(() => 0);
  const broadcasts = podOffsets.map(() => 0);
  for (const { pod, now } of events) {
    tickCount[pod]! += 1;
    const dt = planRedisStepDtSec(simAt, now);
    if (dt !== null) {
      if (simAt === 0) {
        run.firstStepNow = now;
      } else {
        run.sumDt += dt;
      }
      run.steps += 1;
      simAt = now;
      run.lastNow = now;
    }
    if (tickCount[pod]! % 2 === 0 && simAt > lastRelayed[pod]!) {
      lastRelayed[pod] = simAt;
      broadcasts[pod]! += 1;
    }
  }
  return { ...run, broadcasts };
}

describe("planRedisStepDtSec", () => {
  it("skips below half an interval", () => {
    expect(planRedisStepDtSec(1000, 1004)).toBeNull();
    expect(planRedisStepDtSec(1000, 1007)).toBeNull();
    expect(planRedisStepDtSec(1000, 1016)).toBe(0.016);
  });

  it("steps one interval from no stored sim-at and caps a long gap at 50 ms", () => {
    expect(planRedisStepDtSec(0, 5_000)).toBe(1 / 60);
    expect(planRedisStepDtSec(1000, 3000)).toBe(0.05);
  });

  it("one pod with 15/17 ms jittered ticks steps every tick and sums to wall time", () => {
    const run = runPods([0], 1000);
    expect(run.steps).toBeGreaterThanOrEqual(58);
    expect(
      Math.abs(run.sumDt - (run.lastNow - run.firstStepNow) / 1000),
    ).toBeLessThanOrEqual(1e-9);
  });

  it("two pods 3 ms apart share sim-at and simulate wall time once", () => {
    const run = runPods([0, 3], 1000);
    expect(run.steps).toBeGreaterThanOrEqual(55);
    expect(run.steps).toBeLessThanOrEqual(65);
    expect(
      Math.abs(run.sumDt - (run.lastNow - run.firstStepNow) / 1000),
    ).toBeLessThanOrEqual(1e-9);
  });

  it("broadcast cadence stays about 30 Hz under jitter", () => {
    const run = runPods([0, 3], 1000);
    for (const count of run.broadcasts) {
      expect(count).toBeGreaterThanOrEqual(28);
    }
  });
});
