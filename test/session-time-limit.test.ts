import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_START_INIT_DELAY_ENABLED_ENV,
  defineAgent,
  disableSessionTimeLimit,
  enableSessionTimeLimit,
  getSessionTimeLimit,
  resetAgentIpcStateForTests,
  setSessionTimeLimit,
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
    available?: boolean;
    handlers?: Parameters<typeof defineAgent>[0];
  },
): Promise<void> {
  defineAgent(options?.handlers ?? {});
  capture.emit({
    type: "session_start",
    sessionId: SESSION,
    env: { SESSION_ID: SESSION, PROJECT_ID: "p1", BUILD_ID: "b1" },
    ...(options?.available === false
      ? {}
      : { sessionTimeLimitAvailable: true }),
  });
  await vi.waitFor(() =>
    expect(sentOfType(capture, "session_start_ack")).toHaveLength(1),
  );
  capture.send.mockClear();
}

const STATE = {
  enabled: true,
  limitMinutes: 10,
  elapsedMs: 1000,
  remainingMs: 599000,
  customReason: false,
};

describe("session time limit", () => {
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

  it("get and set resolve from the control ack", async () => {
    await start(capture);
    const getP = getSessionTimeLimit(SESSION);
    const [getMsg] = sentOfType(capture, "session_time_limit_control");
    expect(getMsg).toMatchObject({ sessionId: SESSION, action: "get" });
    capture.emit({
      type: "session_time_limit_control_ack",
      sessionId: SESSION,
      requestId: getMsg.requestId,
      ok: true,
      state: STATE,
    });
    expect(await getP).toEqual({ ok: true, state: STATE });

    const setP = enableSessionTimeLimit(SESSION, {
      minutes: 5,
      reason: "  Bye  ",
    });
    const msgs = sentOfType(capture, "session_time_limit_control");
    const setMsg = msgs[1];
    expect(setMsg).toMatchObject({
      action: "set",
      enabled: true,
      minutes: 5,
      reason: "Bye",
    });
    capture.emit({
      type: "session_time_limit_control_ack",
      sessionId: SESSION,
      requestId: setMsg.requestId,
      ok: false,
      error: "session_closing",
    });
    expect(await setP).toEqual({ ok: false, error: "session_closing" });
  });

  it("disable sends set with enabled false and no minutes", async () => {
    await start(capture);
    void disableSessionTimeLimit(SESSION);
    const [msg] = sentOfType(capture, "session_time_limit_control");
    expect(msg).toMatchObject({ action: "set", enabled: false });
    expect(msg).not.toHaveProperty("minutes");
    expect(msg).not.toHaveProperty("reason");
  });

  it("times out after 5 s without an ack", async () => {
    await start(capture);
    vi.useFakeTimers();
    const p = getSessionTimeLimit(SESSION);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toEqual({ ok: false, error: "timeout" });
  });

  it("is unsupported when the capability is absent", async () => {
    await start(capture, { available: false });
    expect(await getSessionTimeLimit(SESSION)).toEqual({
      ok: false,
      error: "unsupported",
    });
    expect(sentOfType(capture, "session_time_limit_control")).toHaveLength(0);
  });

  it.each([
    ["0 minutes", { enabled: true, minutes: 0 }, "invalid_minutes"],
    ["1441 minutes", { enabled: true, minutes: 1441 }, "invalid_minutes"],
    ["1.5 minutes", { enabled: true, minutes: 1.5 }, "invalid_minutes"],
    [
      "201-char reason",
      { enabled: true, minutes: 5, reason: "x".repeat(201) },
      "invalid_reason",
    ],
    [
      "control char reason",
      { enabled: true, minutes: 5, reason: "a\nb" },
      "invalid_reason",
    ],
    ["trailing newline", { enabled: true, minutes: 5, reason: "a\n" }, null],
  ])("local validation: %s", async (_name, options, error) => {
    await start(capture);
    const p = setSessionTimeLimit(SESSION, options);
    if (error === null) {
      // Trimmed to "a": valid, goes out over IPC.
      expect(sentOfType(capture, "session_time_limit_control")).toHaveLength(1);
      return;
    }
    expect(await p).toEqual({ ok: false, error });
    expect(sentOfType(capture, "session_time_limit_control")).toHaveLength(0);
  });

  it("hook runs with the context and sends done", async () => {
    const onSessionTimeLimit = vi.fn(async () => {});
    await start(capture, { handlers: { onSessionTimeLimit } });
    capture.emit({
      type: "session_time_limit",
      sessionId: SESSION,
      limitMinutes: 10,
      elapsedMs: 600000,
      maxGraceMs: 10000,
    });
    await vi.waitFor(() =>
      expect(sentOfType(capture, "session_time_limit_done")).toHaveLength(1),
    );
    expect(onSessionTimeLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION,
        projectId: "p1",
        buildId: "b1",
        limitMinutes: 10,
        elapsedMs: 600000,
        graceMs: 10000,
      }),
    );
    expect(sentOfType(capture, "session_time_limit_done")[0]).toEqual({
      type: "session_time_limit_done",
      sessionId: SESSION,
    });
  });

  it("hook that throws sends done with the error", async () => {
    await start(capture, {
      handlers: {
        onSessionTimeLimit: async () => {
          throw new Error("boom");
        },
      },
    });
    capture.emit({
      type: "session_time_limit",
      sessionId: SESSION,
      limitMinutes: 10,
      elapsedMs: 1,
      maxGraceMs: 10000,
    });
    await vi.waitFor(() =>
      expect(sentOfType(capture, "session_time_limit_done")).toHaveLength(1),
    );
    expect(sentOfType(capture, "session_time_limit_done")[0]).toMatchObject({
      error: "boom",
    });
  });

  it("no handler sends done at once", async () => {
    await start(capture);
    capture.emit({
      type: "session_time_limit",
      sessionId: SESSION,
      limitMinutes: 10,
      elapsedMs: 1,
      maxGraceMs: 10000,
    });
    await vi.waitFor(() =>
      expect(sentOfType(capture, "session_time_limit_done")).toHaveLength(1),
    );
    expect(
      sentOfType(capture, "session_time_limit_done")[0],
    ).not.toHaveProperty("error");
  });

  it("the ack is not queued behind a slow session handler", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await start(capture, {
      handlers: { onSessionTimeLimit: async () => gate },
    });
    capture.emit({
      type: "session_time_limit",
      sessionId: SESSION,
      limitMinutes: 10,
      elapsedMs: 1,
      maxGraceMs: 10000,
    });
    // Hook is now blocked; a control request made meanwhile still resolves.
    const p = getSessionTimeLimit(SESSION);
    const [msg] = sentOfType(capture, "session_time_limit_control");
    capture.emit({
      type: "session_time_limit_control_ack",
      sessionId: SESSION,
      requestId: msg.requestId,
      ok: true,
      state: STATE,
    });
    expect(await p).toEqual({ ok: true, state: STATE });
    expect(sentOfType(capture, "session_time_limit_done")).toHaveLength(0);
    release();
    await vi.waitFor(() =>
      expect(sentOfType(capture, "session_time_limit_done")).toHaveLength(1),
    );
  });
});
