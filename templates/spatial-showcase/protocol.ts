import type { MixPlacement, MixPose } from "@voicethere/agent";

import { isShowcaseClipId } from "./sounds.js";

export type ShowcaseDemo = "orbit" | "soundboard" | "proximity";

const SHOWCASE_DEMOS = new Set<string>(["orbit", "soundboard", "proximity"]);

export const MAX_SAY_TEXT_LENGTH = 200;
export const MAX_XZ = 5;
export const ORBIT_SINE_MIN_FREQUENCY_HZ = 110;
export const ORBIT_SINE_MAX_FREQUENCY_HZ = 1760;

export type ShowcaseJoinMessage = {
  type: "join";
  demo: ShowcaseDemo;
  assetOrigin?: string;
};

export type ShowcaseOrbitSetMessage = {
  type: "orbit";
  action: "set";
  radius?: number;
  periodSec?: number;
  elevation?: number;
  paused?: boolean;
  frequencyHz?: number;
  sinePlaying?: boolean;
};

export type ShowcaseOrbitSayMessage = {
  type: "orbit";
  action: "say";
  text: string;
};

export type ShowcaseOrbitPlaceMessage = {
  type: "orbit";
  action: "place";
  x: number;
  z: number;
};

export type ShowcasePadMessage = {
  type: "pad";
  clipId: string;
  x: number;
  z: number;
  volume?: number;
  placement?: MixPlacement;
};

export type ShowcasePadStopMessage = {
  type: "pad_stop";
  playId: string;
};

export type ShowcasePadStatusMessage = {
  type: "pad_status";
  playId: string;
};

export type ShowcaseMoveMessage = {
  type: "move";
  x: number;
  z: number;
  yawDeg?: number;
};

export type ShowcaseMutePeerMessage = {
  type: "mute_peer";
  peerId: string;
  muted: boolean;
};

export type ShowcaseLeaveMessage = {
  type: "leave";
};

export type ShowcasePingMessage = {
  type: "ping";
};

export type ShowcaseInbound =
  | ShowcaseJoinMessage
  | ShowcaseOrbitSetMessage
  | ShowcaseOrbitSayMessage
  | ShowcaseOrbitPlaceMessage
  | ShowcasePadMessage
  | ShowcasePadStopMessage
  | ShowcasePadStatusMessage
  | ShowcaseMoveMessage
  | ShowcaseMutePeerMessage
  | ShowcaseLeaveMessage
  | ShowcasePingMessage;

export type ShowcaseAck =
  | {
      type: "showcase_ack";
      action: string;
      ok: true;
      playId?: string;
    }
  | { type: "showcase_ack"; action: string; ok: false; error: string };

export type ShowcaseOrbitPose = {
  type: "orbit_pose";
  angleDeg: number;
  x: number;
  z: number;
};

export type ShowcaseOrbitSayStatus = {
  type: "orbit_say_status";
  status: "playing" | "ended";
};

export type ShowcasePadProgress = {
  type: "pad_progress";
  playId: string;
  status: string;
};

export type ShowcaseRoomState = {
  type: "room_state";
  peers: Array<{
    id: string;
    x: number;
    z: number;
    yawDeg: number;
    muted: boolean;
  }>;
};

export type ShowcaseRoomFull = {
  type: "room_full";
};

export type ShowcaseError = {
  type: "error";
  message: string;
};

export type ShowcaseOutbound =
  | ShowcaseAck
  | ShowcaseOrbitPose
  | ShowcaseOrbitSayStatus
  | ShowcasePadProgress
  | ShowcaseRoomState
  | ShowcaseRoomFull
  | ShowcaseError;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clampVolume(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isInXzRange(value: number): boolean {
  return value >= -MAX_XZ && value <= MAX_XZ;
}

function isOrbitSineFrequencyHz(value: number): boolean {
  return (
    value >= ORBIT_SINE_MIN_FREQUENCY_HZ && value <= ORBIT_SINE_MAX_FREQUENCY_HZ
  );
}

function isMixPlacement(value: unknown): value is MixPlacement {
  return (
    value === "center" ||
    value === "left" ||
    value === "right" ||
    value === "front" ||
    value === "behind" ||
    value === "below" ||
    value === "above"
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isShowcaseDemo(value: unknown): value is ShowcaseDemo {
  return typeof value === "string" && SHOWCASE_DEMOS.has(value);
}

export function isShowcaseInbound(
  message: unknown,
): message is ShowcaseInbound {
  return parseShowcaseMessage(message) !== null;
}

export function parseShowcaseMessage(message: unknown): ShowcaseInbound | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const record = message as { type?: unknown };
  if (typeof record.type !== "string") {
    return null;
  }

  switch (record.type) {
    case "join": {
      const join = message as ShowcaseJoinMessage & { assetOrigin?: unknown };
      if (!isShowcaseDemo(join.demo)) {
        return null;
      }
      if (
        join.assetOrigin !== undefined &&
        typeof join.assetOrigin !== "string"
      ) {
        return null;
      }
      return {
        type: "join",
        demo: join.demo,
        ...(typeof join.assetOrigin === "string"
          ? { assetOrigin: join.assetOrigin }
          : {}),
      };
    }
    case "orbit": {
      const orbit = message as { action?: unknown };
      if (orbit.action === "set") {
        const set = message as ShowcaseOrbitSetMessage;
        if (
          set.radius !== undefined &&
          (!isFiniteNumber(set.radius) || set.radius <= 0)
        ) {
          return null;
        }
        if (
          set.periodSec !== undefined &&
          (!isFiniteNumber(set.periodSec) || set.periodSec <= 0)
        ) {
          return null;
        }
        if (set.elevation !== undefined && !isFiniteNumber(set.elevation)) {
          return null;
        }
        if (set.paused !== undefined && typeof set.paused !== "boolean") {
          return null;
        }
        if (
          set.frequencyHz !== undefined &&
          (!isFiniteNumber(set.frequencyHz) ||
            !isOrbitSineFrequencyHz(set.frequencyHz))
        ) {
          return null;
        }
        if (
          set.sinePlaying !== undefined &&
          typeof set.sinePlaying !== "boolean"
        ) {
          return null;
        }
        return {
          type: "orbit",
          action: "set",
          ...(set.radius !== undefined ? { radius: set.radius } : {}),
          ...(set.periodSec !== undefined ? { periodSec: set.periodSec } : {}),
          ...(set.elevation !== undefined ? { elevation: set.elevation } : {}),
          ...(set.paused !== undefined ? { paused: set.paused } : {}),
          ...(set.frequencyHz !== undefined
            ? { frequencyHz: set.frequencyHz }
            : {}),
          ...(set.sinePlaying !== undefined
            ? { sinePlaying: set.sinePlaying }
            : {}),
        };
      }
      if (orbit.action === "place") {
        const place = message as ShowcaseOrbitPlaceMessage;
        if (!isFiniteNumber(place.x) || !isInXzRange(place.x)) {
          return null;
        }
        if (!isFiniteNumber(place.z) || !isInXzRange(place.z)) {
          return null;
        }
        return { type: "orbit", action: "place", x: place.x, z: place.z };
      }
      if (orbit.action === "say") {
        const say = message as ShowcaseOrbitSayMessage;
        if (
          typeof say.text !== "string" ||
          say.text.length === 0 ||
          say.text.length > MAX_SAY_TEXT_LENGTH
        ) {
          return null;
        }
        return { type: "orbit", action: "say", text: say.text };
      }
      return null;
    }
    case "pad": {
      const pad = message as ShowcasePadMessage;
      if (!isShowcaseClipId(pad.clipId)) {
        return null;
      }
      if (!isFiniteNumber(pad.x) || !isInXzRange(pad.x)) {
        return null;
      }
      if (!isFiniteNumber(pad.z) || !isInXzRange(pad.z)) {
        return null;
      }
      if (pad.volume !== undefined) {
        if (!isFiniteNumber(pad.volume)) {
          return null;
        }
      }
      if (pad.placement !== undefined && !isMixPlacement(pad.placement)) {
        return null;
      }
      return {
        type: "pad",
        clipId: pad.clipId,
        x: pad.x,
        z: pad.z,
        ...(pad.volume !== undefined
          ? { volume: clampVolume(pad.volume) }
          : {}),
        ...(pad.placement !== undefined ? { placement: pad.placement } : {}),
      };
    }
    case "pad_stop": {
      const stop = message as ShowcasePadStopMessage;
      if (!isNonEmptyString(stop.playId)) {
        return null;
      }
      return { type: "pad_stop", playId: stop.playId.trim() };
    }
    case "pad_status": {
      const status = message as ShowcasePadStatusMessage;
      if (!isNonEmptyString(status.playId)) {
        return null;
      }
      return { type: "pad_status", playId: status.playId.trim() };
    }
    case "move": {
      const move = message as ShowcaseMoveMessage;
      if (!isFiniteNumber(move.x) || !isInXzRange(move.x)) {
        return null;
      }
      if (!isFiniteNumber(move.z) || !isInXzRange(move.z)) {
        return null;
      }
      if (move.yawDeg !== undefined && !isFiniteNumber(move.yawDeg)) {
        return null;
      }
      return {
        type: "move",
        x: move.x,
        z: move.z,
        ...(move.yawDeg !== undefined ? { yawDeg: move.yawDeg } : {}),
      };
    }
    case "mute_peer": {
      const mute = message as ShowcaseMutePeerMessage;
      if (!isNonEmptyString(mute.peerId) || typeof mute.muted !== "boolean") {
        return null;
      }
      return {
        type: "mute_peer",
        peerId: mute.peerId.trim(),
        muted: mute.muted,
      };
    }
    case "leave":
      return { type: "leave" };
    case "ping":
      return { type: "ping" };
    default:
      return null;
  }
}

/** Y-up world pose; forward −Z. Yaw is degrees about Y. */
export function poseAt(x: number, z: number, yawDeg = 0): MixPose {
  const yawRad = (yawDeg * Math.PI) / 180;
  const half = yawRad / 2;
  return {
    position: { x, y: 0, z },
    orientation: {
      x: 0,
      y: Math.sin(half),
      z: 0,
      w: Math.cos(half),
    },
  };
}
