import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defineAgent,
  prepareVoiceLanguage,
  resetAgentIpcStateForTests,
  setVoiceLanguage,
  type SetVoiceLanguageOptions,
} from "../src/runtime.js";
import {
  toPublicProviderId,
  toWireProviderId,
} from "../src/voice-provider-id.js";
import { installProcessMessageCapture } from "./helpers/process-mock.js";

type Capture = ReturnType<typeof installProcessMessageCapture>;
type Sent = Record<string, unknown> & { requestId: string };

const childBundleEnv = process.env.__CHILD_BUNDLE_PATH__;
let capture: Capture | undefined;

function setup(): Capture {
  process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
  capture = installProcessMessageCapture();
  defineAgent({});
  return capture;
}

async function lastSent(c: Capture): Promise<Sent> {
  await vi.waitFor(() => expect(c.send).toHaveBeenCalled());
  return c.send.mock.calls[0]![0] as Sent;
}

afterEach(() => {
  capture?.restore();
  capture = undefined;
  resetAgentIpcStateForTests();
  if (childBundleEnv === undefined) delete process.env.__CHILD_BUNDLE_PATH__;
  else process.env.__CHILD_BUNDLE_PATH__ = childBundleEnv;
});

async function ackWith(
  options: SetVoiceLanguageOptions,
  ack: Record<string, unknown>,
) {
  const c = setup();
  const promise = setVoiceLanguage("s1", options);
  const sent = await lastSent(c);
  c.emit({
    type: "voice_language_control_ack",
    requestId: sent.requestId,
    sessionId: "s1",
    ...ack,
  });
  return promise;
}

describe("provider id translation", () => {
  it("maps ids both ways", () => {
    expect(toWireProviderId(" VoiceThere ")).toBe("local-sherpa");
    expect(toWireProviderId("cluster-sherpa")).toBe("local-sherpa");
    expect(toWireProviderId(" Deepgram ")).toBe("Deepgram");
    expect(toPublicProviderId("local-sherpa")).toBe("voicethere");
    expect(toPublicProviderId("cluster-sherpa")).toBe("voicethere");
    expect(toPublicProviderId("deepgram")).toBe("deepgram");
  });

  it.each(["voicethere", "VoiceThere", "cluster-sherpa", "local-sherpa"])(
    "voicethere provider goes on the wire as local-sherpa (%s)",
    async (provider) => {
      const c = setup();
      void setVoiceLanguage("s1", {
        scope: "both",
        language: "de",
        sttVendor: { provider, language: "de" },
        ttsVendor: { provider, language: "de" },
      });
      const sent = await lastSent(c);
      expect(sent.sttVendor).toEqual({
        provider: "local-sherpa",
        language: "de",
      });
      expect(sent.ttsVendor).toEqual({
        provider: "local-sherpa",
        language: "de",
      });
    },
  );

  it("ack sttProvider/ttsProvider local-sherpa and cluster-sherpa come back as voicethere", async () => {
    const result = await ackWith(
      { language: "de" },
      {
        ok: true,
        reason: "applied",
        sttProvider: "cluster-sherpa",
        ttsProvider: "local-sherpa",
      },
    );
    expect(result).toMatchObject({
      sttProvider: "voicethere",
      ttsProvider: "voicethere",
    });
  });

  it("a cloud provider in the ack is unchanged", async () => {
    const result = await ackWith(
      { language: "de" },
      { ok: true, sttProvider: "deepgram", ttsProvider: "elevenlabs" },
    );
    expect(result).toMatchObject({
      sttProvider: "deepgram",
      ttsProvider: "elevenlabs",
    });
  });
});

describe("message on results", () => {
  it("runner message is passed through on a failed ack", async () => {
    const result = await ackWith(
      { language: "de" },
      { ok: false, reason: "unknown_vendor", message: 'Unknown provider "x".' },
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "unknown_vendor",
      message: 'Unknown provider "x".',
    });
  });

  it("older runtime ack without message gets the local message for unknown_stt", async () => {
    const result = await ackWith(
      { language: "de" },
      { ok: false, reason: "unknown_stt" },
    );
    expect(result.message).toBe(
      'No VoiceThere STT model matches sttVendor.model or the language; use a catalog id such as "en" or "en-small".',
    );
  });

  it("missing_credentials without message stays without message", async () => {
    const result = await ackWith(
      { language: "de" },
      { ok: false, reason: "missing_credentials" },
    );
    expect(result.message).toBeUndefined();
    expect("message" in result).toBe(false);
  });

  it("the SDK timeout result carries the timeout message", async () => {
    setup();
    const result = await setVoiceLanguage("s1", {
      language: "de",
      timeoutMs: 5,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "timeout",
      message: "The voice switch did not finish in time; try again.",
    });
  });
});

const INVALID =
  "setVoiceLanguage options must be an object; language, scope, voice and stt are strings; sttVendor and ttsVendor are objects.";

const cases: Array<[string, unknown, string, string]> = [
  ["1 options not an object", "de", "invalid_request", INVALID],
  ["1 language not a string", { language: 5 }, "invalid_request", INVALID],
  [
    "1 sttVendor not an object",
    { sttVendor: "deepgram" },
    "invalid_request",
    INVALID,
  ],
  [
    "1 vendor model not a string",
    { ttsVendor: { provider: "openai", model: 1 } },
    "invalid_request",
    INVALID,
  ],
  [
    "2 scope",
    { scope: "all", language: "de" },
    "invalid_scope",
    'scope must be "stt", "tts" or "both".',
  ],
  [
    "3 stt provider",
    { sttVendor: { model: "nova-3" } },
    "missing_provider",
    "sttVendor.provider is required.",
  ],
  [
    "3 tts provider",
    { ttsVendor: { provider: "  " } },
    "missing_provider",
    "ttsVendor.provider is required.",
  ],
  [
    "4 stt + sttVendor",
    { stt: "en", sttVendor: { provider: "voicethere" } },
    "conflicting_fields",
    "Pass the STT model as sttVendor.model, not stt, when sttVendor is set.",
  ],
  [
    "5 voice + ttsVendor",
    { voice: "en-lessac", ttsVendor: { provider: "voicethere" } },
    "conflicting_fields",
    "Pass the voice as ttsVendor.voice, not voice, when ttsVendor is set.",
  ],
  [
    "6 tts scope with sttVendor",
    { scope: "tts", sttVendor: { provider: "deepgram" } },
    "scope_mismatch",
    'scope "tts" cannot change sttVendor; use scope "both" or drop sttVendor.',
  ],
  [
    "6 stt scope with ttsVendor",
    { scope: "stt", ttsVendor: { provider: "openai" } },
    "scope_mismatch",
    'scope "stt" cannot change ttsVendor; use scope "both" or drop ttsVendor.',
  ],
  [
    "7 sttVendor.voice",
    { sttVendor: { provider: "deepgram", voice: "x" } },
    "unsupported_field",
    "sttVendor has no voice field; set the voice with ttsVendor.voice.",
  ],
  [
    "10 ttsVendor.language on a cloud provider",
    { ttsVendor: { provider: "openai", language: "de" } },
    "unsupported_field",
    'ttsVendor.language only applies to provider "voicethere"; choose a voice for that language with ttsVendor.voice.',
  ],
  [
    "11 nothing to apply",
    {},
    "nothing_to_apply",
    "Pass sttVendor, ttsVendor or language.",
  ],
];

describe("local request validation", () => {
  it.each(cases)("%s", async (_name, options, reason, message) => {
    const c = setup();
    const result = await setVoiceLanguage("s1", options as never);
    expect(result).toMatchObject({ ok: false, reason, message });
    expect(result.requestId).toBeTruthy();
    expect(c.send).not.toHaveBeenCalled();
  });

  it("validates before the local_mock short-circuit", async () => {
    const result = await setVoiceLanguage("s1", {});
    expect(result.reason).toBe("nothing_to_apply");
  });

  it("a valid uniform request is sent", async () => {
    const c = setup();
    void setVoiceLanguage("s1", {
      scope: "both",
      language: "de",
      sttVendor: { provider: "voicethere", language: "de" },
      ttsVendor: { provider: "voicethere", language: "de" },
    });
    const sent = await lastSent(c);
    expect(sent).toMatchObject({
      type: "voice_language_control",
      scope: "both",
      language: "de",
    });
  });

  it("voicethere ttsVendor.language is allowed", async () => {
    const c = setup();
    void setVoiceLanguage("s1", {
      ttsVendor: { provider: "voicethere", language: "de" },
    });
    await lastSent(c);
    expect(c.send).toHaveBeenCalledTimes(1);
  });

  it("deprecated stt alone is still sent with stt", async () => {
    const c = setup();
    void setVoiceLanguage("s1", { stt: "en" });
    const sent = await lastSent(c);
    expect(sent).toMatchObject({ type: "voice_language_control", stt: "en" });
    expect(sent.sttVendor).toBeUndefined();
  });
});

describe("prepareVoiceLanguage", () => {
  it("fails validation without sending", async () => {
    const c = setup();
    const result = await prepareVoiceLanguage("s1", {
      scope: "stt",
      ttsVendor: { provider: "openai" },
    });
    expect(result).toEqual({
      ok: false,
      ready: false,
      reason: "scope_mismatch",
      message:
        'scope "stt" cannot change ttsVendor; use scope "both" or drop ttsVendor.',
    });
    expect(c.send).not.toHaveBeenCalled();
  });

  it("maps voicethere to local-sherpa and passes the message through", async () => {
    const c = setup();
    const promise = prepareVoiceLanguage("s1", {
      language: "de",
      sttVendor: { provider: "voicethere" },
    });
    const sent = await lastSent(c);
    expect(sent).toMatchObject({
      type: "voice_language_prepare",
      options: { language: "de", sttVendor: { provider: "local-sherpa" } },
    });
    c.emit({
      type: "voice_language_prepare_result",
      sessionId: "s1",
      requestId: sent.requestId,
      ok: false,
      ready: false,
      reason: "unknown_stt",
    });
    await expect(promise).resolves.toMatchObject({
      reason: "unknown_stt",
      message: expect.stringContaining("No VoiceThere STT model"),
    });
  });
});
