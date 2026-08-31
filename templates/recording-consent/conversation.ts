/**
 * Pure conversation state machine for the recording-consent template.
 * Tests import this module directly — no defineAgent dependency.
 */

export const CONSENT_PROMPT =
  "This call may be recorded for quality purposes. Is that OK?";

export const NAME_PROMPT = "May I have your name please?";

export const BIRTHDATE_PROMPT = "And your date of birth?";

export const RECORDING_DISABLED_SKIP_MESSAGE =
  "Conversation recording is not enabled for this project.";

export type ConversationPhase =
  "awaitingConsent" | "awaitingName" | "awaitingBirthdate" | "complete";

export type RecordingAction = "pause" | "stop" | "start" | "resume" | null;

export interface ConversationState {
  phase: ConversationPhase;
  recordingAvailable: boolean;
  consent?: boolean;
  /** True when consent was skipped because project recording is off. */
  consentSkipped: boolean;
  name?: string;
  birthdate?: string;
}

export interface OutboundMessage {
  type: "chat_reply" | "agent_event";
  text?: string;
  event?: string;
  sessionId?: string;
}

export interface ConversationTurnResult {
  state: ConversationState;
  speakLines: string[];
  messages: OutboundMessage[];
  recordingAction: RecordingAction;
  /** When true, agent should warn that project recording is disabled. */
  warnRecordingDisabled?: boolean;
}

export function createInitialState(
  recordingAvailable: boolean,
): ConversationState {
  if (recordingAvailable) {
    return {
      phase: "awaitingConsent",
      recordingAvailable,
      consentSkipped: false,
    };
  }
  return {
    phase: "awaitingName",
    recordingAvailable,
    consentSkipped: true,
  };
}

function speakAndChat(text: string): {
  speakLines: string[];
  messages: OutboundMessage[];
} {
  return {
    speakLines: [text],
    messages: [{ type: "chat_reply", text }],
  };
}

export function beginSession(
  recordingAvailable: boolean,
): ConversationTurnResult {
  const state = createInitialState(recordingAvailable);
  if (recordingAvailable) {
    const prompt = speakAndChat(CONSENT_PROMPT);
    return {
      state,
      speakLines: prompt.speakLines,
      messages: prompt.messages,
      recordingAction: null,
    };
  }
  const skip = speakAndChat(RECORDING_DISABLED_SKIP_MESSAGE);
  const name = speakAndChat(NAME_PROMPT);
  return {
    state,
    speakLines: [...skip.speakLines, ...name.speakLines],
    messages: [...skip.messages, ...name.messages],
    recordingAction: null,
    warnRecordingDisabled: true,
  };
}

export function isConsentNo(utterance: string): boolean {
  const lower = utterance.toLowerCase().trim();
  if (/\bnot\s+ok(?:ay)?\b/i.test(lower)) return true;
  const noPhrases = [
    "no",
    "nope",
    "nah",
    "don't",
    "do not",
    "decline",
    "refuse",
  ];
  if (noPhrases.some((p) => lower === p || lower.startsWith(`${p} `))) {
    return true;
  }
  return /\b(no|nope|nah)\b/i.test(utterance) && !/\bknow\b/i.test(utterance);
}

export function isConsentYes(utterance: string): boolean {
  if (isConsentNo(utterance)) return false;
  const lower = utterance.toLowerCase().trim();
  const yesPhrases = [
    "yes",
    "yeah",
    "yep",
    "sure",
    "ok",
    "okay",
    "that's fine",
    "that is fine",
    "go ahead",
    "fine",
    "absolutely",
  ];
  if (yesPhrases.some((p) => lower === p || lower.startsWith(`${p} `))) {
    return true;
  }
  return /\b(yes|yeah|yep|sure|ok|okay)\b/i.test(utterance);
}

export function extractName(utterance: string): string | null {
  const trimmed = utterance.trim();
  const patterns = [/(?:my name is|i'm|i am|call me)\s+(.+)/i];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      return sanitizeToken(match[1], 40);
    }
  }
  if (trimmed.length > 0 && trimmed.length <= 60) {
    return sanitizeToken(trimmed, 40);
  }
  return null;
}

export function extractBirthdate(utterance: string): string | null {
  const trimmed = utterance.trim();
  const iso = trimmed.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso?.[1]) return iso[1];
  const slash = trimmed.match(/\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
  if (slash?.[1]) return slash[1];
  const spoken = trimmed.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/i,
  );
  if (spoken?.[0]) return spoken[0];
  if (trimmed.length >= 4 && trimmed.length <= 40) {
    return sanitizeToken(trimmed, 40);
  }
  return null;
}

function sanitizeToken(raw: string, maxLen: number): string {
  let value = raw
    .trim()
    .replace(/[.,!?;:]+$/g, "")
    .trim();
  if (value.length > maxLen) {
    value = value.slice(0, maxLen).trim();
  }
  return value;
}

function askNameAgain(state: ConversationState): ConversationTurnResult {
  const prompt = speakAndChat(
    "Sorry, I didn't catch your name. May I have your name please?",
  );
  return {
    state,
    speakLines: prompt.speakLines,
    messages: prompt.messages,
    recordingAction: null,
  };
}

function askBirthdateAgain(state: ConversationState): ConversationTurnResult {
  const prompt = speakAndChat(
    "Sorry, I didn't catch your date of birth. Could you repeat it?",
  );
  return {
    state,
    speakLines: prompt.speakLines,
    messages: prompt.messages,
    recordingAction: null,
  };
}

function finishAfterPii(state: ConversationState): ConversationTurnResult {
  const next: ConversationState = { ...state, phase: "complete" };
  const thankYou = speakAndChat(
    `Thank you, ${state.name}. We have your date of birth on file.`,
  );
  let recordingAction: RecordingAction = null;
  if (state.consent === true && state.recordingAvailable) {
    recordingAction = "resume";
  }
  return {
    state: next,
    speakLines: thankYou.speakLines,
    messages: thankYou.messages,
    recordingAction,
  };
}

export function handleUtterance(
  state: ConversationState,
  utterance: string,
): ConversationTurnResult {
  switch (state.phase) {
    case "awaitingConsent": {
      if (isConsentNo(utterance)) {
        const next: ConversationState = {
          ...state,
          phase: "awaitingName",
          consent: false,
        };
        const name = speakAndChat(NAME_PROMPT);
        return {
          state: next,
          speakLines: name.speakLines,
          messages: name.messages,
          recordingAction: "stop",
        };
      }
      if (isConsentYes(utterance)) {
        const next: ConversationState = {
          ...state,
          phase: "awaitingName",
          consent: true,
        };
        const name = speakAndChat(NAME_PROMPT);
        return {
          state: next,
          speakLines: name.speakLines,
          messages: name.messages,
          recordingAction: "pause",
        };
      }
      const retry = speakAndChat(
        "Please say yes or no — may we record this conversation?",
      );
      return {
        state,
        speakLines: retry.speakLines,
        messages: retry.messages,
        recordingAction: null,
      };
    }
    case "awaitingName": {
      const name = extractName(utterance);
      if (!name) {
        return askNameAgain(state);
      }
      const next: ConversationState = {
        ...state,
        phase: "awaitingBirthdate",
        name,
      };
      const birthdate = speakAndChat(BIRTHDATE_PROMPT);
      return {
        state: next,
        speakLines: birthdate.speakLines,
        messages: birthdate.messages,
        recordingAction: null,
      };
    }
    case "awaitingBirthdate": {
      const birthdate = extractBirthdate(utterance);
      if (!birthdate) {
        return askBirthdateAgain(state);
      }
      return finishAfterPii({ ...state, birthdate });
    }
    case "complete": {
      const done = speakAndChat("We are all set. How can I help you today?");
      return {
        state,
        speakLines: done.speakLines,
        messages: done.messages,
        recordingAction: null,
      };
    }
  }
}
