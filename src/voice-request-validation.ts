import { toWireProviderId } from "./voice-provider-id.js";

export type VoiceRequestValidation =
  { ok: true } | { ok: false; reason: string; message: string };

/** Texts for failures that older runtimes report as a bare `reason`. */
export const VOICE_SWITCH_MESSAGES: Readonly<Record<string, string>> = {
  invalid_scope: 'scope must be "stt", "tts" or "both".',
  nothing_to_apply: "Pass sttVendor, ttsVendor or language.",
  unknown_stt:
    'No VoiceThere STT model matches sttVendor.model or the language; use a catalog id such as "en" or "en-small".',
  unknown_voice:
    'No VoiceThere voice matches ttsVendor.voice or the language; use a catalog id such as "en-lessac".',
  invalid_language: 'language must be an ISO 639-1 code such as "en" or "de".',
  language_unavailable:
    "The models for this language did not start; try again later or pick another language.",
  unavailable: "Voice switching is not available for this session.",
  timeout: "The voice switch did not finish in time; try again.",
};

/** Local text for a reason, or `undefined` when the runtime builds the text. */
export function localVoiceSwitchMessage(
  reason: string | undefined,
): string | undefined {
  return reason !== undefined &&
    Object.prototype.hasOwnProperty.call(VOICE_SWITCH_MESSAGES, reason)
    ? VOICE_SWITCH_MESSAGES[reason]
    : undefined;
}

const INVALID_REQUEST =
  "setVoiceLanguage options must be an object; language, scope, voice and stt are strings; sttVendor and ttsVendor are objects.";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbsentOrString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function fail(reason: string, message: string): VoiceRequestValidation {
  return { ok: false, reason, message };
}

function vendorShapeOk(vendor: unknown): boolean {
  if (vendor === undefined) return true;
  if (!isPlainObject(vendor)) return false;
  return (
    isAbsentOrString(vendor.provider) &&
    isAbsentOrString(vendor.model) &&
    isAbsentOrString(vendor.voice) &&
    isAbsentOrString(vendor.language)
  );
}

/**
 * Checks a `setVoiceLanguage` / `prepareVoiceLanguage` request before it is
 * sent. The first failure wins. Provider ids are not checked here: the list of
 * supported providers belongs to the runtime. The SDK-only `timeoutMs` option
 * is ignored.
 */
export function validateVoiceRequest(options: unknown): VoiceRequestValidation {
  if (!isPlainObject(options)) return fail("invalid_request", INVALID_REQUEST);
  const { language, scope, voice, stt, sttVendor, ttsVendor } = options;

  // 1. shape
  if (
    !isAbsentOrString(language) ||
    !isAbsentOrString(scope) ||
    !isAbsentOrString(voice) ||
    !isAbsentOrString(stt) ||
    !vendorShapeOk(sttVendor) ||
    !vendorShapeOk(ttsVendor)
  ) {
    return fail("invalid_request", INVALID_REQUEST);
  }

  // 2. scope
  if (
    nonEmpty(scope) &&
    !["stt", "tts", "both"].includes((scope as string).trim())
  ) {
    return fail("invalid_scope", VOICE_SWITCH_MESSAGES.invalid_scope!);
  }

  const stv = sttVendor as Record<string, unknown> | undefined;
  const ttv = ttsVendor as Record<string, unknown> | undefined;

  // 3. provider required
  if (stv && !nonEmpty(stv.provider)) {
    return fail("missing_provider", "sttVendor.provider is required.");
  }
  if (ttv && !nonEmpty(ttv.provider)) {
    return fail("missing_provider", "ttsVendor.provider is required.");
  }

  // 4, 5. deprecated fields next to a vendor object
  if (nonEmpty(stt) && stv) {
    return fail(
      "conflicting_fields",
      "Pass the STT model as sttVendor.model, not stt, when sttVendor is set.",
    );
  }
  if (nonEmpty(voice) && ttv) {
    return fail(
      "conflicting_fields",
      "Pass the voice as ttsVendor.voice, not voice, when ttsVendor is set.",
    );
  }

  // 6. scope against vendor objects
  const effectiveScope = nonEmpty(scope) ? (scope as string).trim() : undefined;
  if (effectiveScope === "tts" && stv) {
    return fail(
      "scope_mismatch",
      'scope "tts" cannot change sttVendor; use scope "both" or drop sttVendor.',
    );
  }
  if (effectiveScope === "stt" && ttv) {
    return fail(
      "scope_mismatch",
      'scope "stt" cannot change ttsVendor; use scope "both" or drop ttsVendor.',
    );
  }

  // 7. STT has no voice
  if (stv && nonEmpty(stv.voice)) {
    return fail(
      "unsupported_field",
      "sttVendor has no voice field; set the voice with ttsVendor.voice.",
    );
  }

  // 10. language on a cloud TTS vendor
  if (
    ttv &&
    nonEmpty(ttv.language) &&
    toWireProviderId(ttv.provider as string) !== "local-sherpa"
  ) {
    return fail(
      "unsupported_field",
      'ttsVendor.language only applies to provider "voicethere"; choose a voice for that language with ttsVendor.voice.',
    );
  }

  // 11. nothing to do
  if (
    !nonEmpty(language) &&
    !nonEmpty(voice) &&
    !nonEmpty(stt) &&
    !stv &&
    !ttv
  ) {
    return fail("nothing_to_apply", VOICE_SWITCH_MESSAGES.nothing_to_apply!);
  }

  return { ok: true };
}
