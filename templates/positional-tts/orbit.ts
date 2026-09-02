import type { MixPose } from "@voicethere/agent";

/** Circle in the XZ plane around the listener origin (Y-up, look −Z). */
export function orbitTtsPose(elapsedSec: number, radius = 2): MixPose {
  const x = Math.cos(elapsedSec) * radius;
  const z = Math.sin(elapsedSec) * radius;
  return {
    position: { x, y: 0, z },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
  };
}
