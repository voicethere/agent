import type {
  AgentInterruptedMessage,
  SpeakMessage,
  SpeakResultMessage,
  SpeakStatus,
} from "../protocol.js";
import { DEFAULT_CHARS_PER_MS, estimatePlayedText } from "./speak-text.js";

type EntryState = "queued" | "playing" | "settled";

interface Entry {
  requestId: string;
  legacy: boolean;
  text: string;
  turnId?: string;
  inReplyTo?: string;
  interruptible: boolean;
  state: EntryState;
  startedAt?: number;
  status?: SpeakStatus;
  playedMs: number;
  synthesizedMs?: number;
  synthesisComplete?: boolean;
}

/** A reply end with `interrupted` counts as the barge-in's cut if the barge-in follows within this window. */
export const BARGE_IN_REPLY_END_WINDOW_MS = 1000;
/** Settled entries kept per session; older ones are dropped. */
export const MAX_SETTLED_ENTRIES = 64;

interface PendingInterruption {
  bargeInAt: number;
  cut: Entry;
  cancelled: Entry[];
  callerPartial?: string;
  startedAt: number;
}

export interface SessionSpeakControllerDeps {
  send(msg: SpeakResultMessage | AgentInterruptedMessage): void;
  now(): number;
}

export interface SessionSpeakControllerOptions {
  /** Default true. */
  flushQueuedOnBargeIn?: boolean;
}

/**
 * Parent-side bookkeeping for one session's speaks: results, cancellation, barge-in
 * flushing and the interruption report. Transport-free; the host plays audio and feeds
 * events in.
 */
export class SessionSpeakController {
  private readonly entries: Entry[] = [];
  private readonly byId = new Map<string, Entry>();
  private readonly resultSent = new Set<string>();
  private readonly flushQueued: boolean;
  private legacyCounter = 0;
  private bargeIn = true;
  private pending: PendingInterruption | null = null;
  private lastInterrupted: { entry: Entry; at: number } | null = null;
  private rateChars = 0;
  private rateMs = 0;

  constructor(
    private readonly sessionId: string,
    private readonly deps: SessionSpeakControllerDeps,
    options?: SessionSpeakControllerOptions,
  ) {
    this.flushQueued = options?.flushQueuedOnBargeIn ?? true;
  }

  get bargeInEnabled(): boolean {
    return this.bargeIn;
  }

  /** @internal */
  get sizeForTests(): number {
    return this.entries.length;
  }

  setBargeInEnabled(enabled: boolean): void {
    this.bargeIn = enabled;
  }

  accept(msg: SpeakMessage): {
    requestId: string;
    interruptible: boolean;
    legacy: boolean;
  } {
    const legacy = !msg.requestId;
    const requestId = msg.requestId ?? `legacy:${++this.legacyCounter}`;
    const interruptible = msg.interruptible !== false && this.bargeIn;
    const entry: Entry = {
      requestId,
      legacy,
      text: msg.text,
      ...(msg.turnId ? { turnId: msg.turnId } : {}),
      ...(msg.inReplyTo ? { inReplyTo: msg.inReplyTo } : {}),
      interruptible,
      state: "queued",
      playedMs: 0,
    };
    this.entries.push(entry);
    this.byId.set(requestId, entry);
    return { requestId, interruptible, legacy };
  }

  /** True when the speak was cancelled or settled before it played. */
  isCancelled(requestId: string): boolean {
    const e = this.byId.get(requestId);
    return e?.state === "settled" && e.status === "cancelled";
  }

  onPlayStart(requestId: string): void {
    const e = this.byId.get(requestId);
    if (!e || e.state !== "queued") return;
    e.state = "playing";
    e.startedAt = this.deps.now();
    if (this.lastInterrupted && this.lastInterrupted.entry !== e) {
      this.lastInterrupted = null;
    }
  }

  onReplyEnd(
    requestId: string,
    info: {
      playedMs: number;
      interrupted: boolean;
      synthesizedMs?: number;
      synthesisComplete?: boolean;
    },
  ): void {
    const e = this.byId.get(requestId);
    if (!e || e.state === "settled") return;
    e.playedMs = info.playedMs;
    if (info.synthesizedMs !== undefined) e.synthesizedMs = info.synthesizedMs;
    if (info.synthesisComplete !== undefined) {
      e.synthesisComplete = info.synthesisComplete;
    }
    if (
      !info.interrupted &&
      info.synthesisComplete === true &&
      (info.synthesizedMs ?? 0) > 0
    ) {
      this.rateChars += e.text.length;
      this.rateMs += info.synthesizedMs as number;
    }
    this.settle(e, info.interrupted ? "interrupted" : "played");
    if (this.pending && this.pending.cut === e) {
      this.completeInterruption(e.playedMs);
    } else if (info.interrupted) {
      this.lastInterrupted = { entry: e, at: this.deps.now() };
    }
  }

  onSpeakFailed(requestId: string, errorCode: string): void {
    const e = this.byId.get(requestId);
    if (!e || e.state === "settled") return;
    this.settle(e, "failed", errorCode);
  }

  cancel(target?: { requestId?: string; turnId?: string }): {
    stopCurrent: boolean;
  } {
    let stopCurrent = false;
    for (const e of this.entries) {
      if (e.state === "settled") continue;
      if (!this.matches(e, target)) continue;
      if (e.state === "queued") {
        this.settle(e, "cancelled");
      } else {
        stopCurrent = true;
      }
    }
    return { stopCurrent };
  }

  onBargeIn(callerPartial?: string): { stopCurrent: boolean } {
    if (!this.flushQueued || !this.bargeIn) return { stopCurrent: false };
    const cancelled: Entry[] = [];
    for (const e of this.entries) {
      if (e.state === "queued" && e.interruptible) {
        this.settle(e, "cancelled");
        cancelled.push(e);
      }
    }
    const now = this.deps.now();
    const cut = this.entries.find(
      (e) => e.state === "playing" && e.interruptible,
    );
    const last = this.lastInterrupted;
    if (
      !cut &&
      last &&
      last.entry.interruptible &&
      now - last.at <= BARGE_IN_REPLY_END_WINDOW_MS
    ) {
      this.pending = {
        bargeInAt: now,
        cut: last.entry,
        cancelled,
        ...(callerPartial !== undefined ? { callerPartial } : {}),
        startedAt: last.entry.startedAt ?? now,
      };
      this.lastInterrupted = null;
      this.completeInterruption(last.entry.playedMs);
      return { stopCurrent: false };
    }
    if (cut) {
      this.pending = {
        bargeInAt: now,
        cut,
        cancelled,
        ...(callerPartial !== undefined ? { callerPartial } : {}),
        startedAt: cut.startedAt ?? this.deps.now(),
      };
      return { stopCurrent: true };
    }
    if (cancelled.length > 0) {
      const first = cancelled[0] as Entry;
      this.deps.send({
        type: "agent_interrupted",
        sessionId: this.sessionId,
        ...(first.turnId ? { turnId: first.turnId } : {}),
        ...(first.inReplyTo ? { inReplyTo: first.inReplyTo } : {}),
        replyPlayedMs: 0,
        playedText: "",
        unplayedText: cancelled.map((e) => e.text).join(" "),
        playedTextExact: true,
        cancelledRequestIds: cancelled
          .filter((e) => !e.legacy)
          .map((e) => e.requestId),
        ...(callerPartial !== undefined ? { callerPartial } : {}),
      });
    }
    return { stopCurrent: false };
  }

  /** Call before forwarding a `user_speech_final` so the report precedes it. */
  flushPendingInterruption(): void {
    if (!this.pending) return;
    const elapsed = Math.max(
      0,
      this.pending.bargeInAt - this.pending.startedAt,
    );
    this.completeInterruption(elapsed);
  }

  endSession(): void {
    this.pending = null;
    this.lastInterrupted = null;
    for (const e of this.entries) {
      if (e.state !== "settled") this.settle(e, "cancelled", "session_ended");
    }
  }

  private matches(
    e: Entry,
    target?: { requestId?: string; turnId?: string },
  ): boolean {
    if (!target || (!target.requestId && !target.turnId)) return true;
    if (target.requestId && e.requestId === target.requestId) return true;
    if (target.turnId && e.turnId === target.turnId) return true;
    return false;
  }

  private settle(e: Entry, status: SpeakStatus, errorCode?: string): void {
    e.state = "settled";
    e.status = status;
    if (status === "played" && this.lastInterrupted) {
      this.lastInterrupted = null;
    }
    this.prune();
    if (e.legacy || this.resultSent.has(e.requestId)) return;
    this.resultSent.add(e.requestId);
    this.deps.send({
      type: "speak_result",
      sessionId: this.sessionId,
      requestId: e.requestId,
      ...(e.turnId ? { turnId: e.turnId } : {}),
      status,
      playedMs: status === "cancelled" || status === "failed" ? 0 : e.playedMs,
      ...(e.synthesizedMs !== undefined
        ? { synthesizedMs: e.synthesizedMs }
        : {}),
      ...(errorCode ? { errorCode } : {}),
    });
  }

  private prune(): void {
    let settled = 0;
    for (const e of this.entries) if (e.state === "settled") settled++;
    if (settled <= MAX_SETTLED_ENTRIES) return;
    let drop = settled - MAX_SETTLED_ENTRIES;
    const keep = new Set<Entry>();
    if (this.pending) keep.add(this.pending.cut);
    if (this.lastInterrupted) keep.add(this.lastInterrupted.entry);
    const next: Entry[] = [];
    for (const e of this.entries) {
      if (drop > 0 && e.state === "settled" && !keep.has(e)) {
        drop--;
        this.byId.delete(e.requestId);
        this.resultSent.delete(e.requestId);
      } else {
        next.push(e);
      }
    }
    this.entries.length = 0;
    this.entries.push(...next);
  }

  private rate(): number {
    return this.rateMs > 0
      ? this.rateChars / this.rateMs
      : DEFAULT_CHARS_PER_MS;
  }

  private completeInterruption(cutPlayedMs: number): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const cut = p.cut;
    const synth = cut.synthesizedMs;
    const audioMs = cut.synthesisComplete
      ? (synth ?? 0)
      : Math.max(synth ?? 0, cut.text.length / this.rate());
    const est = estimatePlayedText(cut.text, cutPlayedMs, audioMs);

    const earlier = cut.turnId
      ? this.entries.filter(
          (e) =>
            e !== cut &&
            e.turnId === cut.turnId &&
            e.state === "settled" &&
            e.status === "played" &&
            this.entries.indexOf(e) < this.entries.indexOf(cut),
        )
      : [];
    const playedParts = [...earlier.map((e) => e.text), est.played].filter(
      (t) => t.length > 0,
    );
    const unplayedParts = [
      est.unplayed,
      ...p.cancelled.map((e) => e.text),
    ].filter((t) => t.length > 0);

    this.deps.send({
      type: "agent_interrupted",
      sessionId: this.sessionId,
      ...(cut.turnId ? { turnId: cut.turnId } : {}),
      ...(cut.inReplyTo ? { inReplyTo: cut.inReplyTo } : {}),
      ...(cut.legacy ? {} : { cutRequestId: cut.requestId }),
      replyPlayedMs:
        earlier.reduce((sum, e) => sum + e.playedMs, 0) + cutPlayedMs,
      playedText: playedParts.join(" "),
      unplayedText: unplayedParts.join(" "),
      playedTextExact: false,
      cancelledRequestIds: p.cancelled
        .filter((e) => !e.legacy)
        .map((e) => e.requestId),
      ...(p.callerPartial !== undefined
        ? { callerPartial: p.callerPartial }
        : {}),
    });
  }
}
