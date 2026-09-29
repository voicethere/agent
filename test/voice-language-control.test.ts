import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defineAgent,
  getVoiceLanguage,
  isRunnerLidAutoSwitchEnabled,
  isVoiceLanguageSwitchAvailable,
  resetAgentIpcStateForTests,
  setVoiceLanguage,
} from "../src/runtime.js";
import { installProcessMessageCapture } from "./helpers/process-mock.js";

describe("setVoiceLanguage", () => {
  const childBundleEnv = process.env.__CHILD_BUNDLE_PATH__;

  afterEach(() => {
    resetAgentIpcStateForTests();
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

describe("voice language session helpers", () => {
  afterEach(() => {
    resetAgentIpcStateForTests();
  });

  it("caches voiceLanguageSwitchAvailable on session_start", async () => {
    const capture = installProcessMessageCapture();
    const onSessionStart = vi.fn();
    defineAgent({ onSessionStart });

    capture.emit({
      type: "session_start",
      sessionId: "peer-1",
      env: { SESSION_ID: "peer-1" },
      voiceLanguageSwitchAvailable: true,
    });
    await vi.waitFor(() => expect(onSessionStart).toHaveBeenCalled());
    expect(
      isVoiceLanguageSwitchAvailable(onSessionStart.mock.calls[0][0]),
    ).toBe(true);

    capture.emit({
      type: "session_start",
      sessionId: "peer-2",
      env: { SESSION_ID: "peer-2" },
    });
    await vi.waitFor(() => expect(onSessionStart).toHaveBeenCalledTimes(2));
    expect(
      isVoiceLanguageSwitchAvailable(onSessionStart.mock.calls[1][0]),
    ).toBe(false);
    capture.restore();
  });

  it("getVoiceLanguage returns language from setVoiceLanguage ack", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    defineAgent({});

    const ackPromise = setVoiceLanguage("session-1", { language: "fr" });
    await vi.waitFor(() => expect(capture.send).toHaveBeenCalled());
    const sent = capture.send.mock.calls[0]?.[0] as { requestId: string };
    capture.emit({
      type: "voice_language_control_ack",
      requestId: sent.requestId,
      sessionId: "session-1",
      ok: true,
      reason: "applied",
      language: "fr",
    });
    await ackPromise;
    expect(getVoiceLanguage("session-1")).toBe("fr");
    capture.restore();
    delete process.env.__CHILD_BUNDLE_PATH__;
  });

  it("dispatches onVoiceLanguageChanged from voice_language_changed speech_event", async () => {
    const capture = installProcessMessageCapture();
    const onVoiceLanguageChanged = vi.fn();
    defineAgent({ onVoiceLanguageChanged });

    capture.emit({
      type: "speech_event",
      sessionId: "peer-1",
      event: { type: "voice_language_changed", language: "de" },
    });
    await vi.waitFor(() => expect(onVoiceLanguageChanged).toHaveBeenCalled());
    expect(onVoiceLanguageChanged).toHaveBeenCalledWith({
      sessionId: "peer-1",
      language: "de",
    });
    expect(getVoiceLanguage("peer-1")).toBe("de");
    capture.restore();
  });

  it("isRunnerLidAutoSwitchEnabled parses truthy env values", () => {
    expect(isRunnerLidAutoSwitchEnabled({})).toBe(false);
    expect(isRunnerLidAutoSwitchEnabled({ SHERPA_LID_AUTO_SWITCH: "1" })).toBe(
      true,
    );
    expect(
      isRunnerLidAutoSwitchEnabled({ SHERPA_LID_AUTO_SWITCH: "true" }),
    ).toBe(true);
    expect(isRunnerLidAutoSwitchEnabled({ SHERPA_LID_AUTO_SWITCH: "0" })).toBe(
      false,
    );
  });
});
