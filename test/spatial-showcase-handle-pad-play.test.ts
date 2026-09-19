import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MixPlacement } from "@voicethere/agent";

import type { ShowcaseClipId } from "../templates/spatial-showcase/sounds.js";

const playMock = vi.fn();
const stopPlayMock = vi.fn();
const setPlayPoseMock = vi.fn();
const sendToClientMock = vi.fn();

vi.mock("@voicethere/agent", () => ({
  addClientToMix: vi.fn(),
  agentLog: vi.fn(),
  clearTtsPose: vi.fn(),
  createMixGroup: vi.fn(),
  defineAgent: vi.fn(),
  getPlay: vi.fn(),
  isMixAvailable: vi.fn(),
  isTtsPoseAvailable: vi.fn(),
  play: (...args: unknown[]) => playMock(...args),
  removeClientFromMix: vi.fn(),
  sendToClient: (...args: unknown[]) => sendToClientMock(...args),
  setClientPose: vi.fn(),
  setListenerMute: vi.fn(),
  setPlayPose: (...args: unknown[]) => setPlayPoseMock(...args),
  setPositionalMixing: vi.fn(),
  setTtsPose: vi.fn(),
  speak: vi.fn(),
  stopPlay: (...args: unknown[]) => stopPlayMock(...args),
}));

const { handlePadMove, handlePadPlay, MAX_ACTIVE_PLAYS } =
  await import("../templates/spatial-showcase/agent.js");
const { poseAt } = await import("../templates/spatial-showcase/protocol.js");

type PadSessionState = {
  demo: "soundboard";
  assetOrigin: string;
  orbit: {
    radius: number;
    periodSec: number;
    elevation: number;
    paused: boolean;
  };
  playIds: Set<string>;
  loopPads: Map<
    string,
    {
      clipId: ShowcaseClipId;
      volume: number;
      x: number;
      z: number;
      placement?: MixPlacement;
      loop: boolean;
    }
  >;
  loopPollTimers: Map<string, ReturnType<typeof setInterval>>;
  orbitSineFrequencyHz: number;
  orbitSineEnabled: boolean;
  orbitSinePhaseRad: number;
  inProximityRoom: boolean;
};

function createPadSessionState(
  activePlayCount: number,
  loopClipId?: ShowcaseClipId,
): PadSessionState {
  const state: PadSessionState = {
    demo: "soundboard",
    assetOrigin: "https://app.voicethere.io",
    orbit: { radius: 2, periodSec: 6.28, elevation: 0, paused: false },
    playIds: new Set<string>(),
    loopPads: new Map(),
    loopPollTimers: new Map(),
    orbitSineFrequencyHz: 440,
    orbitSineEnabled: true,
    orbitSinePhaseRad: 0,
    inProximityRoom: false,
  };

  for (let i = 0; i < activePlayCount; i++) {
    const playId = `play-${i}`;
    state.playIds.add(playId);
    if (loopClipId !== undefined && i === activePlayCount - 1) {
      state.loopPads.set(playId, {
        clipId: loopClipId,
        volume: 0.5,
        x: 0,
        z: 0,
        loop: true,
      });
    }
  }

  return state;
}

function lastPadAck() {
  const padAcks = sendToClientMock.mock.calls
    .map((call) => call[1])
    .filter(
      (payload) => payload?.type === "showcase_ack" && payload.action === "pad",
    );
  return padAcks.at(-1);
}

function lastPadMoveAck() {
  const padMoveAcks = sendToClientMock.mock.calls
    .map((call) => call[1])
    .filter(
      (payload) =>
        payload?.type === "showcase_ack" && payload.action === "pad_move",
    );
  return padMoveAcks.at(-1);
}

describe("handlePadMove", () => {
  beforeEach(() => {
    setPlayPoseMock.mockReset();
    sendToClientMock.mockReset();
    setPlayPoseMock.mockResolvedValue({ ok: true, playId: "play-0" });
  });

  it("calls setPlayPose with poseAt coords and updates loop pad x/z", async () => {
    const state = createPadSessionState(1, "rain-loop");
    state.loopPads.get("play-0")!.placement = "center";
    state.loopPads.get("play-0")!.x = 0;
    state.loopPads.get("play-0")!.z = 0;

    await handlePadMove("session-1", state, "play-0", 2, -1);

    expect(setPlayPoseMock).toHaveBeenCalledWith("play-0", poseAt(2, -1));
    expect(state.loopPads.get("play-0")).toMatchObject({
      x: 2,
      z: -1,
    });
    expect(state.loopPads.get("play-0")?.placement).toBeUndefined();
    expect(lastPadMoveAck()).toMatchObject({
      ok: true,
      playId: "play-0",
      x: 2,
      z: -1,
    });
  });

  it("does not call setPlayPose for unknown playId", async () => {
    const state = createPadSessionState(0);

    await handlePadMove("session-1", state, "missing-play", 1, 1);

    expect(setPlayPoseMock).not.toHaveBeenCalled();
    expect(lastPadMoveAck()).toMatchObject({
      ok: false,
      error: "unknown_play",
    });
  });
});

describe("handlePadPlay capacity", () => {
  beforeEach(() => {
    playMock.mockReset();
    stopPlayMock.mockReset();
    setPlayPoseMock.mockReset();
    sendToClientMock.mockReset();
    playMock.mockResolvedValue({ ok: true, playId: "play-new" });
    stopPlayMock.mockResolvedValue({ ok: true });
    setPlayPoseMock.mockResolvedValue({ ok: true, playId: "play-0" });
  });

  it("rejects new one-shot plays when already at MAX_ACTIVE_PLAYS", async () => {
    const state = createPadSessionState(MAX_ACTIVE_PLAYS);

    await handlePadPlay("session-1", state, "chime", 0, 0);

    expect(playMock).not.toHaveBeenCalled();
    expect(lastPadAck()).toMatchObject({
      ok: false,
      error: "busy",
      clipId: "chime",
    });
  });

  it("stops same looping clip before capacity check so replace succeeds at cap", async () => {
    const state = createPadSessionState(MAX_ACTIVE_PLAYS, "rain-loop");
    const replacedPlayId = `play-${MAX_ACTIVE_PLAYS - 1}`;

    await handlePadPlay("session-1", state, "rain-loop", 2, -1);

    expect(stopPlayMock).toHaveBeenCalledWith(replacedPlayId);
    expect(playMock).toHaveBeenCalled();
    expect(lastPadAck()).toMatchObject({
      ok: true,
      playId: "play-new",
      clipId: "rain-loop",
      x: 2,
      z: -1,
    });
    expect(state.playIds.has("play-new")).toBe(true);
    expect(state.playIds.has(replacedPlayId)).toBe(false);
  });
});
