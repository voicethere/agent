/**
 * Spatial audio showcase — orbit TTS, positional soundboard, proximity room.
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
  broadcastToClients,
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
  setPositionalMixing,
  setTtsPose,
  speak,
  stopPlay,
  type PlayOptions,
} from "@voicethere/agent";

import { orbitTtsPose, type OrbitOptions } from "./orbit.js";
import {
  parseShowcaseMessage,
  poseAt,
  type ShowcaseInbound,
  type ShowcaseDemo,
} from "./protocol.js";
import { ProximityRoom } from "./room.js";
import {
  resolveClipUrl,
  SHOWCASE_SOUND_FILES,
  type ShowcaseClipId,
} from "./sounds.js";

const ORBIT_TICK_MS = 50;
const ORBIT_POSE_EMIT_MS = 100;
const ROOM_STATE_TICK_MS = 100;
const LOOP_PAD_POLL_MS = 250;
const MAX_ACTIVE_PLAYS = 4;
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
  inProximityRoom: boolean;
  lastOrbitPoseEmitMs?: number;
};

const sessions = new Map<string, SessionState>();
const proximityRoom = new ProximityRoom();

let showcaseRoomGroupReady: Promise<boolean> | null = null;
let lastBroadcastRoomSnapshot: string | undefined;

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

function ack(
  sessionId: string,
  action: string,
  extra?: { playId?: string },
): void {
  sendToClient(sessionId, {
    type: "showcase_ack",
    action,
    ok: true,
    ...extra,
  });
}

function ackError(sessionId: string, action: string, error: string): void {
  sendToClient(sessionId, {
    type: "showcase_ack",
    action,
    ok: false,
    error,
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

function defaultSessionState(demo: ShowcaseDemo, assetOrigin?: string): SessionState {
  return {
    demo,
    assetOrigin,
    orbit: { radius: 2, periodSec: 2 * Math.PI, elevation: 0, paused: false },
    playIds: new Set(),
    loopPads: new Map(),
    loopPollTimers: new Map(),
    inProximityRoom: false,
  };
}

function clearOrbitTimer(state: SessionState): void {
  if (state.orbitTimer) {
    clearInterval(state.orbitTimer);
    state.orbitTimer = undefined;
  }
  state.orbitStartMs = undefined;
  state.lastOrbitPoseEmitMs = undefined;
}

function clearRoomStateTimer(state: SessionState): void {
  if (state.roomStateTimer) {
    clearInterval(state.roomStateTimer);
    state.roomStateTimer = undefined;
  }
  state.lastRoomSnapshot = undefined;
}

function clearLoopPad(sessionId: string, state: SessionState, playId: string): void {
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

function emitOrbitPose(sessionId: string, state: SessionState): void {
  if (!state.orbitStartMs) {
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
  const elapsedSec = (now - state.orbitStartMs) / 1000;
  const pose = orbitTtsPose(elapsedSec, state.orbit);
  const angleRad = (2 * Math.PI * elapsedSec) / (state.orbit.periodSec ?? 2 * Math.PI);
  sendToClient(sessionId, {
    type: "orbit_pose",
    angleDeg: (angleRad * 180) / Math.PI,
    x: pose.position.x,
    z: pose.position.z,
  });
}

function startOrbitDemo(sessionId: string, state: SessionState): void {
  state.orbitStartMs = Date.now();
  clearOrbitTimer(state);
  state.orbitTimer = setInterval(() => {
    if (state.orbit.paused || !state.orbitStartMs) {
      return;
    }
    const elapsedSec = (Date.now() - state.orbitStartMs) / 1000;
    void safeMixCall(sessionId, "setTtsPose", () =>
      setTtsPose(sessionId, orbitTtsPose(elapsedSec, state.orbit)),
    );
    emitOrbitPose(sessionId, state);
  }, ORBIT_TICK_MS);
  speak(sessionId, "I'll circle around you.");
}

function broadcastRoomStateIfChanged(): void {
  const snapshot = proximityRoom.snapshot();
  const memberIds = snapshot.map((peer) => peer.id);
  if (memberIds.length === 0) {
    lastBroadcastRoomSnapshot = undefined;
    return;
  }

  const payload = JSON.stringify(snapshot);
  if (payload === lastBroadcastRoomSnapshot) {
    return;
  }
  lastBroadcastRoomSnapshot = payload;
  broadcastToClients({ type: "room_state", peers: snapshot }, memberIds);
}

function startProximityRoomBroadcast(sessionId: string, state: SessionState): void {
  clearRoomStateTimer(state);
  state.roomStateTimer = setInterval(() => {
    broadcastRoomStateIfChanged();
  }, ROOM_STATE_TICK_MS);
  lastBroadcastRoomSnapshot = undefined;
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
  if (state.playIds.size >= MAX_ACTIVE_PLAYS) {
    ackError(sessionId, "pad", "busy");
    return;
  }

  const assetOrigin = state.assetOrigin;
  if (!assetOrigin) {
    ackError(sessionId, "pad", "missing_asset_origin");
    return;
  }

  const url = resolveClipUrl(assetOrigin, clipId);
  if (!url) {
    ackError(sessionId, "pad", "invalid_asset_origin");
    return;
  }

  const sound = SHOWCASE_SOUND_FILES[clipId];
  const playVolume = volume ?? sound.defaultVolume;
  const options: PlayOptions = {
    url,
    sessionIds: [sessionId],
    volume: playVolume,
    ...(placement ? { placement } : { pose: poseAt(x, z) }),
  };

  const result = await play(options);
  if (!result.ok || !result.playId) {
    ackError(sessionId, "pad", result.reason ?? "play_failed");
    return;
  }

  state.playIds.add(result.playId);
  ack(sessionId, "pad", { playId: result.playId });

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
    case "orbit":
      startOrbitDemo(sessionId, state);
      break;
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
      speak(sessionId, "Welcome to the proximity room.");
      await safeMixCall(sessionId, "setTtsPose", () =>
        setTtsPose(sessionId, poseAt(0, 0)),
      );
      startProximityRoomBroadcast(sessionId, state);
      break;
    }
  }
}

function teardownSession(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (!state) {
    return;
  }

  clearOrbitTimer(state);
  clearRoomStateTimer(state);
  clearAllPlays(sessionId, state);
  void safeMixCall(sessionId, "clearTtsPose", () => clearTtsPose(sessionId));

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
          state.orbit.paused = message.paused;
        }
        ack(sessionId, "orbit_set");
        return;
      }
      speak(sessionId, message.text);
      ack(sessionId, "orbit_say");
      return;
    }
    case "pad": {
      if (state.demo !== "soundboard") {
        ackError(sessionId, "pad", "wrong_demo");
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
      lastBroadcastRoomSnapshot = undefined;
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
      lastBroadcastRoomSnapshot = undefined;
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
    lastBroadcastRoomSnapshot = undefined;
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

  onUserSpeechFinal({ sessionId, text }) {
    const state = sessions.get(sessionId);
    if (!state || state.demo !== "orbit") {
      return;
    }
    speak(sessionId, `You said: ${text}`);
  },

  onDataChannelMessage(ctx) {
    const message = parseShowcaseMessage(ctx.message);
    if (!message) {
      return;
    }
    void dispatchMessage(ctx.sessionId, message);
  },

  onSessionEnd({ sessionId }) {
    teardownSession(sessionId);
    agentLog("info", `spatial-showcase session_end ${sessionId}`, sessionId);
  },
});
