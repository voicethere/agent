/**
 * Spatial audio showcase — orbiting sine + TTS, positional soundboard, proximity room.
 *
 * Browser joins with `{ type: "join", demo, assetOrigin? }` then sends demo-specific
 * commands. Clip URLs are resolved server-side from clipId + allowlisted assetOrigin.
 *
 * Build:
 *   npx @voicethere/agent build --entry templates/spatial-showcase/agent.ts
 */
import {
  addClientToMix,
  agentLog,
  clearTtsPose,
  createMixGroup,
  defineAgent,
  getPlay,
  isMixAvailable,
  isTtsPoseAvailable,
  play,
  removeClientFromMix,
  sendToClient,
  setClientPose,
  setListenerMute,
  setPlayPose,
  setPositionalMixing,
  setSttEnabled,
  setTtsPose,
  speak,
  stopPlay,
  type PlayOptions,
} from "@voicethere/agent";

import { orbitTtsPose, type OrbitOptions } from "./orbit.js";
import {
  beginOrbitClock,
  resetOrbitSession,
  stopOrbitInterval,
} from "./orbit-session.js";
import {
  parseShowcaseMessage,
  poseAt,
  type ShowcaseInbound,
  type ShowcaseDemo,
} from "./protocol.js";
import { ProximityRoom } from "./room.js";
import {
  isShowcaseClipId,
  resolveClipUrl,
  SHOWCASE_SOUND_FILES,
  type ShowcaseClipId,
} from "./sounds.js";
import {
  buildOrbitSineInlineClipBase64,
  ORBIT_SINE_DURATION_MS,
  ORBIT_SINE_INLINE_URL,
  orbitSineClipDurationMs,
} from "./sine.js";

const ORBIT_TICK_MS = 50;
const ORBIT_POSE_EMIT_MS = 100;
const ROOM_STATE_TICK_MS = 100;
const LOOP_PAD_POLL_MS = 250;
const ORBIT_SINE_POLL_MS = 250;
const ORBIT_SINE_GAPLESS_LEAD_MS = 200;
const ORBIT_SINE_VOLUME = 0.25;
export const MAX_ACTIVE_PLAYS = 12;
const SHOWCASE_ROOM_GROUP_ID = "showcase-room";

type LoopPadState = {
  clipId: ShowcaseClipId;
  volume: number;
  x: number;
  z: number;
  placement?: PlayOptions["placement"];
  loop: boolean;
};

type SessionState = {
  demo: ShowcaseDemo;
  assetOrigin?: string;
  orbit: OrbitOptions & { paused: boolean };
  orbitStartMs?: number;
  orbitTimer?: ReturnType<typeof setInterval>;
  roomStateTimer?: ReturnType<typeof setInterval>;
  playIds: Set<string>;
  loopPads: Map<string, LoopPadState>;
  loopPollTimers: Map<string, ReturnType<typeof setInterval>>;
  orbitSinePlayId?: string;
  orbitSinePollTimer?: ReturnType<typeof setInterval>;
  orbitSineRestartTimer?: ReturnType<typeof setTimeout>;
  orbitSineFrequencyHz: number;
  orbitSineEnabled: boolean;
  orbitSinePhaseRad: number;
  orbitManualPose?: { x: number; z: number };
  inProximityRoom: boolean;
  lastOrbitPoseEmitMs?: number;
};

const sessions = new Map<string, SessionState>();
const proximityRoom = new ProximityRoom();

let showcaseRoomGroupReady: Promise<boolean> | null = null;
const lastRoomSnapshotByListener = new Map<string, string>();

function ensureShowcaseRoomGroup(): Promise<boolean> {
  if (!showcaseRoomGroupReady) {
    showcaseRoomGroupReady = createMixGroup({
      id: SHOWCASE_ROOM_GROUP_ID,
      clientIds: [],
    })
      .then((result) => result.ok)
      .catch(() => false);
  }
  return showcaseRoomGroupReady;
}

type PadAckExtra = {
  playId?: string;
  clipId?: ShowcaseClipId;
  x?: number;
  z?: number;
  placement?: PlayOptions["placement"];
};

function ack(sessionId: string, action: string, extra?: PadAckExtra): void {
  sendToClient(sessionId, {
    type: "showcase_ack",
    action,
    ok: true,
    ...extra,
  });
}

function ackError(
  sessionId: string,
  action: string,
  error: string,
  extra?: { clipId?: ShowcaseClipId },
): void {
  sendToClient(sessionId, {
    type: "showcase_ack",
    action,
    ok: false,
    error,
    ...(extra?.clipId !== undefined ? { clipId: extra.clipId } : {}),
  });
}

async function safeMixCall(
  sessionId: string,
  label: string,
  fn: () => Promise<{ ok: boolean; reason?: string }>,
): Promise<boolean> {
  try {
    const result = await fn();
    if (!result.ok) {
      agentLog(
        "warn",
        `spatial-showcase ${label} failed: ${result.reason}`,
        sessionId,
      );
      return false;
    }
    return true;
  } catch (err) {
    agentLog(
      "warn",
      `spatial-showcase ${label} error: ${String(err)}`,
      sessionId,
    );
    return false;
  }
}

function defaultSessionState(
  demo: ShowcaseDemo,
  assetOrigin?: string,
): SessionState {
  return {
    demo,
    assetOrigin,
    orbit: { radius: 2, periodSec: 2 * Math.PI, elevation: 0, paused: false },
    playIds: new Set(),
    loopPads: new Map(),
    loopPollTimers: new Map(),
    orbitSineFrequencyHz: 440,
    orbitSineEnabled: true,
    orbitSinePhaseRad: 0,
    inProximityRoom: false,
  };
}

function clearRoomStateTimer(state: SessionState): void {
  if (state.roomStateTimer) {
    clearInterval(state.roomStateTimer);
    state.roomStateTimer = undefined;
  }
}

function stopLoopPadsForClip(
  sessionId: string,
  state: SessionState,
  clipId: ShowcaseClipId,
): void {
  for (const [playId, pad] of [...state.loopPads.entries()]) {
    if (pad.clipId === clipId) {
      void stopPlay(playId);
      clearLoopPad(sessionId, state, playId);
    }
  }
}

function clearLoopPad(
  sessionId: string,
  state: SessionState,
  playId: string,
): void {
  const timer = state.loopPollTimers.get(playId);
  if (timer) {
    clearInterval(timer);
    state.loopPollTimers.delete(playId);
  }
  state.loopPads.delete(playId);
  state.playIds.delete(playId);
}

function clearAllPlays(sessionId: string, state: SessionState): void {
  for (const playId of [...state.playIds]) {
    state.loopPads.delete(playId);
    const timer = state.loopPollTimers.get(playId);
    if (timer) {
      clearInterval(timer);
      state.loopPollTimers.delete(playId);
    }
    void stopPlay(playId);
  }
  state.playIds.clear();
  state.loopPads.clear();
  state.loopPollTimers.clear();
}

function currentOrbitPose(state: SessionState) {
  if (state.orbitManualPose) {
    const elevation = state.orbit.elevation ?? 0;
    return {
      position: {
        x: state.orbitManualPose.x,
        y: elevation,
        z: state.orbitManualPose.z,
      },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    };
  }
  if (!state.orbitStartMs) {
    return orbitTtsPose(0, state.orbit);
  }
  const elapsedSec = (Date.now() - state.orbitStartMs) / 1000;
  return orbitTtsPose(elapsedSec, state.orbit);
}

function orbitPoseFromXz(
  state: SessionState,
  x: number,
  z: number,
): ReturnType<typeof orbitTtsPose> {
  const elevation = state.orbit.elevation ?? 0;
  return {
    position: { x, y: elevation, z },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
  };
}

function syncOrbitClockFromManualPose(state: SessionState): void {
  const manual = state.orbitManualPose;
  if (!manual) {
    return;
  }
  const periodSec = state.orbit.periodSec ?? 2 * Math.PI;
  const angleRad = Math.atan2(manual.z, manual.x);
  const elapsedSec = (angleRad * periodSec) / (2 * Math.PI);
  state.orbitStartMs = Date.now() - elapsedSec * 1000;
  state.orbitManualPose = undefined;
}

function clearOrbitSinePoll(state: SessionState): void {
  if (state.orbitSinePollTimer) {
    clearInterval(state.orbitSinePollTimer);
    state.orbitSinePollTimer = undefined;
  }
}

function clearOrbitSineRestartTimer(state: SessionState): void {
  if (state.orbitSineRestartTimer) {
    clearTimeout(state.orbitSineRestartTimer);
    state.orbitSineRestartTimer = undefined;
  }
}

async function stopOrbitSine(state: SessionState): Promise<void> {
  clearOrbitSinePoll(state);
  clearOrbitSineRestartTimer(state);
  const playId = state.orbitSinePlayId;
  state.orbitSinePlayId = undefined;
  if (playId) {
    await stopPlay(playId);
  }
}

function orbitSineClipBytes(state: SessionState): string {
  return buildOrbitSineInlineClipBase64(
    ORBIT_SINE_DURATION_MS,
    state.orbitSineFrequencyHz,
    undefined,
    state.orbitSinePhaseRad,
  );
}

function orbitSineClipDuration(state: SessionState): number {
  return orbitSineClipDurationMs(
    ORBIT_SINE_DURATION_MS,
    state.orbitSineFrequencyHz,
  );
}

function scheduleOrbitSineGaplessRestart(
  sessionId: string,
  state: SessionState,
): void {
  clearOrbitSineRestartTimer(state);
  const durationMs = orbitSineClipDuration(state);
  const delayMs = Math.max(0, durationMs - ORBIT_SINE_GAPLESS_LEAD_MS);
  state.orbitSineRestartTimer = setTimeout(() => {
    state.orbitSineRestartTimer = undefined;
    void restartOrbitSineGapless(sessionId, state);
  }, delayMs);
}

async function restartOrbitSineGapless(
  sessionId: string,
  state: SessionState,
): Promise<void> {
  if (!state.orbitSineEnabled || !state.orbitSinePlayId) {
    return;
  }
  const previousPlayId = state.orbitSinePlayId;
  const result = await play({
    url: ORBIT_SINE_INLINE_URL,
    bytes: orbitSineClipBytes(state),
    sessionIds: [sessionId],
    volume: ORBIT_SINE_VOLUME,
    pose: currentOrbitPose(state),
  });
  if (!result.ok || !result.playId) {
    agentLog(
      "warn",
      `spatial-showcase orbit sine gapless restart failed: ${result.reason ?? "play_failed"}`,
      sessionId,
    );
    startOrbitSineLoopPoll(sessionId, state);
    return;
  }
  state.orbitSinePlayId = result.playId;
  void stopPlay(previousPlayId);
  scheduleOrbitSineGaplessRestart(sessionId, state);
}

function startOrbitSineLoopPoll(sessionId: string, state: SessionState): void {
  if (state.orbitSineRestartTimer) {
    return;
  }
  clearOrbitSinePoll(state);
  const playId = state.orbitSinePlayId;
  if (!playId) {
    return;
  }

  state.orbitSinePollTimer = setInterval(() => {
    void (async () => {
      if (!state.orbitSinePlayId || state.orbitSineRestartTimer) {
        clearOrbitSinePoll(state);
        return;
      }
      const status = await getPlay(state.orbitSinePlayId);
      if (!status.ok) {
        return;
      }
      if (status.status === "ended") {
        await restartOrbitSineGapless(sessionId, state);
      }
    })();
  }, ORBIT_SINE_POLL_MS);
}

async function startOrbitSinePlay(
  sessionId: string,
  state: SessionState,
): Promise<void> {
  if (!state.orbitSineEnabled) {
    return;
  }
  await stopOrbitSine(state);
  const result = await play({
    url: ORBIT_SINE_INLINE_URL,
    bytes: orbitSineClipBytes(state),
    sessionIds: [sessionId],
    volume: ORBIT_SINE_VOLUME,
    pose: currentOrbitPose(state),
  });
  if (!result.ok || !result.playId) {
    agentLog(
      "warn",
      `spatial-showcase orbit sine play failed: ${result.reason ?? "play_failed"}`,
      sessionId,
    );
    return;
  }
  state.orbitSinePlayId = result.playId;
  scheduleOrbitSineGaplessRestart(sessionId, state);
  startOrbitSineLoopPoll(sessionId, state);
}

function emitOrbitPose(sessionId: string, state: SessionState): void {
  if (!state.orbitStartMs && !state.orbitManualPose) {
    return;
  }
  const now = Date.now();
  if (
    state.lastOrbitPoseEmitMs !== undefined &&
    now - state.lastOrbitPoseEmitMs < ORBIT_POSE_EMIT_MS
  ) {
    return;
  }
  state.lastOrbitPoseEmitMs = now;
  const pose = currentOrbitPose(state);
  const angleRad = state.orbitManualPose
    ? Math.atan2(state.orbitManualPose.z, state.orbitManualPose.x)
    : (2 * Math.PI * (now - state.orbitStartMs!)) /
      1000 /
      (state.orbit.periodSec ?? 2 * Math.PI);
  sendToClient(sessionId, {
    type: "orbit_pose",
    angleDeg: (angleRad * 180) / Math.PI,
    x: pose.position.x,
    z: pose.position.z,
  });
}

function emitOrbitPlacePose(
  sessionId: string,
  state: SessionState,
  x: number,
  z: number,
): void {
  state.lastOrbitPoseEmitMs = Date.now();
  const angleRad = Math.atan2(z, x);
  sendToClient(sessionId, {
    type: "orbit_pose",
    angleDeg: (angleRad * 180) / Math.PI,
    x,
    z,
  });
}

function startOrbitDemo(sessionId: string, state: SessionState): void {
  stopOrbitInterval(state);
  beginOrbitClock(state);
  void startOrbitSinePlay(sessionId, state);
  state.orbitTimer = setInterval(() => {
    if (state.orbit.paused || (!state.orbitStartMs && !state.orbitManualPose)) {
      return;
    }
    const pose = currentOrbitPose(state);
    if (state.orbitSinePlayId) {
      void safeMixCall(sessionId, "setPlayPose", () =>
        setPlayPose(state.orbitSinePlayId!, pose),
      );
    }
    void safeMixCall(sessionId, "setTtsPose", () =>
      setTtsPose(sessionId, pose),
    );
    emitOrbitPose(sessionId, state);
  }, ORBIT_TICK_MS);
  emitOrbitPose(sessionId, state);
  speak(sessionId, "I'll circle around you.");
}

function broadcastRoomStateIfChanged(): void {
  const memberIds = proximityRoom.memberIds();
  if (memberIds.length === 0) {
    lastRoomSnapshotByListener.clear();
    return;
  }

  for (const listenerId of memberIds) {
    const peers = proximityRoom.snapshotFor(listenerId);
    const payload = JSON.stringify(peers);
    if (lastRoomSnapshotByListener.get(listenerId) === payload) {
      continue;
    }
    lastRoomSnapshotByListener.set(listenerId, payload);
    sendToClient(listenerId, { type: "room_state", peers });
  }

  for (const listenerId of [...lastRoomSnapshotByListener.keys()]) {
    if (!memberIds.includes(listenerId)) {
      lastRoomSnapshotByListener.delete(listenerId);
    }
  }
}

function startProximityRoomBroadcast(
  sessionId: string,
  state: SessionState,
): void {
  clearRoomStateTimer(state);
  state.roomStateTimer = setInterval(() => {
    broadcastRoomStateIfChanged();
  }, ROOM_STATE_TICK_MS);
  lastRoomSnapshotByListener.clear();
  broadcastRoomStateIfChanged();
}

async function startLoopPadPoll(
  sessionId: string,
  state: SessionState,
  playId: string,
  pad: LoopPadState,
): Promise<void> {
  const assetOrigin = state.assetOrigin;
  if (!assetOrigin) {
    return;
  }

  const timer = setInterval(() => {
    void (async () => {
      const loopState = state.loopPads.get(playId);
      if (!loopState) {
        clearInterval(timer);
        return;
      }
      const status = await getPlay(playId);
      if (!status.ok) {
        return;
      }
      if (status.status === "ended") {
        const url = resolveClipUrl(assetOrigin, pad.clipId);
        if (!url) {
          ackError(sessionId, "pad", "invalid_asset_origin");
          return;
        }
        const options: PlayOptions = {
          url,
          sessionIds: [sessionId],
          volume: pad.volume,
          ...(pad.placement
            ? { placement: pad.placement }
            : { pose: poseAt(pad.x, pad.z) }),
        };
        const replay = await play(options);
        if (replay.ok && replay.playId) {
          clearLoopPad(sessionId, state, playId);
          state.playIds.add(replay.playId);
          state.loopPads.set(replay.playId, pad);
          ack(sessionId, "pad", {
            playId: replay.playId,
            clipId: pad.clipId,
            x: pad.x,
            z: pad.z,
            ...(pad.placement !== undefined
              ? { placement: pad.placement }
              : {}),
          });
          void startLoopPadPoll(sessionId, state, replay.playId, pad);
        }
      } else if (status.status) {
        sendToClient(sessionId, {
          type: "pad_progress",
          playId,
          status: status.status,
        });
      }
    })();
  }, LOOP_PAD_POLL_MS);

  state.loopPollTimers.set(playId, timer);
}

export async function handlePadPlay(
  sessionId: string,
  state: SessionState,
  clipId: ShowcaseClipId,
  x: number,
  z: number,
  volume?: number,
  placement?: PlayOptions["placement"],
): Promise<void> {
  const assetOrigin = state.assetOrigin;
  if (!assetOrigin) {
    ackError(sessionId, "pad", "missing_asset_origin", { clipId });
    return;
  }

  const url = resolveClipUrl(assetOrigin, clipId);
  if (!url) {
    ackError(sessionId, "pad", "invalid_asset_origin", { clipId });
    return;
  }

  const sound = SHOWCASE_SOUND_FILES[clipId];
  if (sound.loop) {
    stopLoopPadsForClip(sessionId, state, clipId);
  }

  if (state.playIds.size >= MAX_ACTIVE_PLAYS) {
    ackError(sessionId, "pad", "busy", { clipId });
    return;
  }
  const playVolume = volume ?? sound.defaultVolume;
  const options: PlayOptions = {
    url,
    sessionIds: [sessionId],
    volume: playVolume,
    ...(placement ? { placement } : { pose: poseAt(x, z) }),
  };

  const result = await play(options);
  if (!result.ok || !result.playId) {
    ackError(sessionId, "pad", result.reason ?? "play_failed", { clipId });
    return;
  }

  state.playIds.add(result.playId);
  ack(sessionId, "pad", {
    playId: result.playId,
    clipId,
    x,
    z,
    ...(placement !== undefined ? { placement } : {}),
  });

  if (sound.loop) {
    const pad: LoopPadState = {
      clipId,
      volume: playVolume,
      x,
      z,
      placement,
      loop: true,
    };
    state.loopPads.set(result.playId, pad);
    void startLoopPadPoll(sessionId, state, result.playId, pad);
  }
}

export async function handlePadMove(
  sessionId: string,
  state: SessionState,
  playId: string,
  x: number,
  z: number,
): Promise<void> {
  if (!state.playIds.has(playId)) {
    ackError(sessionId, "pad_move", "unknown_play");
    return;
  }

  const poseResult = await setPlayPose(playId, poseAt(x, z));
  if (!poseResult.ok) {
    ackError(sessionId, "pad_move", poseResult.reason ?? "set_pose_failed");
    return;
  }

  const loopPad = state.loopPads.get(playId);
  if (loopPad) {
    loopPad.x = x;
    loopPad.z = z;
    delete loopPad.placement;
  }

  ack(sessionId, "pad_move", { playId, x, z });
}

async function handleJoin(
  sessionId: string,
  demo: ShowcaseDemo,
  assetOrigin?: string,
): Promise<void> {
  teardownSession(sessionId);

  const state = defaultSessionState(demo, assetOrigin);
  sessions.set(sessionId, state);

  const mixOk = await safeMixCall(sessionId, "setPositionalMixing", () =>
    setPositionalMixing(true),
  );
  if (!mixOk) {
    ackError(sessionId, "join", "positional_mixing_unavailable");
    return;
  }

  ack(sessionId, "join");

  switch (demo) {
    case "orbit": {
      void safeMixCall(sessionId, "setSttEnabled", () =>
        setSttEnabled({ enabled: false, sessionId }),
      );
      startOrbitDemo(sessionId, state);
      break;
    }
    case "soundboard":
      break;
    case "proximity": {
      const groupOk = await ensureShowcaseRoomGroup();
      if (!groupOk) {
        ackError(sessionId, "join", "mix_group_unavailable");
        return;
      }
      const joined = proximityRoom.join(sessionId);
      if (joined === "full") {
        sendToClient(sessionId, { type: "room_full" });
        sessions.delete(sessionId);
        return;
      }
      const added = await safeMixCall(sessionId, "addClientToMix", () =>
        addClientToMix(SHOWCASE_ROOM_GROUP_ID, sessionId),
      );
      if (!added) {
        proximityRoom.leave(sessionId);
        sessions.delete(sessionId);
        ackError(sessionId, "join", "add_to_mix_failed");
        return;
      }
      state.inProximityRoom = true;
      startProximityRoomBroadcast(sessionId, state);
      speak(sessionId, "Welcome to the proximity room.");
      await safeMixCall(sessionId, "setTtsPose", () =>
        setTtsPose(sessionId, poseAt(0, 0)),
      );
      break;
    }
  }
}

function teardownSession(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (!state) {
    return;
  }

  resetOrbitSession(state);
  clearRoomStateTimer(state);
  void stopOrbitSine(state);
  clearAllPlays(sessionId, state);
  void safeMixCall(sessionId, "clearTtsPose", () => clearTtsPose(sessionId));
  void safeMixCall(sessionId, "setSttEnabled", () =>
    setSttEnabled({ enabled: true, sessionId }),
  );

  if (state.inProximityRoom) {
    proximityRoom.leave(sessionId);
    void safeMixCall(sessionId, "removeClientFromMix", () =>
      removeClientFromMix(SHOWCASE_ROOM_GROUP_ID, sessionId),
    );
    state.inProximityRoom = false;
    broadcastRoomStateIfChanged();
  }

  sessions.delete(sessionId);
}

async function dispatchMessage(
  sessionId: string,
  message: ShowcaseInbound,
): Promise<void> {
  const state = sessions.get(sessionId);

  switch (message.type) {
    case "join":
      await handleJoin(sessionId, message.demo, message.assetOrigin);
      return;
    case "ping":
      return;
    case "leave":
      teardownSession(sessionId);
      ack(sessionId, "leave");
      return;
    default:
      if (!state) {
        ackError(sessionId, message.type, "join_required");
        return;
      }
  }

  if (!state) {
    return;
  }

  switch (message.type) {
    case "orbit": {
      if (state.demo !== "orbit") {
        ackError(sessionId, "orbit", "wrong_demo");
        return;
      }
      if (message.action === "set") {
        if (message.radius !== undefined) {
          state.orbit.radius = message.radius;
        }
        if (message.periodSec !== undefined) {
          state.orbit.periodSec = message.periodSec;
        }
        if (message.elevation !== undefined) {
          state.orbit.elevation = message.elevation;
        }
        if (message.paused !== undefined) {
          if (message.paused === false && state.orbitManualPose) {
            syncOrbitClockFromManualPose(state);
          }
          state.orbit.paused = message.paused;
        }
        if (message.frequencyHz !== undefined) {
          state.orbitSineFrequencyHz = message.frequencyHz;
          if (state.orbitSineEnabled && state.orbitSinePlayId) {
            void startOrbitSinePlay(sessionId, state);
          }
        }
        if (message.sinePlaying !== undefined) {
          state.orbitSineEnabled = message.sinePlaying;
          if (message.sinePlaying) {
            if (!state.orbitSinePlayId) {
              void startOrbitSinePlay(sessionId, state);
            }
          } else {
            void stopOrbitSine(state);
          }
        }
        ack(sessionId, "orbit_set");
        return;
      }
      if (message.action === "place") {
        state.orbit.paused = true;
        state.orbitManualPose = { x: message.x, z: message.z };
        const pose = orbitPoseFromXz(state, message.x, message.z);
        if (state.orbitSinePlayId) {
          void safeMixCall(sessionId, "setPlayPose", () =>
            setPlayPose(state.orbitSinePlayId!, pose),
          );
        }
        void safeMixCall(sessionId, "setTtsPose", () =>
          setTtsPose(sessionId, pose),
        );
        emitOrbitPlacePose(sessionId, state, message.x, message.z);
        ack(sessionId, "orbit_place");
        return;
      }
      sendToClient(sessionId, {
        type: "orbit_say_status",
        status: "playing",
      });
      speak(sessionId, message.text);
      ack(sessionId, "orbit_say");
      return;
    }
    case "pad": {
      if (state.demo !== "soundboard") {
        ackError(sessionId, "pad", "wrong_demo");
        return;
      }
      if (!isShowcaseClipId(message.clipId)) {
        ackError(sessionId, "pad", "invalid_clip_id");
        return;
      }
      await handlePadPlay(
        sessionId,
        state,
        message.clipId,
        message.x,
        message.z,
        message.volume,
        message.placement,
      );
      return;
    }
    case "pad_stop": {
      const loopPad = state.loopPads.get(message.playId);
      if (loopPad) {
        clearLoopPad(sessionId, state, message.playId);
      } else {
        state.playIds.delete(message.playId);
      }
      const stopped = await stopPlay(message.playId);
      if (!stopped.ok) {
        ackError(sessionId, "pad_stop", stopped.reason ?? "stop_failed");
        return;
      }
      ack(sessionId, "pad_stop");
      return;
    }
    case "pad_status": {
      const status = await getPlay(message.playId);
      if (!status.ok) {
        ackError(sessionId, "pad_status", status.reason ?? "status_failed");
        return;
      }
      if (status.status) {
        sendToClient(sessionId, {
          type: "pad_progress",
          playId: message.playId,
          status: status.status,
        });
      } else {
        ack(sessionId, "pad_status");
      }
      return;
    }
    case "pad_move": {
      if (state.demo !== "soundboard") {
        ackError(sessionId, "pad_move", "wrong_demo");
        return;
      }
      await handlePadMove(
        sessionId,
        state,
        message.playId,
        message.x,
        message.z,
      );
      return;
    }
    case "move": {
      if (state.demo !== "proximity") {
        ackError(sessionId, "move", "wrong_demo");
        return;
      }
      const yawDeg = message.yawDeg ?? 0;
      proximityRoom.setPose(sessionId, message.x, message.z, yawDeg);
      const poseOk = await safeMixCall(sessionId, "setClientPose", () =>
        setClientPose(sessionId, poseAt(message.x, message.z, yawDeg)),
      );
      if (!poseOk) {
        ackError(sessionId, "move", "set_pose_failed");
        return;
      }
      lastRoomSnapshotByListener.clear();
      broadcastRoomStateIfChanged();
      ack(sessionId, "move");
      return;
    }
    case "mute_peer": {
      if (state.demo !== "proximity") {
        ackError(sessionId, "mute_peer", "wrong_demo");
        return;
      }
      proximityRoom.setPeerMuted(sessionId, message.peerId, message.muted);
      const muteOk = await safeMixCall(sessionId, "setListenerMute", () =>
        setListenerMute({
          listenerId: sessionId,
          targetId: message.peerId,
          muted: message.muted,
        }),
      );
      if (!muteOk) {
        ackError(sessionId, "mute_peer", "mute_failed");
        return;
      }
      lastRoomSnapshotByListener.clear();
      broadcastRoomStateIfChanged();
      ack(sessionId, "mute_peer");
      return;
    }
    default:
      return;
  }
}

defineAgent({
  onAgentStart() {
    for (const sessionId of [...sessions.keys()]) {
      teardownSession(sessionId);
    }
    sessions.clear();
    proximityRoom.clear();
    showcaseRoomGroupReady = null;
    lastRoomSnapshotByListener.clear();
  },

  onSessionStart(ctx) {
    const { sessionId } = ctx;
    if (!isMixAvailable(ctx) && !isTtsPoseAvailable(ctx)) {
      agentLog(
        "warn",
        "spatial-showcase requires voice or Voice+Data — mix/TTS pose APIs unavailable",
        sessionId,
      );
      return;
    }
    sendToClient(sessionId, {
      type: "showcase_ack",
      action: "hello",
      ok: true,
    });
  },

  onDataChannelMessage(ctx) {
    const message = parseShowcaseMessage(ctx.message);
    if (!message) {
      return;
    }
    void dispatchMessage(ctx.sessionId, message);
  },

  onSpeechEvent(ctx, event) {
    const state = sessions.get(ctx.sessionId);
    if (!state || state.demo !== "orbit") {
      return;
    }
    if (event.type === "agent_speaking_start") {
      sendToClient(ctx.sessionId, {
        type: "orbit_say_status",
        status: "playing",
      });
    } else if (event.type === "agent_speaking_end") {
      sendToClient(ctx.sessionId, {
        type: "orbit_say_status",
        status: "ended",
      });
    }
  },

  onSessionEnd({ sessionId }) {
    teardownSession(sessionId);
    agentLog("info", `spatial-showcase session_end ${sessionId}`, sessionId);
  },
});
