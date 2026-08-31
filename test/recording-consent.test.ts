import { describe, expect, it } from "vitest";

import {
  beginSession,
  BIRTHDATE_PROMPT,
  CONSENT_PROMPT,
  createInitialState,
  extractBirthdate,
  extractName,
  handleUtterance,
  isConsentNo,
  isConsentYes,
  NAME_PROMPT,
  RECORDING_DISABLED_SKIP_MESSAGE,
} from "../templates/recording-consent/conversation.js";

describe("recording-consent conversation", () => {
  it("starts with consent prompt when recording is available", () => {
    const state = createInitialState(true);
    expect(state.phase).toBe("awaitingConsent");
    const begin = beginSession(true);
    expect(begin.speakLines[0]).toBe(CONSENT_PROMPT);
    expect(begin.recordingAction).toBeNull();
    expect(begin.warnRecordingDisabled).toBeUndefined();
  });

  it("skips consent and warns when recording is not available", () => {
    const state = createInitialState(false);
    expect(state.phase).toBe("awaitingName");
    expect(state.consentSkipped).toBe(true);
    const begin = beginSession(false);
    expect(begin.warnRecordingDisabled).toBe(true);
    expect(begin.speakLines).toContain(RECORDING_DISABLED_SKIP_MESSAGE);
    expect(begin.speakLines).toContain(NAME_PROMPT);
    expect(begin.recordingAction).toBeNull();
  });

  it("consent yes pauses recording then asks PII and resumes after name and birthdate", () => {
    let state = createInitialState(true);
    const yes = handleUtterance(state, "yes");
    expect(yes.state.consent).toBe(true);
    expect(yes.recordingAction).toBe("pause");
    expect(yes.speakLines[0]).toBe(NAME_PROMPT);
    state = yes.state;

    const name = handleUtterance(state, "my name is Ada");
    expect(name.state.name).toBe("Ada");
    expect(name.state.phase).toBe("awaitingBirthdate");
    expect(name.recordingAction).toBeNull();
    expect(name.speakLines[0]).toBe(BIRTHDATE_PROMPT);
    state = name.state;

    const done = handleUtterance(state, "1990-05-15");
    expect(done.state.phase).toBe("complete");
    expect(done.state.birthdate).toBe("1990-05-15");
    expect(done.recordingAction).toBe("resume");
  });

  it("consent no stops recording and never starts after PII", () => {
    let state = createInitialState(true);
    const no = handleUtterance(state, "no");
    expect(no.state.consent).toBe(false);
    expect(no.recordingAction).toBe("stop");
    state = no.state;

    state = handleUtterance(state, "Sam").state;
    const done = handleUtterance(state, "01/15/1985");
    expect(done.recordingAction).toBeNull();
    expect(done.state.phase).toBe("complete");
  });

  it.each(["not okay", "not ok"])(
    "treats %s as consent decline with stop recording",
    (utterance) => {
      const state = createInitialState(true);
      const result = handleUtterance(state, utterance);
      expect(result.state.consent).toBe(false);
      expect(result.recordingAction).toBe("stop");
      expect(isConsentNo(utterance)).toBe(true);
      expect(isConsentYes(utterance)).toBe(false);
    },
  );

  it("recording unavailable never emits start or resume after PII", () => {
    let state = createInitialState(false);
    state = handleUtterance(state, "Alex").state;
    const done = handleUtterance(state, "March 3, 1992");
    expect(done.recordingAction).toBeNull();
    expect(done.state.consentSkipped).toBe(true);
  });

  it("parses consent answers", () => {
    expect(isConsentYes("yes")).toBe(true);
    expect(isConsentYes("yeah sure")).toBe(true);
    expect(isConsentYes("not okay")).toBe(false);
    expect(isConsentYes("not ok")).toBe(false);
    expect(isConsentNo("no")).toBe(true);
    expect(isConsentNo("nope")).toBe(true);
    expect(isConsentNo("not okay")).toBe(true);
    expect(isConsentNo("not ok")).toBe(true);
    expect(isConsentNo("I want to know more")).toBe(false);
  });

  it("extracts name and birthdate", () => {
    expect(extractName("my name is Ada")).toBe("Ada");
    expect(extractBirthdate("1990-05-15")).toBe("1990-05-15");
    expect(extractBirthdate("01/15/1985")).toBe("01/15/1985");
  });
});
