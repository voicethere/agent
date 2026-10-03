import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetAgentIpcStateForTests } from "../src/runtime.js";
import { installProcessMessageCapture } from "./helpers/process-mock.js";

type Capture = ReturnType<typeof installProcessMessageCapture>;

const SESSION = "ls-1";

async function startTemplate(
  env: Record<string, string>,
): Promise<{ capture: Capture; spoken: () => string[]; vlc: () => unknown[] }> {
  vi.resetModules();
  resetAgentIpcStateForTests();
  const capture = installProcessMessageCapture();
  await import("../templates/language-switch/agent.js");
  capture.emit({ type: "session_start", sessionId: SESSION, env });
  await vi.waitFor(() =>
    expect(capture.send.mock.calls.map((c) => c[0].type)).toContain(
      "session_start_ack",
    ),
  );
  const sent = () => capture.send.mock.calls.map((c) => c[0]);
  return {
    capture,
    spoken: () =>
      sent()
        .filter((m) => m.type === "speak")
        .map((m) => m.text as string),
    vlc: () => sent().filter((m) => m.type === "voice_language_control"),
  };
}

function speech(capture: Capture, event: Record<string, unknown>): void {
  capture.emit({ type: "speech_event", sessionId: SESSION, event });
}

describe("language-switch template", () => {
  let capture: Capture | undefined;

  const childBundleEnv = process.env.__CHILD_BUNDLE_PATH__;

  beforeEach(() => {
    // setVoiceLanguage only talks to the runner from a forked agent child.
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
  });

  afterEach(() => {
    if (childBundleEnv === undefined) delete process.env.__CHILD_BUNDLE_PATH__;
    else process.env.__CHILD_BUNDLE_PATH__ = childBundleEnv;
    vi.useRealTimers();
    capture?.restore();
    capture = undefined;
    resetAgentIpcStateForTests();
  });

  describe("runner auto-switch", () => {
    it("echoes English text immediately with the English prefix", async () => {
      const t = await startTemplate({ SHERPA_LID_AUTO_SWITCH: "1" });
      capture = t.capture;
      speech(t.capture, { type: "user_speech_final", text: "hello there" });
      await vi.waitFor(() =>
        expect(t.spoken()).toEqual(["you said: hello there"]),
      );
      expect(t.vlc()).toEqual([]);
    });

    it("answers the German final in German after user_language de, without setVoiceLanguage or a fixed sentence", async () => {
      const t = await startTemplate({ SHERPA_LID_AUTO_SWITCH: "true" });
      capture = t.capture;
      speech(t.capture, { type: "user_language", text: "de", language: "de" });
      await new Promise((r) => setTimeout(r, 20));
      expect(t.spoken()).toEqual([]);
      speech(t.capture, {
        type: "user_speech_final",
        text: "guten Tag wie geht es dir",
      });
      await vi.waitFor(() =>
        expect(t.spoken()).toEqual([
          "Du hast gesagt: guten Tag wie geht es dir",
        ]),
      );
      expect(t.vlc()).toEqual([]);
    });

    it("uses the committed language from voice_language_changed", async () => {
      const t = await startTemplate({ SHERPA_LID_AUTO_SWITCH: "1" });
      capture = t.capture;
      speech(t.capture, {
        type: "voice_language_changed",
        text: "de",
        language: "de",
      });
      await new Promise((r) => setTimeout(r, 20));
      speech(t.capture, { type: "user_speech_final", text: "Hallo" });
      await vi.waitFor(() =>
        expect(t.spoken()).toEqual(["Du hast gesagt: Hallo"]),
      );
    });
  });

  describe("manual mode", () => {
    it("switches TTS and STT itself, speaks the fixed reply, and drops the switch utterance transcript", async () => {
      const t = await startTemplate({});
      capture = t.capture;
      speech(t.capture, { type: "user_language", text: "de", language: "de" });
      await vi.waitFor(() => expect(t.vlc()).toHaveLength(1));
      const first = t.vlc()[0] as { requestId: string; scope: string };
      expect(first.scope).toBe("tts");
      t.capture.emit({
        type: "voice_language_control_ack",
        sessionId: SESSION,
        requestId: first.requestId,
        ok: true,
        language: "de",
      });
      await vi.waitFor(() => expect(t.vlc()).toHaveLength(2));
      const second = t.vlc()[1] as { requestId: string; scope: string };
      expect(second.scope).toBe("stt");
      t.capture.emit({
        type: "voice_language_control_ack",
        sessionId: SESSION,
        requestId: second.requestId,
        ok: true,
        language: "de",
      });
      await vi.waitFor(() =>
        expect(t.spoken()).toEqual([
          "Guten Tag. Ich antworte jetzt auf Deutsch.",
        ]),
      );
      // The utterance that revealed the language is not echoed back.
      speech(t.capture, { type: "user_speech_final", text: "guten tag" });
      await new Promise((r) => setTimeout(r, 50));
      expect(t.spoken()).toHaveLength(1);
    });

    it("keeps the delayed English echo", async () => {
      const t = await startTemplate({});
      capture = t.capture;
      vi.useFakeTimers();
      speech(t.capture, { type: "user_speech_final", text: "hello" });
      await vi.advanceTimersByTimeAsync(10);
      expect(t.spoken()).toEqual([]);
      await vi.advanceTimersByTimeAsync(4000);
      expect(t.spoken()).toEqual(["you said: hello"]);
    });
  });
});
