import { afterEach, describe, expect, it, vi } from "vitest";

import { agentLog, defineAgent, speak } from "../src/runtime.js";
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

  it("reports handler errors as agent_error IPC", async () => {
    const sendMock = installProcessSendMock();
    capture = installProcessMessageCapture();
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
      });
    });

    sendMock.restore();
  });

  it("reports rejected async handlers as agent_error IPC", async () => {
    const sendMock = installProcessSendMock();
    capture = installProcessMessageCapture();
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
      expect(sendMock.send).toHaveBeenCalledWith({
        type: "agent_error",
        sessionId: "peer-async",
        message: "async fail",
      });
    });

    sendMock.restore();
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
