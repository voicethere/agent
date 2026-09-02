import { describe, expect, it } from "vitest";

import { orbitTtsPose } from "../templates/positional-tts/orbit.js";

describe("orbitTtsPose", () => {
  it("starts on +X at t=0", () => {
    const pose = orbitTtsPose(0, 2);
    expect(pose.position.x).toBeCloseTo(2);
    expect(pose.position.z).toBeCloseTo(0);
  });

  it("moves to +Z at quarter orbit", () => {
    const pose = orbitTtsPose(Math.PI / 2, 2);
    expect(pose.position.x).toBeCloseTo(0);
    expect(pose.position.z).toBeCloseTo(2);
  });
});
