import type { MixPose } from "@voicethere/agent";

export type OrbitOptions = {
  radius?: number;
  periodSec?: number;
  elevation?: number;
};

/** Circle in the XZ plane around the listener origin (Y-up, look −Z). */
export function orbitTtsPose(
  elapsedSec: number,
  options: OrbitOptions = {},
): MixPose {
  const radius = options.radius ?? 2;
  const periodSec = options.periodSec ?? 2 * Math.PI;
  const elevation = options.elevation ?? 0;
  const angle = (2 * Math.PI * elapsedSec) / periodSec;
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  return {
    position: { x, y: elevation, z },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
  };
}
