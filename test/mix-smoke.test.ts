import { describe, expect, it } from "vitest";

import {
  isMixCommand,
  isMixPose,
  type MixPose,
} from "../templates/mix-smoke.js";

const identityPose: MixPose = {
  position: { x: 0, y: 0, z: 0 },
  orientation: { x: 0, y: 0, z: 0, w: 1 },
};

describe("mix-smoke command parser", () => {
  it("accepts whoami", () => {
    expect(isMixCommand({ type: "mix", action: "whoami" })).toBe(true);
  });

  it("accepts create_group with groupId and clientIds", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "create_group",
        groupId: "team",
        clientIds: ["a", "b"],
      }),
    ).toBe(true);
  });

  it("accepts set_pose with clientId and pose", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "set_pose",
        clientId: "peer-1",
        pose: identityPose,
      }),
    ).toBe(true);
  });

  it("accepts set_positional", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "set_positional",
        enabled: true,
      }),
    ).toBe(true);
  });

  it("accepts list_clients", () => {
    expect(isMixCommand({ type: "mix", action: "list_clients" })).toBe(true);
  });

  it("rejects non-mix type", () => {
    expect(isMixCommand({ type: "tick" })).toBe(false);
    expect(isMixCommand({ type: "mix", action: "tick" })).toBe(false);
  });

  it("rejects create_group with empty groupId", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "create_group",
        groupId: "",
        clientIds: ["a"],
      }),
    ).toBe(false);
  });

  it("rejects create_group with non-string clientIds", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "create_group",
        groupId: "g",
        clientIds: [1],
      }),
    ).toBe(false);
  });

  it("rejects set_pose with invalid pose", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "set_pose",
        clientId: "peer-1",
        pose: { position: { x: 0 } },
      }),
    ).toBe(false);
  });

  it("rejects set_positional without boolean enabled", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "set_positional",
        enabled: "true",
      }),
    ).toBe(false);
  });
});

describe("isMixPose", () => {
  it("validates full pose", () => {
    expect(isMixPose(identityPose)).toBe(true);
  });

  it("rejects partial pose", () => {
    expect(isMixPose({ position: { x: 0, y: 0, z: 0 } })).toBe(false);
  });
});
