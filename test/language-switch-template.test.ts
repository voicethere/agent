import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetAgentIpcStateForTests } from "../src/runtime.js";
import { installProcessMessageCapture } from "./helpers/process-mock.js";

type Capture = ReturnType<typeof installProcessMessageCapture>;

const SESSION = "ls-1";

type Sent = Record<string, unknown>;

async function startTemplate(
  env: Record<string, string>,
  voiceLanguageSwitch?: Record<string, unknown>,
): Promise<{
  capture: Capture;
  spoken: () => string[];
  speaks: () => Sent[];
  vlc: () => Sent[];
  prepares: () => Sent[];
  replays: () => Sent[];
  logs: () => Sent[];
}> {
  vi.resetModules();
  resetAgentIpcStateForTests();
  const capture = installProcessMessageCapture();
  await import("../templates/language-switch/agent.js");
  capture.emit({
    type: "session_start",
    sessionId: SESSION,
    env,
    ...(voiceLanguageSwitch ? { voiceLanguageSwitch } : {}),
  });
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
    prepares: () => sent().filter((m) => m.type === "voice_language_prepare"),
    replays: () => sent().filter((m) => m.type === "voice_replay_last"),
    logs: () => sent().filter((m) => m.type === "log"),
  };
}

function speech(capture: Capture, event: Record<string, unknown>): void {
  capture.emit({ type: "speech_event", sessionId: SESSION, event });
}

type T = Awaited<ReturnType<typeof startTemplate>>;

const SETTINGS = {
  waitMessageMode: "end_of_utterance",
  waitMessageSkipWhenReady: true,
  waitMessages: {},
  readyMessageMinMs: 2000,
  readyMessages: {},
};

function detect(t: T, language = "de"): void {
  speech(t.capture, { type: "user_language", text: language, language });
}

function final(t: T, text = "guten tag", extra: Sent = {}): void {
  speech(t.capture, { type: "user_speech_final", text, ...extra });
}

async function answerPrepare(
  t: T,
  result: { ok: boolean; ready: boolean; reason: string },
  n = 1,
): Promise<void> {
  await vi.waitFor(() => expect(t.prepares()).toHaveLength(n));
  const req = t.prepares()[n - 1]!;
  t.capture.emit({
    type: "voice_language_prepare_result",
    sessionId: SESSION,
    requestId: req.requestId,
    ...result,
  });
}

async function ackSwap(t: T, ok = true, n = 1): Promise<void> {
  await vi.waitFor(() => expect(t.vlc()).toHaveLength(n));
  const req = t.vlc()[n - 1]!;
  t.capture.emit({
    type: "voice_language_control_ack",
    sessionId: SESSION,
    requestId: req.requestId,
    ok,
    ...(ok ? { language: "de" } : { reason: "timeout" }),
  });
}

async function answerReplay(t: T, ok = true): Promise<void> {
  await vi.waitFor(() => expect(t.replays()).toHaveLength(1));
  t.capture.emit({
    type: "voice_replay_last_result",
    sessionId: SESSION,
    requestId: t.replays()[0]!.requestId,
    ok,
    reason: ok ? "replayed" : "nothing_to_replay",
  });
}

const logNames = (t: T): string[] => t.logs().map((l) => l.message as string);

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
    it("(a) ready and fast: swaps without a message, requests the replay, answers the replayed final in the new language", async () => {
      const t = await startTemplate({}, SETTINGS);
      capture = t.capture;
      vi.useFakeTimers({ toFake: ["Date"] });
      detect(t);
      await vi.waitFor(() => expect(t.prepares()).toHaveLength(1));
      expect(t.prepares()[0]!.options).toEqual({
        language: "de",
        scope: "both",
        voice: "de",
        stt: "de",
      });
      expect(t.spoken()).toEqual([]);
      await answerPrepare(t, { ok: true, ready: true, reason: "ready" });
      vi.setSystemTime(Date.now() + 500);
      final(t);
      await ackSwap(t);
      expect(t.vlc()[0]).toMatchObject({ scope: "both", language: "de" });
      await answerReplay(t);
      await vi.waitFor(() =>
        expect(logNames(t)).toContain("language_switch.committed"),
      );
      expect(t.spoken()).toEqual([]);
      final(t, "guten tag", { replay: true });
      await vi.waitFor(() =>
        expect(t.spoken()).toEqual(["Du hast gesagt: guten tag"]),
      );
      expect(logNames(t)).toEqual([
        "language_switch.session_start",
        "language_switch.detected",
        "language_switch.prepare",
        "language_switch.swap",
        "language_switch.ready_message",
        "language_switch.replay",
        "language_switch.committed",
      ]);
      const ready = t
        .logs()
        .find((l) => l.message === "language_switch.ready_message")!;
      expect(ready.fields).toMatchObject({ played: false, reason: "fast" });
    });

    it("(b) ready but slow: plays the ready message in the new voice before the replay", async () => {
      const t = await startTemplate({}, SETTINGS);
      capture = t.capture;
      vi.useFakeTimers({ toFake: ["Date"] });
      detect(t);
      await answerPrepare(t, { ok: true, ready: true, reason: "ready" });
      vi.setSystemTime(Date.now() + 2500);
      final(t);
      await ackSwap(t);
      await vi.waitFor(() =>
        expect(t.spoken()).toEqual(["Okay, machen wir auf Deutsch weiter."]),
      );
      expect(t.speaks()[0]!.interruptible).toBe(false);
      // The replay waits for the ready message to finish.
      expect(t.replays()).toHaveLength(0);
      speech(t.capture, { type: "agent_speaking_end" });
      await answerReplay(t);
      const ready = t
        .logs()
        .find((l) => l.message === "language_switch.ready_message")!;
      expect(ready.fields).toMatchObject({ played: true, to: "de" });
    });

    it("(c) not ready at the end of the utterance: wait message in the old voice, swap after prepare, no ready message", async () => {
      const t = await startTemplate({}, SETTINGS);
      capture = t.capture;
      detect(t);
      await vi.waitFor(() => expect(t.prepares()).toHaveLength(1));
      final(t);
      await vi.waitFor(() =>
        expect(t.spoken()).toEqual([
          "One moment please, I'm switching to your language.",
        ]),
      );
      expect("interruptible" in t.speaks()[0]!).toBe(false);
      expect(t.vlc()).toHaveLength(0);
      await answerPrepare(t, { ok: true, ready: true, reason: "ready" });
      await ackSwap(t);
      await answerReplay(t);
      await vi.waitFor(() =>
        expect(logNames(t)).toContain("language_switch.committed"),
      );
      expect(t.spoken()).toHaveLength(1);
      const ready = t
        .logs()
        .find((l) => l.message === "language_switch.ready_message")!;
      expect(ready.fields).toMatchObject({
        played: false,
        reason: "wait_message_played",
      });
    });

    it("(d) immediate mode: wait message at detection, not interruptible, nothing more at the end", async () => {
      const t = await startTemplate(
        {},
        { ...SETTINGS, waitMessageMode: "immediate" },
      );
      capture = t.capture;
      detect(t);
      await vi.waitFor(() => expect(t.spoken()).toHaveLength(1));
      expect(t.speaks()[0]!.interruptible).toBe(false);
      await answerPrepare(t, { ok: true, ready: true, reason: "ready" });
      final(t);
      await ackSwap(t);
      await answerReplay(t);
      await vi.waitFor(() =>
        expect(logNames(t)).toContain("language_switch.committed"),
      );
      expect(t.spoken()).toHaveLength(1);
      const wait = t
        .logs()
        .find((l) => l.message === "language_switch.wait_message")!;
      expect(wait.fields).toMatchObject({ played: true, reason: "immediate" });
    });

    it("(e) off mode and not ready: no message at all", async () => {
      const t = await startTemplate(
        {},
        { ...SETTINGS, waitMessageMode: "off" },
      );
      capture = t.capture;
      detect(t);
      await vi.waitFor(() => expect(t.prepares()).toHaveLength(1));
      final(t);
      await vi.waitFor(() =>
        expect(logNames(t)).toContain("language_switch.wait_message"),
      );
      expect(t.spoken()).toEqual([]);
      await answerPrepare(t, { ok: true, ready: true, reason: "ready" });
      await ackSwap(t);
      await answerReplay(t);
      await vi.waitFor(() =>
        expect(logNames(t)).toContain("language_switch.committed"),
      );
      expect(t.spoken().filter((x) => x.startsWith("One moment"))).toEqual([]);
    });

    it("(f) prepare fails: apologises in the old language and the language stays", async () => {
      const t = await startTemplate({}, SETTINGS);
      capture = t.capture;
      detect(t);
      await answerPrepare(t, {
        ok: false,
        ready: false,
        reason: "pool_failed",
      });
      final(t);
      await vi.waitFor(() =>
        expect(t.spoken()).toEqual([
          "Sorry, I couldn't switch languages. I'll keep going in English.",
        ]),
      );
      expect(t.vlc()).toHaveLength(0);
      expect(t.replays()).toHaveLength(0);
      const failed = t
        .logs()
        .find((l) => l.message === "language_switch.failed")!;
      expect(failed.fields).toMatchObject({
        step: "prepare",
        reason: "pool_failed",
      });
      // The next language event can start a new switch.
      detect(t);
      await vi.waitFor(() => expect(t.prepares()).toHaveLength(2));
    });

    it("(f2) prepare fails after the wait message: apology follows the wait message", async () => {
      const t = await startTemplate({}, SETTINGS);
      capture = t.capture;
      detect(t);
      await vi.waitFor(() => expect(t.prepares()).toHaveLength(1));
      final(t);
      await vi.waitFor(() => expect(t.spoken()).toHaveLength(1));
      await answerPrepare(t, { ok: false, ready: false, reason: "timeout" });
      await vi.waitFor(() => expect(t.spoken()).toHaveLength(2));
      expect(t.spoken()[1]).toContain("Sorry");
    });

    it("(g) replay fails: logs failed with step replay", async () => {
      const t = await startTemplate({}, SETTINGS);
      capture = t.capture;
      detect(t);
      await answerPrepare(t, { ok: true, ready: true, reason: "ready" });
      final(t);
      await ackSwap(t);
      await answerReplay(t, false);
      await vi.waitFor(() =>
        expect(logNames(t)).toContain("language_switch.failed"),
      );
      const failed = t
        .logs()
        .find((l) => l.message === "language_switch.failed")!;
      expect(failed.fields).toMatchObject({
        step: "replay",
        reason: "nothing_to_replay",
      });
      expect(logNames(t)).not.toContain("language_switch.committed");
    });

    it("(g2) swap fails: apologises and does not replay", async () => {
      const t = await startTemplate({}, SETTINGS);
      capture = t.capture;
      detect(t);
      await answerPrepare(t, { ok: true, ready: true, reason: "ready" });
      final(t);
      await ackSwap(t, false);
      await vi.waitFor(() => expect(t.spoken()).toHaveLength(1));
      expect(t.replays()).toHaveLength(0);
      const failed = t
        .logs()
        .find((l) => l.message === "language_switch.failed")!;
      expect(failed.fields).toMatchObject({ step: "swap", reason: "timeout" });
    });

    it("(h) older runner without settings: defaults are used", async () => {
      const t = await startTemplate({});
      capture = t.capture;
      detect(t);
      await vi.waitFor(() => expect(t.prepares()).toHaveLength(1));
      final(t);
      await vi.waitFor(() =>
        expect(t.spoken()).toEqual([
          "One moment please, I'm switching to your language.",
        ]),
      );
    });

    it("uses project texts from the session settings, and env overrides win", async () => {
      const t = await startTemplate(
        {},
        { ...SETTINGS, waitMessages: { en: "Hold the line." } },
      );
      capture = t.capture;
      detect(t);
      await vi.waitFor(() => expect(t.prepares()).toHaveLength(1));
      final(t);
      await vi.waitFor(() => expect(t.spoken()).toEqual(["Hold the line."]));
      capture.restore();
      const t2 = await startTemplate(
        {
          LANGUAGE_SWITCH_WAIT_MESSAGES_JSON: JSON.stringify({
            en: "Hold on.",
          }),
        },
        { ...SETTINGS, waitMessages: { en: "Hold the line." } },
      );
      capture = t2.capture;
      detect(t2);
      await vi.waitFor(() => expect(t2.prepares()).toHaveLength(1));
      final(t2);
      await vi.waitFor(() => expect(t2.spoken()).toEqual(["Hold on."]));
    });

    it("ready message falls back through settings, built-in text and an English template", async () => {
      const { readyMessageFor } =
        await import("../templates/language-switch/agent.js");
      expect(readyMessageFor("de", { de: "Weiter." })).toBe("Weiter.");
      expect(readyMessageFor("fr", undefined)).toBe(
        "D'accord, continuons en français.",
      );
      expect(readyMessageFor("ru", undefined)).toBe(
        "Okay, let's continue in Russian.",
      );
      expect(readyMessageFor("xx", undefined)).toBe(
        "Okay, let's continue in xx.",
      );
    });

    it("ignores a second language event while a switch is in flight", async () => {
      const t = await startTemplate({}, SETTINGS);
      capture = t.capture;
      detect(t, "de");
      await vi.waitFor(() => expect(t.prepares()).toHaveLength(1));
      detect(t, "fr");
      await new Promise((r) => setTimeout(r, 30));
      expect(t.prepares()).toHaveLength(1);
    });

    it("(i) log lines use language_switch.<decision> names and never contain the caller's text", async () => {
      const t = await startTemplate({}, SETTINGS);
      capture = t.capture;
      detect(t);
      await vi.waitFor(() => expect(t.prepares()).toHaveLength(1));
      final(t, "my secret phrase");
      await vi.waitFor(() => expect(t.spoken()).toHaveLength(1));
      await answerPrepare(t, { ok: true, ready: true, reason: "ready" });
      await ackSwap(t);
      await answerReplay(t);
      await vi.waitFor(() =>
        expect(logNames(t)).toContain("language_switch.committed"),
      );
      final(t, "my secret phrase", { replay: true });
      const switchLogs = t
        .logs()
        .filter((l) => String(l.message).startsWith("language_switch."));
      expect(switchLogs.map((l) => l.message)).toEqual([
        "language_switch.session_start",
        "language_switch.detected",
        "language_switch.wait_message",
        "language_switch.prepare",
        "language_switch.swap",
        "language_switch.ready_message",
        "language_switch.replay",
        "language_switch.committed",
      ]);
      expect(JSON.stringify(t.logs())).not.toContain("secret phrase");
    });

    it("clears the speech waiter on session end so no replay is requested", async () => {
      const t = await startTemplate({}, SETTINGS);
      capture = t.capture;
      vi.useFakeTimers({ toFake: ["Date"] });
      detect(t);
      await answerPrepare(t, { ok: true, ready: true, reason: "ready" });
      vi.setSystemTime(Date.now() + 2500);
      final(t);
      await ackSwap(t);
      await vi.waitFor(() => expect(t.spoken()).toHaveLength(1));
      t.capture.emit({ type: "session_end", sessionId: SESSION });
      await new Promise((r) => setTimeout(r, 30));
      expect(t.replays()).toHaveLength(0);
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
