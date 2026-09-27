import { afterEach, describe, expect, it, vi } from "vitest";

import { defineAgent, setVoiceLanguage } from "../src/runtime.js";
import { installProcessMessageCapture } from "./helpers/process-mock.js";

describe("setVoiceLanguage", () => {
  const childBundleEnv = process.env.__CHILD_BUNDLE_PATH__;

  afterEach(() => {
    if (childBundleEnv === undefined) {
      delete process.env.__CHILD_BUNDLE_PATH__;
    } else {
      process.env.__CHILD_BUNDLE_PATH__ = childBundleEnv;
    }
  });

  it("resolves local_mock when not a forked agent child", async () => {
    const result = await setVoiceLanguage("session-1", { language: "de" });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("local_mock");
  });

  it("sends voice_language_control and resolves on ack", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    defineAgent({});

    const ackPromise = setVoiceLanguage("session-1", {
      language: "de",
      voice: "de-thorsten-high",
      stt: "de",
    });
    await vi.waitFor(() => expect(capture.send).toHaveBeenCalled());
    const sent = capture.send.mock.calls[0]?.[0] as {
      type: string;
      requestId: string;
      sessionId: string;
      language: string;
      voice?: string;
      stt?: string;
    };
    expect(sent).toEqual(
      expect.objectContaining({
        type: "voice_language_control",
        sessionId: "session-1",
        language: "de",
        voice: "de-thorsten-high",
        stt: "de",
      }),
    );

    capture.emit({
      type: "voice_language_control_ack",
      requestId: sent.requestId,
      sessionId: "session-1",
      ok: true,
      reason: "applied",
      language: "de",
      voice: "de-thorsten-high",
      stt: "de",
    });
    await expect(ackPromise).resolves.toEqual({
      ok: true,
      reason: "applied",
      requestId: sent.requestId,
      language: "de",
      voice: "de-thorsten-high",
      stt: "de",
    });
    capture.restore();
  });

  it("sends a one-sided vendor change without a language", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    defineAgent({});

    const ackPromise = setVoiceLanguage("session-1", {
      scope: "stt",
      sttVendor: { provider: "deepgram", model: "nova-3", language: "de" },
    });
    await vi.waitFor(() => expect(capture.send).toHaveBeenCalled());
    const sent = capture.send.mock.calls[0]?.[0] as {
      type: string;
      requestId: string;
      scope?: string;
      language?: string;
      sttVendor?: { provider: string; model?: string; language?: string };
    };
    expect(sent).toEqual(
      expect.objectContaining({
        type: "voice_language_control",
        sessionId: "session-1",
        scope: "stt",
        sttVendor: { provider: "deepgram", model: "nova-3", language: "de" },
      }),
    );
    expect(sent.language).toBeUndefined();

    capture.emit({
      type: "voice_language_control_ack",
      requestId: sent.requestId,
      sessionId: "session-1",
      ok: true,
      reason: "applied",
      scope: "stt",
      stt: "nova-3",
      sttProvider: "deepgram",
      language: "de",
    });
    await expect(ackPromise).resolves.toMatchObject({
      ok: true,
      scope: "stt",
      sttProvider: "deepgram",
      stt: "nova-3",
    });
    capture.restore();
  });
});
