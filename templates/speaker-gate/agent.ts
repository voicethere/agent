/**
 * Caller speaker gate: decide whose voice the agent listens to, and change that
 * while the call stays up.
 *
 * Modes (set in the project's voice settings, switchable here with `setSpeakerGate`):
 *   disabled  every final reaches the agent, no speaker verdict.
 *   auto      only the enrolled caller's finals reach `onUserSpeechFinal`;
 *             a bystander arrives as `onUserSpeechIgnored` (no text).
 *   manual    every final carries `speaker`: "caller" | "other" | "unknown",
 *             and this agent decides what to do with it.
 *
 * Switch from the data channel with a chat message (`speaker-gate:auto`,
 * `speaker-gate:manual`, `speaker-gate:disabled`, `speaker-gate:reset`) or by
 * voice ("only listen to me", "listen to everyone"). Each event writes one `speaker_gate.<kind> n=<n> ...` log line
 * (the e2e smoke reads them; `final` lines include the transcript).
 */

import {
  agentLog,
  defineAgent,
  parseChatText,
  resetSpeakerEnrollment,
  setSpeakerGate,
  speak,
  type SpeakerGateMode,
  type SpeakerVerdict,
} from "@voicethere/agent";

export type SpeakerGateCommand =
  { kind: "mode"; mode: SpeakerGateMode } | { kind: "reset" };

/** Data-channel chat command: `speaker-gate:auto|manual|disabled|reset`. */
export function parseSpeakerGateCommand(
  text: string,
): SpeakerGateCommand | null {
  const match = /^speaker-gate:(auto|manual|disabled|reset)$/i.exec(
    text.trim(),
  );
  if (!match) return null;
  const word = match[1].toLowerCase();
  if (word === "reset") return { kind: "reset" };
  return { kind: "mode", mode: word as SpeakerGateMode };
}

function normalizeSpoken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Spoken command: "only listen to me" -> auto, "listen to everyone" -> manual. */
export function parseSpokenCommand(text: string): SpeakerGateCommand | null {
  const phrase = normalizeSpoken(text);
  if (phrase === "only listen to me") return { kind: "mode", mode: "auto" };
  if (phrase === "listen to everyone") {
    return { kind: "mode", mode: "manual" };
  }
  return null;
}

/** In manual mode the agent answers the caller and unverified speech, not `other`. */
export function shouldAnswer(speaker: SpeakerVerdict | undefined): boolean {
  return speaker !== "other";
}

/** At most one "I heard someone else" line per session in this window. */
export const OTHER_NOTICE_INTERVAL_MS = 30_000;

const lastOtherNoticeAt = new Map<string, number>();

const counters = new Map<string, number>();

/** One log line per event; `n` counts up from 1 across all lines of a session. */
export function logLine(
  sessionId: string,
  kind: "mode" | "final" | "ignored" | "reset",
  fields: string,
): string {
  const n = (counters.get(sessionId) ?? 0) + 1;
  counters.set(sessionId, n);
  const line = `speaker_gate.${kind} n=${n}${fields ? ` ${fields}` : ""}`;
  agentLog("info", line, sessionId);
  return line;
}

async function runCommand(
  sessionId: string,
  command: SpeakerGateCommand,
): Promise<void> {
  if (command.kind === "reset") {
    const result = await resetSpeakerEnrollment(sessionId);
    if (!result.ok) return;
    logLine(sessionId, "reset", "");
    speak(sessionId, "Okay, I will learn your voice again.");
    return;
  }
  const result = await setSpeakerGate(sessionId, { mode: command.mode });
  if (!result.ok) return;
  logLine(sessionId, "mode", `mode=${result.mode}`);
  speak(
    sessionId,
    result.mode === "auto"
      ? "Okay, I only listen to you now."
      : result.mode === "manual"
        ? "Okay, I listen to everyone and tell voices apart."
        : "Okay, I listen to every voice.",
  );
}

defineAgent({
  onSessionStart(ctx) {
    logLine(
      ctx.sessionId,
      "mode",
      `mode=${ctx.speakerGate?.mode ?? "disabled"}`,
    );
  },

  async onUserSpeechFinal(ctx) {
    const utterance = ctx.utteranceId ? ` utteranceId=${ctx.utteranceId}` : "";
    const reason = ctx.speakerUnknownReason
      ? ` reason=${ctx.speakerUnknownReason}`
      : "";
    logLine(
      ctx.sessionId,
      "final",
      `speaker=${ctx.speaker ?? "none"}${utterance}${reason} text=${JSON.stringify(ctx.text)}`,
    );
    const spoken = parseSpokenCommand(ctx.text);
    // A bystander cannot change the mode in manual mode.
    if (spoken && ctx.speaker !== "other") {
      await runCommand(ctx.sessionId, spoken);
      return;
    }
    if (!shouldAnswer(ctx.speaker)) {
      const now = Date.now();
      const last = lastOtherNoticeAt.get(ctx.sessionId) ?? 0;
      if (now - last >= OTHER_NOTICE_INTERVAL_MS) {
        lastOtherNoticeAt.set(ctx.sessionId, now);
        speak(
          ctx.sessionId,
          "I heard someone else. I am listening to the caller.",
        );
      }
      return;
    }
    speak(ctx.sessionId, `You said: ${ctx.text}`);
  },

  onUserSpeechIgnored(ctx) {
    logLine(
      ctx.sessionId,
      "ignored",
      `utteranceId=${ctx.utteranceId} reason=${ctx.reason}`,
    );
  },

  async onDataChannelMessage(ctx) {
    const text = parseChatText(ctx.message);
    if (!text) return;
    const command = parseSpeakerGateCommand(text);
    if (!command) return;
    await runCommand(ctx.sessionId, command);
  },

  onSessionEnd(ctx) {
    lastOtherNoticeAt.delete(ctx.sessionId);
    counters.delete(ctx.sessionId);
  },
});
