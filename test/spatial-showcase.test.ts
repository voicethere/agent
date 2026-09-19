import { describe, expect, it } from "vitest";

import { MAX_ACTIVE_PLAYS } from "../templates/spatial-showcase/agent.js";
import { PLAY_BYTES_MAX_DECODED_LENGTH } from "../src/runtime.js";
import {
  beginOrbitClock,
  stopOrbitInterval,
} from "../templates/spatial-showcase/orbit-session.js";
import { orbitTtsPose } from "../templates/spatial-showcase/orbit.js";
import {
  MAX_SAY_TEXT_LENGTH,
  ORBIT_SINE_MAX_FREQUENCY_HZ,
  ORBIT_SINE_MIN_FREQUENCY_HZ,
  parseShowcaseMessage,
  poseAt,
} from "../templates/spatial-showcase/protocol.js";
import { ProximityRoom } from "../templates/spatial-showcase/room.js";
import { resolveClipUrl } from "../templates/spatial-showcase/sounds.js";
import {
  buildOrbitSineInlineClipBase64,
  ORBIT_SINE_SAMPLE_RATE,
  orbitSineSampleCount,
} from "../templates/spatial-showcase/sine.js";

describe("spatial showcase agent limits", () => {
  it("allows up to twelve concurrent pad plays", () => {
    expect(MAX_ACTIVE_PLAYS).toBe(12);
  });
});

describe("parseShowcaseMessage", () => {
  it("accepts join with demo", () => {
    expect(
      parseShowcaseMessage({
        type: "join",
        demo: "orbit",
        assetOrigin: "https://app.voicethere.io",
      }),
    ).toEqual({
      type: "join",
      demo: "orbit",
      assetOrigin: "https://app.voicethere.io",
    });
  });

  it("accepts orbit set and say", () => {
    expect(
      parseShowcaseMessage({
        type: "orbit",
        action: "set",
        radius: 3,
        periodSec: 10,
        elevation: 1,
        paused: true,
      }),
    ).toEqual({
      type: "orbit",
      action: "set",
      radius: 3,
      periodSec: 10,
      elevation: 1,
      paused: true,
    });
    expect(
      parseShowcaseMessage({
        type: "orbit",
        action: "set",
        frequencyHz: 880,
        sinePlaying: false,
      }),
    ).toEqual({
      type: "orbit",
      action: "set",
      frequencyHz: 880,
      sinePlaying: false,
    });
    expect(
      parseShowcaseMessage({ type: "orbit", action: "place", x: 1.5, z: -2 }),
    ).toEqual({ type: "orbit", action: "place", x: 1.5, z: -2 });
    expect(
      parseShowcaseMessage({ type: "orbit", action: "say", text: "hello" }),
    ).toEqual({ type: "orbit", action: "say", text: "hello" });
  });

  it("rejects invalid orbit frequency and out-of-range place", () => {
    expect(
      parseShowcaseMessage({
        type: "orbit",
        action: "set",
        frequencyHz: ORBIT_SINE_MIN_FREQUENCY_HZ - 1,
      }),
    ).toBeNull();
    expect(
      parseShowcaseMessage({
        type: "orbit",
        action: "set",
        frequencyHz: ORBIT_SINE_MAX_FREQUENCY_HZ + 1,
      }),
    ).toBeNull();
    expect(
      parseShowcaseMessage({
        type: "orbit",
        action: "set",
        frequencyHz: Number.NaN,
      }),
    ).toBeNull();
    expect(
      parseShowcaseMessage({
        type: "orbit",
        action: "place",
        x: 6,
        z: 0,
      }),
    ).toBeNull();
    expect(
      parseShowcaseMessage({
        type: "orbit",
        action: "place",
        x: 0,
        z: -6,
      }),
    ).toBeNull();
  });

  it("accepts pad with clipId and clamps volume", () => {
    expect(
      parseShowcaseMessage({
        type: "pad",
        clipId: "chime",
        x: 1,
        z: -2,
        volume: 1.5,
      }),
    ).toEqual({
      type: "pad",
      clipId: "chime",
      x: 1,
      z: -2,
      volume: 1,
    });
  });

  it("accepts pad_move with playId and in-range x/z", () => {
    expect(
      parseShowcaseMessage({
        type: "pad_move",
        playId: "play-1",
        x: 2,
        z: -1,
      }),
    ).toEqual({
      type: "pad_move",
      playId: "play-1",
      x: 2,
      z: -1,
    });
  });

  it("rejects pad_move without playId or out-of-range x/z", () => {
    expect(
      parseShowcaseMessage({
        type: "pad_move",
        playId: "",
        x: 0,
        z: 0,
      }),
    ).toBeNull();
    expect(
      parseShowcaseMessage({
        type: "pad_move",
        playId: "play-1",
        x: 6,
        z: 0,
      }),
    ).toBeNull();
    expect(
      parseShowcaseMessage({
        type: "pad_move",
        playId: "play-1",
        x: 0,
        z: -6,
      }),
    ).toBeNull();
  });

  it("accepts move, mute_peer, leave, ping", () => {
    expect(parseShowcaseMessage({ type: "move", x: 0, z: 1 })).toEqual({
      type: "move",
      x: 0,
      z: 1,
    });
    expect(
      parseShowcaseMessage({
        type: "mute_peer",
        peerId: "peer-a",
        muted: true,
      }),
    ).toEqual({ type: "mute_peer", peerId: "peer-a", muted: true });
    expect(parseShowcaseMessage({ type: "leave" })).toEqual({ type: "leave" });
    expect(parseShowcaseMessage({ type: "ping" })).toEqual({ type: "ping" });
  });

  it("rejects join without demo", () => {
    expect(parseShowcaseMessage({ type: "join" })).toBeNull();
    expect(parseShowcaseMessage({ type: "join", demo: "invalid" })).toBeNull();
  });

  it("rejects NaN coordinates", () => {
    expect(
      parseShowcaseMessage({
        type: "pad",
        clipId: "chime",
        x: Number.NaN,
        z: 0,
      }),
    ).toBeNull();
    expect(
      parseShowcaseMessage({ type: "move", x: 0, z: Number.NaN }),
    ).toBeNull();
  });

  it("rejects out-of-range x/z", () => {
    expect(
      parseShowcaseMessage({
        type: "pad",
        clipId: "chime",
        x: 6,
        z: 0,
      }),
    ).toBeNull();
    expect(parseShowcaseMessage({ type: "move", x: 0, z: -6 })).toBeNull();
  });

  it("rejects unknown clipId", () => {
    expect(
      parseShowcaseMessage({
        type: "pad",
        clipId: "unknown",
        x: 0,
        z: 0,
      }),
    ).toBeNull();
  });

  it("rejects oversized say text", () => {
    expect(
      parseShowcaseMessage({
        type: "orbit",
        action: "say",
        text: "x".repeat(MAX_SAY_TEXT_LENGTH + 1),
      }),
    ).toBeNull();
  });
});

describe("resolveClipUrl", () => {
  it("resolves good origins", () => {
    expect(resolveClipUrl("https://app.voicethere.io", "chime")).toBe(
      "https://app.voicethere.io/showcase/sounds/chime.wav",
    );
    expect(resolveClipUrl("https://app.voicethere.dev", "bell")).toBe(
      "https://app.voicethere.dev/showcase/sounds/bell.wav",
    );
    expect(resolveClipUrl("http://localhost:3000", "laser")).toBe(
      "http://localhost:3000/showcase/sounds/laser.wav",
    );
  });

  it("trims trailing slash on origin", () => {
    expect(resolveClipUrl("https://app.voicethere.io/", "chime")).toBe(
      "https://app.voicethere.io/showcase/sounds/chime.wav",
    );
  });

  it("returns null for disallowed origin", () => {
    expect(resolveClipUrl("https://evil.example", "chime")).toBeNull();
  });

  it("returns null for unknown clip", () => {
    expect(resolveClipUrl("https://app.voicethere.io", "nope")).toBeNull();
  });
});

describe("poseAt", () => {
  it("places position on XZ plane with identity yaw", () => {
    const pose = poseAt(2, 3);
    expect(pose.position).toEqual({ x: 2, y: 0, z: 3 });
    expect(pose.orientation.w).toBeCloseTo(1);
    expect(pose.orientation.y).toBeCloseTo(0);
  });

  it("rotates yaw about Y", () => {
    const pose = poseAt(0, 0, 90);
    expect(pose.orientation.y).toBeCloseTo(Math.sin(Math.PI / 4));
    expect(pose.orientation.w).toBeCloseTo(Math.cos(Math.PI / 4));
  });
});

describe("buildOrbitSineInlineClipBase64", () => {
  it("builds a valid RIFF WAV under the play bytes cap with non-zero sine samples", () => {
    const base64 = buildOrbitSineInlineClipBase64();
    const bytes = Buffer.from(base64, "base64");
    expect(bytes.length).toBeLessThan(PLAY_BYTES_MAX_DECODED_LENGTH);
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
    const dataSize = bytes.readUInt32LE(40);
    expect(dataSize).toBeGreaterThan(0);
    const samples = bytes.subarray(44, 44 + Math.min(dataSize, 200));
    const hasNonZero = [...samples].some((byte) => byte !== 0);
    expect(hasNonZero).toBe(true);
  });

  it("snaps sample count to an integer number of cycles", () => {
    const frequencyHz = 333;
    const numSamples = orbitSineSampleCount(2000, frequencyHz);
    const cycles = (frequencyHz * numSamples) / ORBIT_SINE_SAMPLE_RATE;
    expect(Number.isInteger(cycles)).toBe(true);
    expect(cycles).toBeGreaterThan(0);
  });

  it("starts at a zero crossing and loops after an integer number of cycles", () => {
    const frequencyHz = 440;
    const numSamples = orbitSineSampleCount(2000, frequencyHz);
    const base64 = buildOrbitSineInlineClipBase64(2000, frequencyHz, 8000, 0);
    const bytes = Buffer.from(base64, "base64");
    const first = bytes.readInt16LE(44);
    expect(first).toBe(0);
    const cycles = (frequencyHz * numSamples) / ORBIT_SINE_SAMPLE_RATE;
    expect(Number.isInteger(cycles)).toBe(true);
    const loopSample = Math.round(
      8000 *
        Math.sin(
          (2 * Math.PI * frequencyHz * numSamples) / ORBIT_SINE_SAMPLE_RATE,
        ),
    );
    expect(loopSample).toBe(first);
  });

  it("honors phaseRad at the first sample", () => {
    const phaseRad = Math.PI / 4;
    const amplitude = 8000;
    const base64 = buildOrbitSineInlineClipBase64(
      2000,
      440,
      amplitude,
      phaseRad,
    );
    const bytes = Buffer.from(base64, "base64");
    const first = bytes.readInt16LE(44);
    expect(first).toBe(Math.round(amplitude * Math.sin(phaseRad)));
  });
});

describe("orbit manual pose resume", () => {
  it("maps atan2(z, x) to orbit pose for clock sync", () => {
    const periodSec = 2 * Math.PI;
    const radius = 2;
    const x = 0;
    const z = radius;
    const angleRad = Math.atan2(z, x);
    const elapsedSec = (angleRad * periodSec) / (2 * Math.PI);
    const pose = orbitTtsPose(elapsedSec, { radius, periodSec });
    expect(pose.position.x).toBeCloseTo(x);
    expect(pose.position.z).toBeCloseTo(z);
  });
});

describe("orbitTtsPose", () => {
  it("starts on +X at t=0", () => {
    const pose = orbitTtsPose(0, { radius: 2 });
    expect(pose.position.x).toBeCloseTo(2);
    expect(pose.position.z).toBeCloseTo(0);
  });

  it("moves to +Z at quarter period", () => {
    const periodSec = 2 * Math.PI;
    const pose = orbitTtsPose(periodSec / 4, { radius: 2, periodSec });
    expect(pose.position.x).toBeCloseTo(0);
    expect(pose.position.z).toBeCloseTo(2);
  });

  it("applies elevation on Y", () => {
    const pose = orbitTtsPose(0, { radius: 2, elevation: 1.5 });
    expect(pose.position.y).toBeCloseTo(1.5);
  });
});

describe("orbit session helpers", () => {
  it("beginOrbitClock keeps orbitStartMs after stopOrbitInterval", () => {
    const state = { orbitStartMs: undefined as number | undefined };
    stopOrbitInterval(state);
    beginOrbitClock(state);
    expect(state.orbitStartMs).toBeTypeOf("number");
    stopOrbitInterval(state);
    expect(state.orbitStartMs).toBeTypeOf("number");
  });
});

describe("ProximityRoom", () => {
  it("allows 8 joins and rejects the 9th", () => {
    const room = new ProximityRoom();
    for (let i = 0; i < 8; i++) {
      expect(room.join(`peer-${i}`)).toBe("ok");
    }
    expect(room.join("peer-8")).toBe("full");
  });

  it("frees a slot on leave", () => {
    const room = new ProximityRoom();
    for (let i = 0; i < 8; i++) {
      room.join(`peer-${i}`);
    }
    room.leave("peer-0");
    expect(room.join("peer-new")).toBe("ok");
  });

  it("snapshotFor returns poses", () => {
    const room = new ProximityRoom();
    room.join("a");
    room.setPose("a", 2, 3, 45);
    expect(room.snapshotFor("a")).toEqual([
      { id: "a", x: 2, z: 3, yawDeg: 45, muted: false },
    ]);
  });

  it("snapshotFor muted is per-listener", () => {
    const room = new ProximityRoom();
    room.join("a");
    room.join("b");
    room.setPeerMuted("a", "b", true);

    const viewA = room.snapshotFor("a");
    const viewB = room.snapshotFor("b");

    expect(viewA.find((peer) => peer.id === "b")?.muted).toBe(true);
    expect(viewA.find((peer) => peer.id === "a")?.muted).toBe(false);
    expect(viewB.find((peer) => peer.id === "b")?.muted).toBe(false);
    expect(viewB.find((peer) => peer.id === "a")?.muted).toBe(false);
  });
});
