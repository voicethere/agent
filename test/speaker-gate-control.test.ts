import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defineAgent,
  getSpeakerGate,
  resetAgentIpcStateForTests,
  resetSpeakerEnrollment,
  setSpeakerGate,
} from "../src/runtime.js";
import { installProcessMessageCapture } from "./helpers/process-mock.js";

const SESSION = "sg-1";

type Capture = ReturnType<typeof installProcessMessageCapture>;

async function startSession(
  capture: Capture,
  speakerGate?: Record<string, unknown>,
): Promise<void> {
  capture.emit({
    type: "session_start",
    sessionId: SESSION,
    env: {},
    ...(speakerGate ? { speakerGate } : {}),
  });
  await vi.waitFor(() =>
    expect(capture.send.mock.calls.map((c) => c[0].type)).toContain(
      "session_start_ack",
    ),
  );
  capture.send.mockClear();
}

describe("speaker gate control", () => {
  const childBundleEnv = process.env.__CHILD_BUNDLE_PATH__;

  afterEach(() => {
    vi.useRealTimers();
    resetAgentIpcStateForTests();
    if (childBundleEnv === undefined) delete process.env.__CHILD_BUNDLE_PATH__;
    else process.env.__CHILD_BUNDLE_PATH__ = childBundleEnv;
  });

  it("is not available outside an agent child, without sending", async () => {
    expect(await setSpeakerGate(SESSION, { mode: "auto" })).toEqual({
      ok: false,
      reason: "not_available",
    });
    expect(await resetSpeakerEnrollment(SESSION)).toEqual({
      ok: false,
      reason: "not_available",
    });
  });

  it("is not available when session_start has no speakerGate, and sends nothing", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    defineAgent({});
    await startSession(capture);
    expect(getSpeakerGate(SESSION)).toEqual({ available: false });
    expect(await setSpeakerGate(SESSION, { mode: "auto" })).toEqual({
      ok: false,
      reason: "not_available",
    });
    expect(await resetSpeakerEnrollment(SESSION)).toEqual({
      ok: false,
      reason: "not_available",
    });
    expect(capture.send).not.toHaveBeenCalled();
  });

  it("rejects an unknown mode or policy as invalid without sending", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    defineAgent({});
    await startSession(capture, {
      available: true,
      mode: "disabled",
      bargeIn: "caller_only",
    });
    expect(await setSpeakerGate(SESSION, { mode: "loud" as never })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(
      await setSpeakerGate(SESSION, { bargeIn: "nobody" as never }),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(capture.send).not.toHaveBeenCalled();
  });

  it("sends setSpeakerGate and resolves with the runner result, updating getSpeakerGate", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    defineAgent({});
    await startSession(capture, {
      available: true,
      mode: "disabled",
      bargeIn: "caller_only",
    });
    expect(getSpeakerGate(SESSION)).toEqual({
      available: true,
      mode: "disabled",
      bargeIn: "caller_only",
    });

    const pending = setSpeakerGate(SESSION, {
      mode: "auto",
      bargeIn: "anyone",
    });
    await vi.waitFor(() => expect(capture.send).toHaveBeenCalled());
    const sent = capture.send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toEqual({
      type: "setSpeakerGate",
      requestId: expect.any(String),
      sessionId: SESSION,
      mode: "auto",
      bargeIn: "anyone",
    });

    capture.emit({
      type: "setSpeakerGateResult",
      requestId: sent.requestId,
      ok: true,
      mode: "auto",
      bargeIn: "anyone",
    });
    expect(await pending).toEqual({
      ok: true,
      mode: "auto",
      bargeIn: "anyone",
    });
    expect(getSpeakerGate(SESSION)).toEqual({
      available: true,
      mode: "auto",
      bargeIn: "anyone",
    });
  });

  it("omits fields the caller did not set", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    defineAgent({});
    await startSession(capture, { available: true, mode: "manual" });
    void setSpeakerGate(SESSION, { bargeIn: "caller_only" });
    await vi.waitFor(() => expect(capture.send).toHaveBeenCalled());
    const sent = capture.send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("mode");
    expect(sent.bargeIn).toBe("caller_only");
  });

  it("passes a runner refusal through and keeps the cached mode", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    defineAgent({});
    await startSession(capture, { available: true, mode: "manual" });
    const pending = setSpeakerGate(SESSION, { mode: "auto" });
    await vi.waitFor(() => expect(capture.send).toHaveBeenCalled());
    const sent = capture.send.mock.calls[0]?.[0] as { requestId: string };
    capture.emit({
      type: "setSpeakerGateResult",
      requestId: sent.requestId,
      ok: false,
      reason: "not_available",
    });
    expect(await pending).toEqual({ ok: false, reason: "not_available" });
    expect(getSpeakerGate(SESSION).mode).toBe("manual");
  });

  it("resolves timeout when the runner never answers", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    defineAgent({});
    await startSession(capture, { available: true, mode: "manual" });
    vi.useFakeTimers();
    const pending = setSpeakerGate(SESSION, { mode: "auto" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ ok: false, reason: "timeout" });
  });

  it("sends resetSpeakerEnrollment and resolves on the result", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    defineAgent({});
    await startSession(capture, { available: true, mode: "auto" });
    const pending = resetSpeakerEnrollment(SESSION);
    await vi.waitFor(() => expect(capture.send).toHaveBeenCalled());
    const sent = capture.send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toEqual({
      type: "resetSpeakerEnrollment",
      requestId: expect.any(String),
      sessionId: SESSION,
    });
    capture.emit({
      type: "resetSpeakerEnrollmentResult",
      requestId: sent.requestId,
      ok: true,
    });
    expect(await pending).toEqual({ ok: true });
  });

  it("exposes speakerGate on the session context", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    const seen: unknown[] = [];
    defineAgent({ onSessionStart: (ctx) => void seen.push(ctx.speakerGate) });
    await startSession(capture, { available: true, mode: "auto" });
    expect(seen).toEqual([{ available: true, mode: "auto" }]);
  });

  it("leaves speakerGate off the session context when not available", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    const seen: Record<string, unknown>[] = [];
    defineAgent({ onSessionStart: (ctx) => void seen.push({ ...ctx }) });
    await startSession(capture, { available: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("speakerGate");
  });
});

describe("speaker gate events", () => {
  const childBundleEnv = process.env.__CHILD_BUNDLE_PATH__;

  afterEach(() => {
    resetAgentIpcStateForTests();
    if (childBundleEnv === undefined) delete process.env.__CHILD_BUNDLE_PATH__;
    else process.env.__CHILD_BUNDLE_PATH__ = childBundleEnv;
  });

  it("passes speaker fields to onUserSpeechFinal and omits them when absent", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    const finals: Record<string, unknown>[] = [];
    defineAgent({ onUserSpeechFinal: (ctx) => void finals.push({ ...ctx }) });
    await startSession(capture);
    capture.emit({
      type: "speech_event",
      sessionId: SESSION,
      event: {
        type: "user_speech_final",
        text: "hello",
        utteranceId: "u1",
        speaker: "unknown",
        speakerUnknownReason: "short",
        speakerCheckWindows: 2,
        speakerRechecked: true,
      },
    });
    capture.emit({
      type: "speech_event",
      sessionId: SESSION,
      event: { type: "user_speech_final", text: "plain" },
    });
    await vi.waitFor(() => expect(finals).toHaveLength(2));
    expect(finals[0]).toMatchObject({
      speaker: "unknown",
      speakerUnknownReason: "short",
      speakerCheckWindows: 2,
      speakerRechecked: true,
    });
    expect(finals[1]).not.toHaveProperty("speaker");
    expect(finals[1]).not.toHaveProperty("speakerCheckWindows");
  });

  it("drops a speaker value outside caller/other/unknown", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    const finals: Record<string, unknown>[] = [];
    defineAgent({ onUserSpeechFinal: (ctx) => void finals.push({ ...ctx }) });
    await startSession(capture);
    capture.emit({
      type: "speech_event",
      sessionId: SESSION,
      event: { type: "user_speech_final", text: "hi", speaker: "robot" },
    });
    await vi.waitFor(() => expect(finals).toHaveLength(1));
    expect(finals[0]).not.toHaveProperty("speaker");
  });

  it("calls onUserSpeechIgnored for user_speech_ignored and not onUserSpeechFinal", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    const ignored: unknown[] = [];
    const finals: unknown[] = [];
    defineAgent({
      onUserSpeechIgnored: (ctx) => void ignored.push(ctx),
      onUserSpeechFinal: (ctx) => void finals.push(ctx),
    });
    await startSession(capture);
    capture.emit({
      type: "speech_event",
      sessionId: SESSION,
      event: {
        type: "user_speech_ignored",
        utteranceId: "u7",
        reason: "speaker_mismatch",
      },
    });
    await vi.waitFor(() => expect(ignored).toHaveLength(1));
    expect(ignored[0]).toEqual({
      sessionId: SESSION,
      utteranceId: "u7",
      reason: "speaker_mismatch",
    });
    expect(finals).toHaveLength(0);
  });
});
