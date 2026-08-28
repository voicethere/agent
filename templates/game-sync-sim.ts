/**
 * Server-authoritative game-sync physics step (pure Float32Array, no Redis).
 */
import { objectIdToSlot } from "./game-sync-world-layout.js";

export const BOARD_WIDTH = 1280;
export const BOARD_HEIGHT = 720;
export const OBJECT_RADIUS = 25;
export const COLLISION_RESTITUTION = 1.0;
export const OBJECT_STRIDE = 9;

export function simulateWorldStep(
  worldState: Float32Array,
  dtSec: number,
  activeObjectIds: number[],
): void {
  for (const objectId of activeObjectIds) {
    const slot = objectIdToSlot(objectId);
    const start = slot * OBJECT_STRIDE;
    if (start < 0 || start + OBJECT_STRIDE > worldState.length) continue;

    let x = worldState[start + 1] ?? 0;
    let y = worldState[start + 2] ?? 0;
    let vx = worldState[start + 5] ?? 0;
    let vy = worldState[start + 6] ?? 0;

    x += vx * dtSec;
    y += vy * dtSec;

    if (x < OBJECT_RADIUS || x > BOARD_WIDTH - OBJECT_RADIUS) {
      vx *= -1;
      x = Math.max(OBJECT_RADIUS, Math.min(BOARD_WIDTH - OBJECT_RADIUS, x));
    }
    if (y < OBJECT_RADIUS || y > BOARD_HEIGHT - OBJECT_RADIUS) {
      vy *= -1;
      y = Math.max(OBJECT_RADIUS, Math.min(BOARD_HEIGHT - OBJECT_RADIUS, y));
    }

    worldState[start + 1] = x;
    worldState[start + 2] = y;
    worldState[start + 5] = vx;
    worldState[start + 6] = vy;
  }

  for (let i = 0; i < activeObjectIds.length; i += 1) {
    const aId = activeObjectIds[i];
    const aSlot = objectIdToSlot(aId);
    const aStart = aSlot * OBJECT_STRIDE;
    if (aStart < 0 || aStart + OBJECT_STRIDE > worldState.length) continue;
    for (let j = i + 1; j < activeObjectIds.length; j += 1) {
      const bId = activeObjectIds[j];
      const bSlot = objectIdToSlot(bId);
      const bStart = bSlot * OBJECT_STRIDE;
      if (bStart < 0 || bStart + OBJECT_STRIDE > worldState.length) continue;

      let ax = worldState[aStart + 1] ?? 0;
      let ay = worldState[aStart + 2] ?? 0;
      let avx = worldState[aStart + 5] ?? 0;
      let avy = worldState[aStart + 6] ?? 0;
      let bx = worldState[bStart + 1] ?? 0;
      let by = worldState[bStart + 2] ?? 0;
      let bvx = worldState[bStart + 5] ?? 0;
      let bvy = worldState[bStart + 6] ?? 0;

      let dx = bx - ax;
      let dy = by - ay;
      let distSq = dx * dx + dy * dy;
      const minDist = OBJECT_RADIUS * 2;
      const minDistSq = minDist * minDist;
      if (!(distSq > 0 && distSq < minDistSq)) continue;

      let dist = Math.sqrt(distSq);
      if (dist === 0) {
        dx = 1;
        dy = 0;
        dist = 1;
        distSq = 1;
      }
      const nx = dx / dist;
      const ny = dy / dist;

      const overlap = minDist - dist;
      const half = overlap * 0.5;
      ax -= nx * half;
      ay -= ny * half;
      bx += nx * half;
      by += ny * half;

      const rvx = bvx - avx;
      const rvy = bvy - avy;
      const velAlongNormal = rvx * nx + rvy * ny;
      if (velAlongNormal < 0) {
        const impulse = (-(1 + COLLISION_RESTITUTION) * velAlongNormal) / 2;
        avx -= impulse * nx;
        avy -= impulse * ny;
        bvx += impulse * nx;
        bvy += impulse * ny;
      }

      worldState[aStart + 1] = Math.max(
        OBJECT_RADIUS,
        Math.min(BOARD_WIDTH - OBJECT_RADIUS, ax),
      );
      worldState[aStart + 2] = Math.max(
        OBJECT_RADIUS,
        Math.min(BOARD_HEIGHT - OBJECT_RADIUS, ay),
      );
      worldState[aStart + 5] = avx;
      worldState[aStart + 6] = avy;
      worldState[bStart + 1] = Math.max(
        OBJECT_RADIUS,
        Math.min(BOARD_WIDTH - OBJECT_RADIUS, bx),
      );
      worldState[bStart + 2] = Math.max(
        OBJECT_RADIUS,
        Math.min(BOARD_HEIGHT - OBJECT_RADIUS, by),
      );
      worldState[bStart + 5] = bvx;
      worldState[bStart + 6] = bvy;
    }
  }
}
