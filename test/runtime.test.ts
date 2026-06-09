import { afterEach, describe, expect, it, vi } from "vitest";

import { defineAgent } from "../src/runtime.js";

type ProcessMessageListener = (message: unknown) => void;

function installProcessMessageCapture(): {
  emit: (message: unknown) => void;
  restore: () => void;
} {
  const listeners = new Set<ProcessMessageListener>();
  const originalOn = process.on.bind(process);
  const spy = vi.spyOn(process, "on").mockImplementation(((
    event: string | symbol,
    listener: ProcessMessageListener,
  ) => {
    if (event === "message") {
      listeners.add(listener);
      return process;
    }
    return originalOn(event, listener);
  }) as typeof process.on);

  return {
    emit: (message) => {
      for (const listener of listeners) {
        listener(message);
      }
    },
    restore: () => {
      spy.mockRestore();
      listeners.clear();
    },
  };
}

describe("defineAgent", () => {
  let capture: ReturnType<typeof installProcessMessageCapture>;

  afterEach(() => {
    capture?.restore();
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
});
