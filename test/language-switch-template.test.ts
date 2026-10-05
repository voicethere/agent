import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetAgentIpcStateForTests } from "../src/runtime.js";
import { WAIT_SPEECH_TIMEOUT_MS } from "../templates/language-switch/agent.js";
import { installProcessMessageCapture } from "./helpers/process-mock.js";

type Capture = ReturnType<typeof installProcessMessageCapture>;

const SESSION = "ls-1";

async function startTemplate(env: Record<string, string>): Promise<{
  capture: Capture;
  spoken: () => string[];
  speaks: () => unknown[];
  vlc: () => unknown[];
}> {
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
    speaks: () => sent().filter((m) => m.type === "speak"),
    vlc: () => sent().filter((m) => m.type === "voice_language_control"),
  };
}

function speech(capture: Capture, event: Record<string, unknown>): void {
  capture.emit({ type: "speech_event", sessionId: SESSION, event });
}

/** Emit user_language and finish the wait message so the switch starts. */
async function detectAndFinishWait(
  t: { capture: Capture; spoken: () => string[] },
  language: string,
): Promise<void> {
  const before = t.spoken().length;
  speech(t.capture, { type: "user_language", text: language, language });
  await vi.waitFor(() => expect(t.spoken().length).toBe(before + 1));
  speech(t.capture, { type: "agent_speaking_end" });
}

describe("language-switch message helpers", () => {
  it("picks override, then default, then English", async () => {
    const { WAIT_MESSAGES, pickMessage } =
      await import("../templates/language-switch/agent.js");
    expect(pickMessage(WAIT_MESSAGES, {}, "de")).toBe(WAIT_MESSAGES.de);
    expect(pickMessage(WAIT_MESSAGES, { de: "X" }, "de")).toBe("X");
    expect(pickMessage(WAIT_MESSAGES, {}, "xx")).toBe(WAIT_MESSAGES.en);
    expect(pickMessage(WAIT_MESSAGES, { en: "Y" }, "xx")).toBe("Y");
  });

  it("parses env overrides and ignores invalid input", async () => {
    const { parseMessageOverrides } =
      await import("../templates/language-switch/agent.js");
    expect(parseMessageOverrides(undefined)).toEqual({});
    expect(parseMessageOverrides("not json")).toEqual({});
    expect(parseMessageOverrides("[1]")).toEqual({});
    expect(parseMessageOverrides('{"DE":" Hallo ","fr":3,"es":""}')).toEqual({
      de: "Hallo",
    });
  });
});

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
    it("speaks the wait message in the old language, switches, then replies in the new language, and drops the switch utterance transcript", async () => {
      const t = await startTemplate({});
      capture = t.capture;
      speech(t.capture, { type: "user_language", text: "de", language: "de" });
      await vi.waitFor(() => expect(t.spoken()).toHaveLength(1));
      expect(t.vlc()).toEqual([]);
      speech(t.capture, { type: "agent_speaking_end" });
      await vi.waitFor(() => expect(t.vlc()).toHaveLength(1));
      expect(t.spoken()).toEqual([
        "One moment please, I'm switching to your language.",
      ]);
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
          "One moment please, I'm switching to your language.",
          "Guten Tag. Ich antworte jetzt auf Deutsch.",
        ]),
      );
      // Only the wait message is protected from barge-in.
      const speaks = t.speaks() as Array<Record<string, unknown>>;
      expect(speaks[0]!.interruptible).toBe(false);
      expect("interruptible" in speaks[1]!).toBe(false);
      // The utterance that revealed the language is not echoed back.
      speech(t.capture, { type: "user_speech_final", text: "guten tag" });
      await new Promise((r) => setTimeout(r, 50));
      expect(t.spoken()).toHaveLength(2);
    });

    it("waits in the language being left on the second switch", async () => {
      const t = await startTemplate({});
      capture = t.capture;
      const ack = async (n: number, language: string) => {
        await vi.waitFor(() => expect(t.vlc()).toHaveLength(n));
        const m = t.vlc()[n - 1] as { requestId: string };
        t.capture.emit({
          type: "voice_language_control_ack",
          sessionId: SESSION,
          requestId: m.requestId,
          ok: true,
          language,
        });
      };
      await detectAndFinishWait(t, "de");
      await ack(1, "de");
      await ack(2, "de");
      await vi.waitFor(() => expect(t.spoken()).toHaveLength(2));
      await detectAndFinishWait(t, "fr");
      expect(t.spoken()[2]).toBe(
        "Einen Moment bitte, ich wechsle zu Ihrer Sprache.",
      );
    });

    it("uses the env override for the wait message", async () => {
      const t = await startTemplate({
        LANGUAGE_SWITCH_WAIT_MESSAGES_JSON: JSON.stringify({ en: "Hold on." }),
      });
      capture = t.capture;
      speech(t.capture, { type: "user_language", text: "de", language: "de" });
      await vi.waitFor(() => expect(t.spoken()).toEqual(["Hold on."]));
    });

    it("speaks a fallback in the old language and stays when the switch fails", async () => {
      const t = await startTemplate({});
      capture = t.capture;
      await detectAndFinishWait(t, "de");
      await vi.waitFor(() => expect(t.vlc()).toHaveLength(1));
      const first = t.vlc()[0] as { requestId: string };
      t.capture.emit({
        type: "voice_language_control_ack",
        sessionId: SESSION,
        requestId: first.requestId,
        ok: false,
        reason: "timeout",
      });
      await vi.waitFor(() => expect(t.vlc()).toHaveLength(2));
      const second = t.vlc()[1] as { requestId: string };
      t.capture.emit({
        type: "voice_language_control_ack",
        sessionId: SESSION,
        requestId: second.requestId,
        ok: false,
        reason: "timeout",
      });
      await vi.waitFor(() =>
        expect(t.spoken()).toEqual([
          "One moment please, I'm switching to your language.",
          "Sorry, I couldn't switch languages. I'll keep going in English.",
        ]),
      );
    });

    it("does not request the switch before agent_speaking_end, and ignores a second language event while waiting", async () => {
      const t = await startTemplate({});
      capture = t.capture;
      speech(t.capture, { type: "user_language", text: "de", language: "de" });
      await vi.waitFor(() => expect(t.spoken()).toHaveLength(1));
      speech(t.capture, { type: "user_language", text: "fr", language: "fr" });
      await new Promise((r) => setTimeout(r, 50));
      expect(t.vlc()).toEqual([]);
      expect(t.spoken()).toHaveLength(1);
      speech(t.capture, { type: "agent_speaking_end" });
      await vi.waitFor(() => expect(t.vlc()).toHaveLength(1));
      expect((t.vlc()[0] as { language: string }).language).toBe("de");
    });

    it("switches after the timeout bound when agent_speaking_end never arrives", async () => {
      const t = await startTemplate({});
      capture = t.capture;
      vi.useFakeTimers();
      speech(t.capture, { type: "user_language", text: "de", language: "de" });
      await vi.advanceTimersByTimeAsync(WAIT_SPEECH_TIMEOUT_MS - 1);
      expect(t.vlc()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.vlc()).toHaveLength(1);
    });

    it("clears the waiter on session end so no switch is requested", async () => {
      const t = await startTemplate({});
      capture = t.capture;
      vi.useFakeTimers();
      speech(t.capture, { type: "user_language", text: "de", language: "de" });
      await vi.advanceTimersByTimeAsync(10);
      expect(t.spoken()).toHaveLength(1);
      t.capture.emit({ type: "session_end", sessionId: SESSION });
      await vi.advanceTimersByTimeAsync(WAIT_SPEECH_TIMEOUT_MS + 1000);
      expect(t.vlc()).toEqual([]);
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
