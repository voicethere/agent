import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_START_INIT_DELAY_ENABLED_ENV,
  announce,
  cancelSpeech,
  defineAgent,
  resetAgentIpcStateForTests,
  setAgentState,
  setBargeIn,
  speak,
  withoutBargeIn,
} from "../src/runtime.js";
import { installProcessMessageCapture } from "./helpers/process-mock.js";

type Capture = ReturnType<typeof installProcessMessageCapture>;

const SESSION = "peer-1";

function sent(capture: Capture): Array<Record<string, unknown>> {
  return capture.send.mock.calls.map((c) => c[0] as Record<string, unknown>);
}

function sentOfType(capture: Capture, type: string) {
  return sent(capture).filter((m) => m.type === type);
}

async function start(
  capture: Capture,
  options?: {
    speakControlAvailable?: boolean;
    handlers?: Parameters<typeof defineAgent>[0];
  },
): Promise<void> {
  defineAgent(options?.handlers ?? {});
  capture.emit({
    type: "session_start",
    sessionId: SESSION,
    env: { SESSION_ID: SESSION },
    ...(options?.speakControlAvailable === false
      ? {}
      : { speakControlAvailable: true }),
  });
  await vi.waitFor(() =>
    expect(sentOfType(capture, "session_start_ack")).toHaveLength(1),
  );
  capture.send.mockClear();
}

describe("speak control", () => {
  let capture: Capture;

  beforeEach(() => {
    resetAgentIpcStateForTests();
    process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = "false";
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    capture = installProcessMessageCapture();
  });

  afterEach(() => {
    vi.useRealTimers();
    capture.restore();
    resetAgentIpcStateForTests();
    delete process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
    delete process.env.__CHILD_BUNDLE_PATH__;
  });

  it("speak returns a handle whose done resolves from speak_result", async () => {
    await start(capture);
    const handle = speak(SESSION, "Hello", { turnId: "t1", inReplyTo: "u1" });
    expect(sentOfType(capture, "speak")).toEqual([
      {
        type: "speak",
        sessionId: SESSION,
        text: "Hello",
        requestId: handle.requestId,
        turnId: "t1",
        inReplyTo: "u1",
      },
    ]);
    capture.emit({
      type: "speak_result",
      sessionId: SESSION,
      requestId: handle.requestId,
      turnId: "t1",
      status: "played",
      playedMs: 900,
      synthesizedMs: 900,
    });
    await expect(handle.done).resolves.toEqual({
      requestId: handle.requestId,
      turnId: "t1",
      status: "played",
      playedMs: 900,
      synthesizedMs: 900,
    });
  });

  it("speak sends the legacy message and resolves unsupported when the session lacks speakControlAvailable", async () => {
    await start(capture, { speakControlAvailable: false });
    const handle = speak(SESSION, "Hi", { interruptible: false, turnId: "t" });
    expect(sentOfType(capture, "speak")).toEqual([
      { type: "speak", sessionId: SESSION, text: "Hi", interruptible: false },
    ]);
    await expect(handle.done).resolves.toMatchObject({
      status: "unsupported",
      playedMs: 0,
    });
    speak(SESSION, "Again");
    const warns = sentOfType(capture, "log").filter((m) =>
      String(m.message).startsWith("speak control not available"),
    );
    expect(warns).toHaveLength(1);
  });

  it("legacy speak message is unchanged when no options are given", async () => {
    await start(capture, { speakControlAvailable: false });
    speak(SESSION, "Plain");
    expect(sentOfType(capture, "speak")[0]).toEqual({
      type: "speak",
      sessionId: SESSION,
      text: "Plain",
    });
  });

  it("speak_result is handled while a slow session handler is still running", async () => {
    await start(capture, {
      handlers: {
        onUserSpeechFinal: () => new Promise<void>(() => {}),
      },
    });
    capture.emit({
      type: "speech_event",
      sessionId: SESSION,
      event: { type: "user_speech_final", text: "hello" },
    });
    const handle = speak(SESSION, "Reply");
    capture.emit({
      type: "speak_result",
      sessionId: SESSION,
      requestId: handle.requestId,
      status: "played",
      playedMs: 100,
    });
    await expect(handle.done).resolves.toMatchObject({ status: "played" });
  });

  it("session_end resolves pending speaks as cancelled with session_ended", async () => {
    await start(capture);
    const handle = speak(SESSION, "Reply");
    capture.emit({ type: "session_end", sessionId: SESSION });
    await expect(handle.done).resolves.toMatchObject({
      status: "cancelled",
      errorCode: "session_ended",
      playedMs: 0,
    });
  });

  it("cancelSpeech sends speak_cancel with requestId and turnId", async () => {
    await start(capture);
    cancelSpeech(SESSION, { requestId: "r1", turnId: "t1" });
    cancelSpeech(SESSION);
    expect(sentOfType(capture, "speak_cancel")).toEqual([
      {
        type: "speak_cancel",
        sessionId: SESSION,
        requestId: "r1",
        turnId: "t1",
      },
      { type: "speak_cancel", sessionId: SESSION },
    ]);
    const handle = speak(SESSION, "x");
    handle.cancel();
    expect(sentOfType(capture, "speak_cancel")[2]).toEqual({
      type: "speak_cancel",
      sessionId: SESSION,
      requestId: handle.requestId,
    });
  });

  it("announce sends interruptible false", async () => {
    await start(capture);
    announce(SESSION, "Notice", { turnId: "t" });
    expect(sentOfType(capture, "speak")[0]).toMatchObject({
      text: "Notice",
      interruptible: false,
      turnId: "t",
    });
  });

  it("setBargeIn resolves from barge_in_control_ack and times out after 5 s", async () => {
    await start(capture);
    const first = setBargeIn(SESSION, false);
    const req = sentOfType(capture, "barge_in_control")[0]!;
    expect(req).toMatchObject({ sessionId: SESSION, enabled: false });
    capture.emit({
      type: "barge_in_control_ack",
      sessionId: SESSION,
      requestId: req.requestId,
      enabled: false,
      ok: true,
      reason: "applied",
    });
    await expect(first).resolves.toEqual({ ok: true, reason: "applied" });

    vi.useFakeTimers();
    const second = setBargeIn(SESSION, true);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(second).resolves.toEqual({ ok: false, reason: "timeout" });
  });

  it("setBargeIn resolves unsupported without speak control", async () => {
    await start(capture, { speakControlAvailable: false });
    await expect(setBargeIn(SESSION, false)).resolves.toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(sentOfType(capture, "barge_in_control")).toHaveLength(0);
  });

  it("withoutBargeIn re-enables barge-in when the body throws", async () => {
    await start(capture);
    capture.send.mockImplementation((m: Record<string, unknown>) => {
      if (m.type === "barge_in_control") {
        queueMicrotask(() =>
          capture.emit({
            type: "barge_in_control_ack",
            sessionId: SESSION,
            requestId: m.requestId,
            enabled: m.enabled,
            ok: true,
            reason: "applied",
          }),
        );
      }
    });
    await expect(
      withoutBargeIn(SESSION, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(
      sentOfType(capture, "barge_in_control").map((m) => m.enabled),
    ).toEqual([false, true]);
  });

  it("setAgentState truncates detail to 64 chars", async () => {
    await start(capture);
    setAgentState(SESSION, "tool_call", { detail: "x".repeat(100) });
    setAgentState(SESSION, "thinking");
    const states = sentOfType(capture, "agent_state");
    expect((states[0]!.detail as string).length).toBe(64);
    expect(states[1]).toEqual({
      type: "agent_state",
      sessionId: SESSION,
      state: "thinking",
    });
  });

  it("onAgentInterrupted receives agent_interrupted in session order", async () => {
    const order: string[] = [];
    await start(capture, {
      handlers: {
        onAgentInterrupted: (ctx) => {
          order.push(`interrupted:${ctx.playedText}`);
        },
        onUserSpeechFinal: (ctx) => {
          order.push(`final:${ctx.text}`);
        },
      },
    });
    capture.emit({
      type: "agent_interrupted",
      sessionId: SESSION,
      replyPlayedMs: 500,
      playedText: "Hello",
      unplayedText: "world",
      playedTextExact: false,
      cancelledRequestIds: [],
    });
    capture.emit({
      type: "speech_event",
      sessionId: SESSION,
      event: { type: "user_speech_final", text: "stop" },
    });
    await vi.waitFor(() =>
      expect(order).toEqual(["interrupted:Hello", "final:stop"]),
    );
  });
});
