import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetAgentIpcStateForTests } from "../src/runtime.js";
import {
  OTHER_NOTICE_INTERVAL_MS,
  parseSpeakerGateCommand,
  parseSpokenCommand,
  shouldAnswer,
} from "../templates/speaker-gate/agent.js";
import { installProcessMessageCapture } from "./helpers/process-mock.js";

describe("speaker-gate command parser", () => {
  it("maps each chat command", () => {
    expect(parseSpeakerGateCommand("speaker-gate:auto")).toEqual({
      kind: "mode",
      mode: "auto",
    });
    expect(parseSpeakerGateCommand("speaker-gate:manual")).toEqual({
      kind: "mode",
      mode: "manual",
    });
    expect(parseSpeakerGateCommand(" Speaker-Gate:DISABLED ")).toEqual({
      kind: "mode",
      mode: "disabled",
    });
    expect(parseSpeakerGateCommand("speaker-gate:reset")).toEqual({
      kind: "reset",
    });
  });

  it("rejects other text", () => {
    expect(parseSpeakerGateCommand("speaker-gate:loud")).toBeNull();
    expect(parseSpeakerGateCommand("hello")).toBeNull();
    expect(parseSpeakerGateCommand("speaker-gate:auto now")).toBeNull();
  });

  it("maps the spoken phrases, ignoring case and punctuation", () => {
    expect(parseSpokenCommand("Only listen to me.")).toEqual({
      kind: "mode",
      mode: "auto",
    });
    expect(parseSpokenCommand("listen to everyone!")).toEqual({
      kind: "mode",
      mode: "manual",
    });
    expect(parseSpokenCommand("please listen to everyone else")).toBeNull();
  });

  it("answers caller and unknown, not other", () => {
    expect(shouldAnswer("caller")).toBe(true);
    expect(shouldAnswer("unknown")).toBe(true);
    expect(shouldAnswer(undefined)).toBe(true);
    expect(shouldAnswer("other")).toBe(false);
  });
});

describe("speaker-gate template", () => {
  const SESSION = "tpl-1";
  let capture: ReturnType<typeof installProcessMessageCapture>;
  const childBundleEnv = process.env.__CHILD_BUNDLE_PATH__;

  const sent = () => capture.send.mock.calls.map((c) => c[0]);
  const spoken = () =>
    sent()
      .filter((m) => m.type === "speak")
      .map((m) => m.text as string);
  const final = (text: string, extra: Record<string, unknown> = {}) =>
    capture.emit({
      type: "speech_event",
      sessionId: SESSION,
      event: { type: "user_speech_final", text, ...extra },
    });

  beforeEach(async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    vi.resetModules();
    resetAgentIpcStateForTests();
    capture = installProcessMessageCapture();
    await import("../templates/speaker-gate/agent.js");
    capture.emit({
      type: "session_start",
      sessionId: SESSION,
      env: {},
      speakerGate: { available: true, mode: "manual", bargeIn: "caller_only" },
    });
    await vi.waitFor(() =>
      expect(sent().map((m) => m.type)).toContain("session_start_ack"),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAgentIpcStateForTests();
    if (childBundleEnv === undefined) delete process.env.__CHILD_BUNDLE_PATH__;
    else process.env.__CHILD_BUNDLE_PATH__ = childBundleEnv;
  });

  it("answers the caller and says one line per 30 s for other", async () => {
    final("hello there", { speaker: "caller" });
    await vi.waitFor(() => expect(spoken()).toHaveLength(1));
    expect(spoken()[0]).toContain("hello there");

    final("who is that", { speaker: "other" });
    await vi.waitFor(() => expect(spoken()).toHaveLength(2));
    final("and again", { speaker: "other" });
    await new Promise((r) => setTimeout(r, 20));
    expect(spoken()).toHaveLength(2);
    expect(OTHER_NOTICE_INTERVAL_MS).toBe(30_000);
  });

  it("sends setSpeakerGate auto on the chat command", async () => {
    capture.emit({
      type: "data_channel_message",
      sessionId: SESSION,
      payload: JSON.stringify({ type: "chat", text: "speaker-gate:auto" }),
    });
    await vi.waitFor(() =>
      expect(sent().find((m) => m.type === "setSpeakerGate")).toMatchObject({
        mode: "auto",
        sessionId: SESSION,
      }),
    );
  });

  it("switches to auto on 'only listen to me' but ignores it from other", async () => {
    final("only listen to me", { speaker: "other" });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent().some((m) => m.type === "setSpeakerGate")).toBe(false);
    final("only listen to me", { speaker: "caller" });
    await vi.waitFor(() =>
      expect(sent().find((m) => m.type === "setSpeakerGate")).toMatchObject({
        mode: "auto",
      }),
    );
  });

  const logs = () =>
    sent()
      .filter((m) => m.type === "log")
      .map((m) => m.message as string)
      .filter((m) => m.startsWith("speaker_gate."));

  it("writes one exact log line per event with a shared counter", async () => {
    final("hello there", { speaker: "caller" });
    final("no verdict");
    capture.emit({
      type: "speech_event",
      sessionId: SESSION,
      event: {
        type: "user_speech_ignored",
        utteranceId: "u9",
        reason: "speaker_mismatch",
      },
    });
    await vi.waitFor(() => expect(logs()).toHaveLength(4));
    expect(logs()).toEqual([
      "speaker_gate.mode n=1 mode=manual",
      'speaker_gate.final n=2 speaker=caller text="hello there"',
      'speaker_gate.final n=3 speaker=none text="no verdict"',
      "speaker_gate.ignored n=4 utteranceId=u9 reason=speaker_mismatch",
    ]);
  });

  it("logs the mode after a command is applied and reset after it resolves", async () => {
    capture.emit({
      type: "data_channel_message",
      sessionId: SESSION,
      payload: JSON.stringify({ type: "chat", text: "speaker-gate:auto" }),
    });
    await vi.waitFor(() =>
      expect(sent().some((m) => m.type === "setSpeakerGate")).toBe(true),
    );
    expect(logs()).toEqual(["speaker_gate.mode n=1 mode=manual"]);
    const req = sent().find((m) => m.type === "setSpeakerGate")!;
    capture.emit({
      type: "setSpeakerGateResult",
      requestId: req.requestId,
      ok: true,
      mode: "auto",
      bargeIn: "caller_only",
    });
    await vi.waitFor(() => expect(logs()).toHaveLength(2));
    expect(logs()[1]).toBe("speaker_gate.mode n=2 mode=auto");
    // A chat command never reaches the reply path.
    expect(spoken().every((t) => !t.includes("speaker-gate"))).toBe(true);

    capture.emit({
      type: "data_channel_message",
      sessionId: SESSION,
      payload: JSON.stringify({ type: "chat", text: "speaker-gate:reset" }),
    });
    await vi.waitFor(() =>
      expect(sent().some((m) => m.type === "resetSpeakerEnrollment")).toBe(
        true,
      ),
    );
    const reset = sent().find((m) => m.type === "resetSpeakerEnrollment")!;
    capture.emit({
      type: "resetSpeakerEnrollmentResult",
      requestId: reset.requestId,
      ok: true,
    });
    await vi.waitFor(() => expect(logs()).toHaveLength(3));
    expect(logs()[2]).toBe("speaker_gate.reset n=3");
  });
});
