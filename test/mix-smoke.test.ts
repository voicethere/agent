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

  it("accepts set_global_mute with clientId and muted", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "set_global_mute",
        clientId: "peer-1",
        muted: true,
      }),
    ).toBe(true);
  });

  it("accepts set_global_mute with optional sttEnabled", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "set_global_mute",
        clientId: "peer-1",
        muted: false,
        sttEnabled: true,
      }),
    ).toBe(true);
  });

  it("accepts set_listener_mute with listenerId, targetId, muted", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "set_listener_mute",
        listenerId: "listener-1",
        targetId: "target-1",
        muted: true,
      }),
    ).toBe(true);
  });

  it("accepts get_status without clientId", () => {
    expect(isMixCommand({ type: "mix", action: "get_status" })).toBe(true);
  });

  it("accepts get_status with clientId", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "get_status",
        clientId: "peer-1",
      }),
    ).toBe(true);
  });

  it("accepts set_tts_pose with clientId and pose", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "set_tts_pose",
        clientId: "peer-1",
        pose: identityPose,
      }),
    ).toBe(true);
  });

  it("accepts speak with clientId and text", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "speak",
        clientId: "peer-1",
        text: "one two three",
      }),
    ).toBe(true);
  });

  it("accepts clear_tts_pose with clientId", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "clear_tts_pose",
        clientId: "peer-1",
      }),
    ).toBe(true);
  });

  it("accepts play with bytes", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "play",
        bytes: Buffer.from("wav").toString("base64"),
      }),
    ).toBe(true);
  });

  it("accepts play with url and optional sessionIds", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "play",
        url: "https://cdn.example.com/chime.mp3",
        sessionIds: ["peer-1"],
        volume: 0.8,
      }),
    ).toBe(true);
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

  it("rejects set_global_mute with empty clientId", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "set_global_mute",
        clientId: "",
        muted: true,
      }),
    ).toBe(false);
  });

  it("rejects set_global_mute without boolean muted", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "set_global_mute",
        clientId: "peer-1",
        muted: "true",
      }),
    ).toBe(false);
  });

  it("rejects set_global_mute with non-boolean sttEnabled", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "set_global_mute",
        clientId: "peer-1",
        muted: true,
        sttEnabled: "yes",
      }),
    ).toBe(false);
  });

  it("rejects set_listener_mute with empty listenerId", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "set_listener_mute",
        listenerId: "",
        targetId: "target-1",
        muted: true,
      }),
    ).toBe(false);
  });

  it("rejects set_listener_mute with empty targetId", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "set_listener_mute",
        listenerId: "listener-1",
        targetId: "",
        muted: true,
      }),
    ).toBe(false);
  });

  it("rejects get_status with empty clientId", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "get_status",
        clientId: "",
      }),
    ).toBe(false);
  });

  it("rejects set_tts_pose with empty clientId", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "set_tts_pose",
        clientId: "",
        pose: identityPose,
      }),
    ).toBe(false);
  });

  it("rejects set_tts_pose with invalid pose", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "set_tts_pose",
        clientId: "peer-1",
        pose: { position: { x: 0 } },
      }),
    ).toBe(false);
  });

  it("rejects speak with empty clientId", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "speak",
        clientId: "",
        text: "hello",
      }),
    ).toBe(false);
  });

  it("rejects speak with empty text", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "speak",
        clientId: "peer-1",
        text: "",
      }),
    ).toBe(false);
  });

  it("rejects clear_tts_pose with empty clientId", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "clear_tts_pose",
        clientId: "",
      }),
    ).toBe(false);
  });

  it("rejects play with empty payload", () => {
    expect(isMixCommand({ type: "mix", action: "play" })).toBe(false);
    expect(
      isMixCommand({
        type: "mix",
        action: "play",
        bytes: "",
        url: "",
      }),
    ).toBe(false);
  });

  it("rejects play with invalid sessionIds", () => {
    expect(
      isMixCommand({
        type: "mix",
        action: "play",
        bytes: Buffer.from("wav").toString("base64"),
        sessionIds: [""],
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
