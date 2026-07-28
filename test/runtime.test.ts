import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  agentLog,
  defineAgent,
  disconnectClient,
  resetAgentIpcStateForTests,
  sendBinaryToClient,
  sendToClient,
  speak,
  SESSION_START_INIT_DELAY_MS_ENV,
  SESSION_START_INIT_DELAY_ENABLED_ENV,
} from "../src/runtime.js";
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
    resetAgentIpcStateForTests();
  });

  it("runs onAgentStart once before session IPC handlers", async () => {
    const originalEnabled = process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
    process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = "false";
    try {
      const order: string[] = [];
      let releaseStart!: () => void;
      const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });

      capture = installProcessMessageCapture();
      defineAgent({
        onAgentStart: async () => {
          order.push("start");
          await startGate;
          order.push("start-done");
        },
        onSessionStart: async () => {
          order.push("session");
        },
      });

      capture.emit({
        type: "session_start",
        sessionId: "peer-agent-start",
        env: { SESSION_ID: "peer-agent-start" },
      });

      await vi.waitFor(() => {
        expect(order).toContain("start");
      });
      expect(order).not.toContain("session");

      releaseStart();

      await vi.waitFor(() => {
        expect(order).toEqual(["start", "start-done", "session"]);
        expect(capture.send).toHaveBeenCalledWith({
          type: "session_start_ack",
          sessionId: "peer-agent-start",
        });
      });
    } finally {
      if (originalEnabled === undefined) {
        delete process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
      } else {
        process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = originalEnabled;
      }
    }
  });

  it("reports onAgentStart errors without blocking later session IPC", async () => {
    const originalEnabled = process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
    process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = "false";
    try {
      capture = installProcessMessageCapture();
      const onSessionStart = vi.fn();
      defineAgent({
        onAgentStart: async () => {
          throw new Error("redis unavailable");
        },
        onSessionStart,
      });

      capture.emit({
        type: "session_start",
        sessionId: "peer-after-fail",
        env: { SESSION_ID: "peer-after-fail" },
      });

      await vi.waitFor(() => {
        expect(capture.send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "log",
            level: "error",
            message: expect.stringContaining("onAgentStart failed"),
          }),
        );
        expect(capture.send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "agent_error",
            message: "redis unavailable",
          }),
        );
        expect(onSessionStart).toHaveBeenCalled();
        expect(capture.send).toHaveBeenCalledWith({
          type: "session_start_ack",
          sessionId: "peer-after-fail",
        });
      });
    } finally {
      if (originalEnabled === undefined) {
        delete process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
      } else {
        process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = originalEnabled;
      }
    }
  });

  it("passes process.env snapshot to onAgentStart", async () => {
    const previous = process.env.AGENT_REDIS_URL;
    const originalEnabled = process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
    process.env.AGENT_REDIS_URL = "redis://127.0.0.1:6379/0";
    process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = "false";
    try {
      const onAgentStart = vi.fn().mockResolvedValue(undefined);
      capture = installProcessMessageCapture();
      defineAgent({ onAgentStart });

      capture.emit({
        type: "session_start",
        sessionId: "peer-env",
        env: { SESSION_ID: "peer-env" },
      });

      await vi.waitFor(() => {
        expect(onAgentStart).toHaveBeenCalledWith(
          expect.objectContaining({
            env: expect.objectContaining({
              AGENT_REDIS_URL: "redis://127.0.0.1:6379/0",
            }),
          }),
        );
      });
    } finally {
      if (previous === undefined) {
        delete process.env.AGENT_REDIS_URL;
      } else {
        process.env.AGENT_REDIS_URL = previous;
      }
      if (originalEnabled === undefined) {
        delete process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
      } else {
        process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = originalEnabled;
      }
    }
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

  it("applies the default session_start init delay when enabled by default", async () => {
    vi.useFakeTimers();
    const originalEnabled = process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
    const originalMs = process.env[SESSION_START_INIT_DELAY_MS_ENV];
    delete process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
    delete process.env[SESSION_START_INIT_DELAY_MS_ENV];

    try {
      const onSessionStart = vi.fn();
      capture = installProcessMessageCapture();
      defineAgent({ onSessionStart });

      capture.emit({
        type: "session_start",
        sessionId: "peer-delay-default",
        env: { SESSION_ID: "peer-delay-default" },
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(onSessionStart).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(499);
      expect(onSessionStart).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(onSessionStart).toHaveBeenCalledWith({
        sessionId: "peer-delay-default",
        env: { SESSION_ID: "peer-delay-default" },
      });
    } finally {
      if (originalEnabled === undefined) {
        delete process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
      } else {
        process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = originalEnabled;
      }
      if (originalMs === undefined) {
        delete process.env[SESSION_START_INIT_DELAY_MS_ENV];
      } else {
        process.env[SESSION_START_INIT_DELAY_MS_ENV] = originalMs;
      }
      vi.useRealTimers();
    }
  });

  it("supports overriding session_start init delay via env", async () => {
    vi.useFakeTimers();
    const originalEnabled = process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
    const originalMs = process.env[SESSION_START_INIT_DELAY_MS_ENV];
    process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = "true";
    process.env[SESSION_START_INIT_DELAY_MS_ENV] = "120";

    try {
      const onSessionStart = vi.fn();
      capture = installProcessMessageCapture();
      defineAgent({ onSessionStart });

      capture.emit({
        type: "session_start",
        sessionId: "peer-delay-custom",
        env: { SESSION_ID: "peer-delay-custom" },
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(onSessionStart).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(119);
      expect(onSessionStart).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(onSessionStart).toHaveBeenCalledWith({
        sessionId: "peer-delay-custom",
        env: { SESSION_ID: "peer-delay-custom" },
      });
    } finally {
      if (originalEnabled === undefined) {
        delete process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
      } else {
        process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = originalEnabled;
      }
      if (originalMs === undefined) {
        delete process.env[SESSION_START_INIT_DELAY_MS_ENV];
      } else {
        process.env[SESSION_START_INIT_DELAY_MS_ENV] = originalMs;
      }
      vi.useRealTimers();
    }
  });

  it("supports disabling session_start init delay via env", async () => {
    const originalEnabled = process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
    const originalMs = process.env[SESSION_START_INIT_DELAY_MS_ENV];
    process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = "false";
    process.env[SESSION_START_INIT_DELAY_MS_ENV] = "500";

    try {
      const onSessionStart = vi.fn();
      capture = installProcessMessageCapture();
      defineAgent({ onSessionStart });

      capture.emit({
        type: "session_start",
        sessionId: "peer-delay-disabled",
        env: { SESSION_ID: "peer-delay-disabled" },
      });

      // Queue containment adds terminal catch microtasks; wait until the handler runs.
      await vi.waitFor(() => {
        expect(onSessionStart).toHaveBeenCalledWith({
          sessionId: "peer-delay-disabled",
          env: { SESSION_ID: "peer-delay-disabled" },
        });
      });
    } finally {
      if (originalEnabled === undefined) {
        delete process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
      } else {
        process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = originalEnabled;
      }
      if (originalMs === undefined) {
        delete process.env[SESSION_START_INIT_DELAY_MS_ENV];
      } else {
        process.env[SESSION_START_INIT_DELAY_MS_ENV] = originalMs;
      }
    }
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

  it("invalidates session_start immediately when session_end arrives", async () => {
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
    // Immediate clear must cancel the not-yet-run start; only end runs.
    capture.emit({ type: "session_end", sessionId: "peer-1" });

    await vi.waitFor(() => expect(order).toEqual(["end"]));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(order).toEqual(["end"]);
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

    await vi.waitFor(() => expect(order).toEqual(["start:fast", "start:slow"]));
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

  it("reports awaited handler rejection once (not doubled by unhandledRejection guard)", async () => {
    capture = installProcessMessageCapture();
    defineAgent({
      onSessionStart: () => {
        throw new Error("once");
      },
    });

    capture.emit({
      type: "session_start",
      sessionId: "peer-once",
      env: {},
    });

    await vi.waitFor(() => {
      const agentErrors = capture.send.mock.calls.filter(
        ([message]) =>
          message !== null &&
          typeof message === "object" &&
          (message as { type?: string }).type === "agent_error",
      );
      expect(agentErrors).toHaveLength(1);
      expect(agentErrors[0]?.[0]).toEqual(
        expect.objectContaining({
          type: "agent_error",
          sessionId: "peer-once",
          message: "once",
        }),
      );
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const agentErrors = capture.send.mock.calls.filter(
      ([message]) =>
        message !== null &&
        typeof message === "object" &&
        (message as { type?: string }).type === "agent_error",
    );
    expect(agentErrors).toHaveLength(1);
  });

  it("reports detached unhandledRejection as one agent_error", async () => {
    capture = installProcessMessageCapture();
    defineAgent({});

    const reason = new Error("detached boom");
    process.emit("unhandledRejection", reason, Promise.resolve());

    await vi.waitFor(() => {
      const agentErrors = capture.send.mock.calls.filter(
        ([message]) =>
          message !== null &&
          typeof message === "object" &&
          (message as { type?: string }).type === "agent_error",
      );
      expect(agentErrors).toHaveLength(1);
      expect(agentErrors[0]?.[0]).toEqual(
        expect.objectContaining({
          type: "agent_error",
          sessionId: "",
          message: "detached boom",
          stack: expect.stringContaining("detached boom"),
        }),
      );
      expect(capture.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "log",
          level: "error",
          message: expect.stringContaining("unhandledRejection: detached boom"),
        }),
      );
    });
  });

  it("does not install duplicate unhandledRejection listeners across defineAgent calls", () => {
    capture = installProcessMessageCapture();
    defineAgent({});
    const afterFirst = process.listenerCount("unhandledRejection");
    defineAgent({});
    expect(process.listenerCount("unhandledRejection")).toBe(afterFirst);
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

  it("sends idle_timeout_done immediately when onIdleTimeout is not defined", async () => {
    const onClientJoin = vi.fn();
    capture = installProcessMessageCapture();
    const sendMock = installProcessSendMock();
    defineAgent({ onClientJoin });

    capture.emit({
      type: "idle_timeout",
      sessionId: "peer-no-hook",
      maxGraceMs: 30_000,
    });

    await vi.waitFor(() => {
      expect(sendMock.send).toHaveBeenCalledWith({
        type: "idle_timeout_done",
        sessionId: "peer-no-hook",
      });
    });
    expect(sendMock.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "log",
        level: "info",
        message: expect.stringContaining("idle_timeout ipc received"),
        sessionId: "peer-no-hook",
      }),
    );
    expect(sendMock.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "log",
        level: "info",
        message: expect.stringContaining("idle_timeout_done ipc sent"),
        sessionId: "peer-no-hook",
      }),
    );
    expect(onClientJoin).not.toHaveBeenCalled();

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

  beforeEach(() => {
    resetAgentIpcStateForTests();
  });

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

  it("does not speak after session_end for the same session", async () => {
    const capture = installProcessMessageCapture();
    const onSessionEnd = vi.fn();
    defineAgent({
      onSessionStart: async ({ sessionId }) => {
        speak(sessionId, "ready");
      },
      onSessionEnd,
    });

    capture.emit({
      type: "session_start",
      sessionId: "peer-1",
      env: { SESSION_ID: "peer-1", PEER_ID: "p1" },
    });
    await vi.waitFor(() => expect(capture.send).toHaveBeenCalled());
    capture.send.mockClear();

    capture.emit({ type: "session_end", sessionId: "peer-1" });
    await vi.waitFor(() => expect(onSessionEnd).toHaveBeenCalled());
    capture.send.mockClear();

    speak("peer-1", "too late");
    expect(capture.send).not.toHaveBeenCalled();
    capture.restore();
  });
});

describe("sendBinaryToClient", () => {
  let sendMock: ReturnType<typeof installProcessSendMock>;

  afterEach(() => {
    sendMock?.restore();
    resetAgentIpcStateForTests();
  });

  it("sends binary IPC to parent", () => {
    resetAgentIpcStateForTests();
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
  let capture: ReturnType<typeof installProcessMessageCapture>;

  afterEach(() => {
    sendMock?.restore();
    capture?.restore();
    resetAgentIpcStateForTests();
  });

  it("sends structured log IPC with timestamp", () => {
    sendMock = installProcessSendMock();
    agentLog("info", "started");
    agentLog("error", "failed");
    expect(sendMock.send).toHaveBeenNthCalledWith(1, {
      type: "log",
      level: "info",
      message: "started",
      ts: expect.any(Number),
    });
    expect(sendMock.send).toHaveBeenNthCalledWith(2, {
      type: "log",
      level: "error",
      message: "failed",
      ts: expect.any(Number),
    });
  });

  it("supports debug and warn levels", () => {
    sendMock = installProcessSendMock();
    agentLog("debug", "trace");
    agentLog("warn", "careful");
    expect(sendMock.send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ level: "debug", message: "trace" }),
    );
    expect(sendMock.send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ level: "warn", message: "careful" }),
    );
  });

  it("includes explicit sessionId in log IPC", () => {
    sendMock = installProcessSendMock();
    agentLog("info", "hello", "session-a");
    expect(sendMock.send).toHaveBeenCalledWith({
      type: "log",
      level: "info",
      message: "hello",
      sessionId: "session-a",
      ts: expect.any(Number),
    });
  });

  it("includes structured fields and optional sessionId", () => {
    sendMock = installProcessSendMock();
    agentLog("info", "event", { count: 3, peer: "p1" }, "session-a");
    expect(sendMock.send).toHaveBeenCalledWith({
      type: "log",
      level: "info",
      message: "event",
      fields: { count: 3, peer: "p1" },
      sessionId: "session-a",
      ts: expect.any(Number),
    });
  });

  it("truncates oversized message and fields", () => {
    sendMock = installProcessSendMock();
    const longMessage = "x".repeat(3000);
    const longFields = { blob: "y".repeat(10_000) };
    agentLog("info", longMessage, longFields);
    const payload = sendMock.send.mock.calls[0]?.[0] as {
      message: string;
      fields: Record<string, unknown>;
    };
    expect(payload.message.length).toBeLessThanOrEqual(2048);
    expect(payload.message.endsWith("…[truncated]")).toBe(true);
    expect(payload.fields._agentLogFieldsTruncated).toBe(true);
  });

  it("includes active session from handler context", async () => {
    capture = installProcessMessageCapture();
    sendMock = installProcessSendMock();
    defineAgent({
      onSpeechEvent: async () => {
        agentLog("info", "inside handler");
      },
    });
    capture.emit({
      type: "speech_event",
      sessionId: "session-b",
      event: { type: "user_speech_final", text: "hi" },
    });
    await vi.waitFor(() => {
      expect(sendMock.send).toHaveBeenCalledWith({
        type: "log",
        level: "info",
        message: "inside handler",
        sessionId: "session-b",
        ts: expect.any(Number),
      });
    });
  });
});

describe("generation-aware outbound guards", () => {
  let capture: ReturnType<typeof installProcessMessageCapture>;

  beforeEach(() => {
    process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = "false";
  });

  afterEach(() => {
    capture?.restore();
    resetAgentIpcStateForTests();
    delete process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
  });

  it("allows detached sendBinaryToClient after inbound queue drains", async () => {
    capture = installProcessMessageCapture();
    defineAgent({
      onSessionStart: async () => {
        // no-op — queue becomes idle after this handler completes
      },
    });

    capture.emit({
      type: "session_start",
      sessionId: "fanout-1",
      env: { SESSION_ID: "fanout-1" },
    });
    await vi.waitFor(() => {
      expect(capture.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "session_start_ack",
          sessionId: "fanout-1",
        }),
      );
    });
    capture.send.mockClear();

    // Simulate timer/Redis world loop outside handler ALS after idle drain.
    sendBinaryToClient("fanout-1", Buffer.from([9, 9]), "sync");
    expect(capture.send).toHaveBeenCalledWith({
      type: "send_binary_to_client",
      sessionId: "fanout-1",
      data: Buffer.from([9, 9]),
      channel: "sync",
    });

    sendToClient("fanout-1", { type: "tick" });
    expect(capture.send).toHaveBeenCalledWith({
      type: "send_to_client",
      sessionId: "fanout-1",
      payload: { type: "tick" },
    });
  });

  it("blocks detached outbound after session_end", async () => {
    capture = installProcessMessageCapture();
    defineAgent({
      onSessionStart: async () => {},
    });

    capture.emit({
      type: "session_start",
      sessionId: "fanout-end",
      env: { SESSION_ID: "fanout-end" },
    });
    await vi.waitFor(() => {
      expect(capture.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session_start_ack" }),
      );
    });
    capture.emit({ type: "session_end", sessionId: "fanout-end" });
    await vi.waitFor(() => {
      // session_end processing may emit logs; clear then assert drop
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    capture.send.mockClear();

    sendBinaryToClient("fanout-end", Buffer.from([1]), "sync");
    sendToClient("fanout-end", { type: "tick" });
    expect(capture.send).not.toHaveBeenCalled();
  });

  it("blocks old handler outbound after session_end + same-id reuse", async () => {
    capture = installProcessMessageCapture();
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let oldHandlerReached = false;

    defineAgent({
      onSessionStart: async ({ sessionId }) => {
        if (sessionId === "reuse-1" && !oldHandlerReached) {
          oldHandlerReached = true;
          await oldGate;
          speak(sessionId, "stale-speak");
          sendBinaryToClient(sessionId, Buffer.from([1]));
          disconnectClient(sessionId);
          agentLog("info", "stale-log", sessionId);
          sendToClient(sessionId, { type: "stale" });
        } else {
          speak(sessionId, "fresh-speak");
          sendToClient(sessionId, { type: "fresh" });
        }
      },
    });

    capture.emit({
      type: "session_start",
      sessionId: "reuse-1",
      env: { SESSION_ID: "reuse-1" },
    });
    await vi.waitFor(() => expect(oldHandlerReached).toBe(true));

    capture.emit({ type: "session_end", sessionId: "reuse-1" });
    capture.emit({
      type: "session_start",
      sessionId: "reuse-1",
      env: { SESSION_ID: "reuse-1" },
    });

    await vi.waitFor(() => {
      expect(capture.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "speak",
          sessionId: "reuse-1",
          text: "fresh-speak",
        }),
      );
    });

    const sendsBeforeOld = capture.send.mock.calls.length;
    releaseOld();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const newCalls = capture.send.mock.calls.slice(sendsBeforeOld);
    expect(
      newCalls.some(
        (call) =>
          (call[0] as { type?: string; text?: string }).type === "speak" &&
          (call[0] as { text?: string }).text === "stale-speak",
      ),
    ).toBe(false);
    expect(
      newCalls.some(
        (call) => (call[0] as { type?: string }).type === "send_to_client",
      ),
    ).toBe(false);
    expect(
      newCalls.some(
        (call) =>
          (call[0] as { type?: string }).type === "send_binary_to_client",
      ),
    ).toBe(false);
    expect(
      newCalls.some(
        (call) => (call[0] as { type?: string }).type === "disconnect_client",
      ),
    ).toBe(false);
    expect(
      newCalls.some(
        (call) =>
          (call[0] as { type?: string; message?: string }).type === "log" &&
          (call[0] as { message?: string }).message === "stale-log",
      ),
    ).toBe(false);
  });
});
