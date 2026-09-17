import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ShowcaseClipId } from "../templates/spatial-showcase/sounds.js";

const playMock = vi.fn();
const stopPlayMock = vi.fn();
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
  setPositionalMixing: vi.fn(),
  setTtsPose: vi.fn(),
  speak: vi.fn(),
  stopPlay: (...args: unknown[]) => stopPlayMock(...args),
}));

const { handlePadPlay, MAX_ACTIVE_PLAYS } =
  await import("../templates/spatial-showcase/agent.js");

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
      loop: boolean;
    }
  >;
  loopPollTimers: Map<string, ReturnType<typeof setInterval>>;
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

describe("handlePadPlay capacity", () => {
  beforeEach(() => {
    playMock.mockReset();
    stopPlayMock.mockReset();
    sendToClientMock.mockReset();
    playMock.mockResolvedValue({ ok: true, playId: "play-new" });
    stopPlayMock.mockResolvedValue({ ok: true });
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
