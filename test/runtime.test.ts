import { afterEach, describe, expect, it, vi } from "vitest";

import { agentLog, defineAgent, disconnectClient, sendBinaryToClient, speak } from "../src/runtime.js";
import {
  installProcessMessageCapture,
  installProcessSendMock,
} from "./helpers/process-mock.js";

const SPEECH_EVENT_TYPES = [
  "user_speaking_start",
  "user_speaking_end",
  "vad_triggered",
  "stt_stream_start",
  "stt_stream_end",
  "user_stt_start",
  "user_stt_end",
  "user_stt_not_found",
  "user_speech_partial",
  "user_speech_final",
  "agent_speaking_start",
  "agent_speaking_end",
  "barge_in",
  "error",
] as const;

describe("defineAgent", () => {
  let capture: ReturnType<typeof installProcessMessageCapture>;

  afterEach(() => {
    capture?.restore();
  });

  it("dispatches onSessionStart with sessionId and env", async () => {
    const onSessionStart = vi.fn();
    capture = installProcessMessageCapture();
    defineAgent({ onSessionStart });

    capture.emit({
      type: "session_start",
      sessionId: "peer-1",
      env: { SESSION_ID: "peer-1", PROJECT_ID: "proj", BUILD_ID: "build-1" },
    });

    await vi.waitFor(() => {
      expect(onSessionStart).toHaveBeenCalledWith({
        sessionId: "peer-1",
        env: {
          SESSION_ID: "peer-1",
          PROJECT_ID: "proj",
          BUILD_ID: "build-1",
        },
      });
      expect(capture.send).toHaveBeenCalledWith({
        type: "session_start_ack",
        sessionId: "peer-1",
      });
    });
  });

  it("dispatches onSessionEnd", async () => {
    const onSessionEnd = vi.fn();
    capture = installProcessMessageCapture();
    defineAgent({ onSessionEnd });

    capture.emit({ type: "session_end", sessionId: "peer-2" });

    await vi.waitFor(() => {
      expect(onSessionEnd).toHaveBeenCalledWith({ sessionId: "peer-2" });
    });
  });

  it("dispatches onSpeechEvent and onUserSpeechFinal for user_speech_final", async () => {
    const onSpeechEvent = vi.fn();
    const onUserSpeechFinal = vi.fn();
    capture = installProcessMessageCapture();
    defineAgent({ onSpeechEvent, onUserSpeechFinal });

    capture.emit({
      type: "speech_event",
      sessionId: "peer-1",
      event: { type: "user_speech_final", text: "hello" },
    });

    await vi.waitFor(() => {
      expect(onSpeechEvent).toHaveBeenCalledWith(
        { sessionId: "peer-1" },
        { type: "user_speech_final", text: "hello" },
      );
      expect(onUserSpeechFinal).toHaveBeenCalledWith({
        sessionId: "peer-1",
        text: "hello",
      });
    });
  });

  it("trims whitespace for onUserSpeechFinal", async () => {
    const onUserSpeechFinal = vi.fn();
    capture = installProcessMessageCapture();
    defineAgent({ onUserSpeechFinal });

    capture.emit({
      type: "speech_event",
      sessionId: "peer-1",
      event: { type: "user_speech_final", text: "  hello  " },
    });

    await vi.waitFor(() => {
      expect(onUserSpeechFinal).toHaveBeenCalledWith({
        sessionId: "peer-1",
        text: "hello",
      });
    });
  });

  it("dispatches lifecycle events without text", async () => {
    const onSpeechEvent = vi.fn();
    capture = installProcessMessageCapture();
    defineAgent({ onSpeechEvent });

    capture.emit({
      type: "speech_event",
      sessionId: "peer-1",
      event: { type: "barge_in" },
    });

    await vi.waitFor(() => {
      expect(onSpeechEvent).toHaveBeenCalledWith(
        { sessionId: "peer-1" },
        { type: "barge_in" },
      );
    });
  });

  it.each(SPEECH_EVENT_TYPES)(
    "forwards speech_event type %s to onSpeechEvent",
    async (eventType) => {
      const onSpeechEvent = vi.fn();
      capture = installProcessMessageCapture();
      defineAgent({ onSpeechEvent });

      const event =
        eventType === "user_speech_final" || eventType === "user_speech_partial"
          ? { type: eventType, text: "sample" }
          : eventType === "error"
            ? { type: eventType, error: "vendor failed" }
            : { type: eventType };

      capture.emit({
        type: "speech_event",
        sessionId: "peer-x",
        event,
      });

      await vi.waitFor(() => {
        expect(onSpeechEvent).toHaveBeenCalledWith(
          { sessionId: "peer-x" },
          event,
        );
      });
    },
  );

  it("ignores user_speech_final with empty text for onUserSpeechFinal", async () => {
    const onUserSpeechFinal = vi.fn();
    capture = installProcessMessageCapture();
    defineAgent({ onUserSpeechFinal });

    capture.emit({
      type: "speech_event",
      sessionId: "peer-1",
      event: { type: "user_speech_final", text: "   " },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onUserSpeechFinal).not.toHaveBeenCalled();
  });

  it("ignores user_speech_final without text for onUserSpeechFinal", async () => {
    const onUserSpeechFinal = vi.fn();
    capture = installProcessMessageCapture();
    defineAgent({ onUserSpeechFinal });

    capture.emit({
      type: "speech_event",
      sessionId: "peer-1",
      event: { type: "user_speech_final" },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onUserSpeechFinal).not.toHaveBeenCalled();
  });

  it("ignores unknown IPC messages", async () => {
    const onSessionStart = vi.fn();
    const onSpeechEvent = vi.fn();
    capture = installProcessMessageCapture();
    defineAgent({ onSessionStart, onSpeechEvent });

    capture.emit(null);
    capture.emit("not-json");
    capture.emit({ type: "speak", sessionId: "x", text: "hi" });
    capture.emit({ type: "log", level: "info", message: "child-only" });
    capture.emit({ foo: "bar" });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onSessionStart).not.toHaveBeenCalled();
    expect(onSpeechEvent).not.toHaveBeenCalled();
  });

  it("awaits async handlers", async () => {
    const order: string[] = [];
    capture = installProcessMessageCapture();
    defineAgent({
      onSessionStart: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("start");
      },
    });

    capture.emit({
      type: "session_start",
      sessionId: "peer-1",
      env: {},
    });

    await vi.waitFor(() => expect(order).toEqual(["start"]));
  });

  it("processes session_start before session_end for the same session", async () => {
    const order: string[] = [];
    capture = installProcessMessageCapture();
    defineAgent({
      onSessionStart: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("start");
      },
      onSessionEnd: async () => {
        order.push("end");
      },
    });

    capture.emit({
      type: "session_start",
      sessionId: "peer-1",
      env: {},
    });
    capture.emit({ type: "session_end", sessionId: "peer-1" });

    await vi.waitFor(() => expect(order).toEqual(["start", "end"]));
  });

  it("processes different sessions independently", async () => {
    const order: string[] = [];
    capture = installProcessMessageCapture();
    defineAgent({
      onSessionStart: async ({ sessionId }) => {
        await new Promise((resolve) =>
          setTimeout(resolve, sessionId === "slow" ? 30 : 5),
        );
        order.push(`start:${sessionId}`);
      },
    });

    capture.emit({ type: "session_start", sessionId: "slow", env: {} });
    capture.emit({ type: "session_start", sessionId: "fast", env: {} });

    await vi.waitFor(() =>
      expect(order).toEqual(["start:fast", "start:slow"]),
    );
  });

  it("reports handler errors as agent_error IPC", async () => {
    capture = installProcessMessageCapture();
    const sendMock = installProcessSendMock();
    defineAgent({
      onSessionStart: () => {
        throw new Error("boom");
      },
    });

    capture.emit({
      type: "session_start",
      sessionId: "peer-err",
      env: {},
    });

    await vi.waitFor(() => {
      expect(sendMock.send).toHaveBeenCalledWith({
        type: "agent_error",
        sessionId: "peer-err",
        message: "boom",
        stack: expect.stringContaining("boom"),
      });
    });

    sendMock.restore();
  });

  it("reports rejected async handlers as agent_error IPC", async () => {
    capture = installProcessMessageCapture();
    const sendMock = installProcessSendMock();
    defineAgent({
      onSpeechEvent: async () => {
        throw new Error("async fail");
      },
    });

    capture.emit({
      type: "speech_event",
      sessionId: "peer-async",
      event: { type: "barge_in" },
    });

    await vi.waitFor(() => {
      expect(sendMock.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "agent_error",
          sessionId: "peer-async",
          message: "async fail",
        }),
      );
    });

    sendMock.restore();
  });

  it("runs errorHook before agent_error IPC and swallows hook throws", async () => {
    const errorHook = vi.fn().mockRejectedValue(new Error("hook fail"));
    capture = installProcessMessageCapture();
    const sendMock = installProcessSendMock();
    defineAgent({
      errorHook,
      onSessionStart: () => {
        throw new Error("handler fail");
      },
    });

    capture.emit({
      type: "session_start",
      sessionId: "peer-hook",
      env: { PROJECT_ID: "p1", AGENT_CUSTOMER_CONTEXT: '{"tier":"pro"}' },
    });

    await vi.waitFor(() => {
      expect(errorHook).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "peer-hook",
          projectId: "p1",
          customerContext: { tier: "pro" },
          error: expect.objectContaining({ message: "handler fail" }),
        }),
      );
      expect(sendMock.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "agent_error",
          sessionId: "peer-hook",
          message: "handler fail",
        }),
      );
    });

    sendMock.restore();
  });

  it("dispatches onIdleTimeout and sends idle_timeout_done", async () => {
    const onIdleTimeout = vi.fn().mockResolvedValue(undefined);
    capture = installProcessMessageCapture();
    const sendMock = installProcessSendMock();
    defineAgent({ onIdleTimeout });

    capture.emit({
      type: "session_start",
      sessionId: "peer-idle",
      env: { SESSION_ID: "peer-idle", IDLE_TIMEOUT_SEC: "120" },
    });

    capture.emit({
      type: "idle_timeout",
      sessionId: "peer-idle",
      maxGraceMs: 30_000,
    });

    await vi.waitFor(() => {
      expect(onIdleTimeout).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "peer-idle",
          idleTimeoutSeconds: 120,
        }),
      );
      expect(sendMock.send).toHaveBeenCalledWith({
        type: "idle_timeout_done",
        sessionId: "peer-idle",
        error: undefined,
      });
    });

    sendMock.restore();
  });

  it("dispatches onDataChannelBinary with rawBinary and channel", async () => {
    const onDataChannelBinary = vi.fn();
    capture = installProcessMessageCapture();
    defineAgent({ onDataChannelBinary });

    const data = Buffer.from([0xca, 0xfe]);
    capture.emit({
      type: "data_channel_binary",
      sessionId: "peer-1",
      data,
      channel: "sync",
    });

    await vi.waitFor(() => {
      expect(onDataChannelBinary).toHaveBeenCalledWith({
        sessionId: "peer-1",
        message: null,
        raw: null,
        rawBinary: data,
        channel: "sync",
      });
    });
  });
});

describe("disconnectClient", () => {
  let sendMock: ReturnType<typeof installProcessSendMock>;

  afterEach(() => {
    sendMock?.restore();
  });

  it("sends disconnect_client IPC to parent", () => {
    sendMock = installProcessSendMock();
    disconnectClient("peer-1", { reason: "stale" });
    expect(sendMock.send).toHaveBeenCalledWith({
      type: "disconnect_client",
      sessionId: "peer-1",
      reason: "stale",
    });
  });
});

describe("speak", () => {
  let sendMock: ReturnType<typeof installProcessSendMock>;

  afterEach(() => {
    sendMock?.restore();
  });

  it("sends speak IPC to parent", () => {
    sendMock = installProcessSendMock();
    speak("peer-1", "Hello there");
    expect(sendMock.send).toHaveBeenCalledWith({
      type: "speak",
      sessionId: "peer-1",
      text: "Hello there",
    });
  });
});

describe("sendBinaryToClient", () => {
  let sendMock: ReturnType<typeof installProcessSendMock>;

  afterEach(() => {
    sendMock?.restore();
  });

  it("sends binary IPC to parent", () => {
    sendMock = installProcessSendMock();
    const payload = Uint8Array.of(1, 2, 3);
    sendBinaryToClient("peer-1", payload, "sync");
    expect(sendMock.send).toHaveBeenCalledWith({
      type: "send_binary_to_client",
      sessionId: "peer-1",
      data: Buffer.from(payload),
      channel: "sync",
    });
  });
});

describe("agentLog", () => {
  let sendMock: ReturnType<typeof installProcessSendMock>;

  afterEach(() => {
    sendMock?.restore();
  });

  it("sends structured log IPC", () => {
    sendMock = installProcessSendMock();
    agentLog("info", "started");
    agentLog("error", "failed");
    expect(sendMock.send).toHaveBeenNthCalledWith(1, {
      type: "log",
      level: "info",
      message: "started",
    });
    expect(sendMock.send).toHaveBeenNthCalledWith(2, {
      type: "log",
      level: "error",
      message: "failed",
    });
  });
});
