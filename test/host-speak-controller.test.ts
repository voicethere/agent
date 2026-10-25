import { beforeEach, describe, expect, it } from "vitest";

import { SessionSpeakController } from "../src/host/index.js";
import type {
  AgentInterruptedMessage,
  SpeakResultMessage,
} from "../src/protocol.js";

type Out = SpeakResultMessage | AgentInterruptedMessage;

let out: Out[];
let clock: number;
let ctl: SessionSpeakController;

function make(options?: { flushQueuedOnBargeIn?: boolean }) {
  return new SessionSpeakController(
    "s1",
    { send: (m) => out.push(m), now: () => clock },
    options,
  );
}

function results(): SpeakResultMessage[] {
  return out.filter((m): m is SpeakResultMessage => m.type === "speak_result");
}
function interruptions(): AgentInterruptedMessage[] {
  return out.filter(
    (m): m is AgentInterruptedMessage => m.type === "agent_interrupted",
  );
}
function accept(
  id: string,
  text: string,
  extra?: { interruptible?: boolean; turnId?: string; inReplyTo?: string },
) {
  return ctl.accept({
    type: "speak",
    sessionId: "s1",
    text,
    requestId: id,
    ...extra,
  });
}

beforeEach(() => {
  out = [];
  clock = 1000;
  ctl = make();
});

describe("SessionSpeakController", () => {
  it("barge-in during the first of four speaks: one interrupted, three cancelled", () => {
    for (const [i, id] of ["r1", "r2", "r3", "r4"].entries()) {
      accept(id, `Sentence number ${i + 1}.`, {
        turnId: "t1",
        inReplyTo: "u1",
      });
    }
    ctl.onPlayStart("r1");
    expect(ctl.onBargeIn("wait")).toEqual({ stopCurrent: true });
    ctl.onReplyEnd("r1", {
      playedMs: 500,
      interrupted: true,
      synthesizedMs: 2000,
      synthesisComplete: true,
    });
    const r = results();
    expect(r).toHaveLength(4);
    expect(r.find((m) => m.requestId === "r1")?.status).toBe("interrupted");
    expect(
      r.filter((m) => m.status === "cancelled").map((m) => m.requestId),
    ).toEqual(["r2", "r3", "r4"]);
    const i = interruptions();
    expect(i).toHaveLength(1);
    expect(i[0]).toMatchObject({
      turnId: "t1",
      inReplyTo: "u1",
      cutRequestId: "r1",
      cancelledRequestIds: ["r2", "r3", "r4"],
      callerPartial: "wait",
      replyPlayedMs: 500,
    });
    expect(i[0]!.unplayedText).toContain("Sentence number 2.");
  });

  it("non-interruptible speak survives a barge-in flush", () => {
    accept("r1", "Playing now.");
    accept("r2", "Announcement.", { interruptible: false });
    accept("r3", "Dropped.");
    ctl.onPlayStart("r1");
    ctl.onBargeIn();
    expect(results().map((m) => m.requestId)).toEqual(["r3"]);
    expect(ctl.isCancelled("r2")).toBe(false);
    expect(ctl.isCancelled("r3")).toBe(true);
  });

  it("flushQueuedOnBargeIn false keeps queued speaks", () => {
    ctl = make({ flushQueuedOnBargeIn: false });
    accept("r1", "One.");
    accept("r2", "Two.");
    ctl.onPlayStart("r1");
    expect(ctl.onBargeIn()).toEqual({ stopCurrent: false });
    expect(out).toEqual([]);
    expect(ctl.isCancelled("r2")).toBe(false);
  });

  it("setBargeInEnabled(false) makes later speaks non-interruptible", () => {
    ctl.setBargeInEnabled(false);
    expect(accept("r1", "Locked.").interruptible).toBe(false);
    ctl.setBargeInEnabled(true);
    expect(accept("r2", "Open.").interruptible).toBe(true);
    ctl.setBargeInEnabled(false);
    expect(ctl.onBargeIn()).toEqual({ stopCurrent: false });
  });

  it("exactly one speak_result per requestId when cancel and barge-in race", () => {
    accept("r1", "One.");
    accept("r2", "Two.");
    ctl.onPlayStart("r1");
    ctl.cancel({ requestId: "r2" });
    ctl.onBargeIn();
    ctl.cancel();
    ctl.onReplyEnd("r1", { playedMs: 100, interrupted: true });
    ctl.onReplyEnd("r1", { playedMs: 100, interrupted: true });
    ctl.endSession();
    const ids = results().map((m) => m.requestId);
    expect(ids.sort()).toEqual(["r1", "r2"]);
  });

  it("cancel of the playing speak asks the host to stop it and settles interrupted", () => {
    accept("r1", "One.");
    ctl.onPlayStart("r1");
    expect(ctl.cancel({ requestId: "r1" })).toEqual({ stopCurrent: true });
    expect(results()).toEqual([]);
    ctl.onReplyEnd("r1", { playedMs: 50, interrupted: true });
    expect(results()[0]).toMatchObject({ status: "interrupted", playedMs: 50 });
  });

  it("legacy speaks never produce speak_result", () => {
    const a = ctl.accept({ type: "speak", sessionId: "s1", text: "Old one." });
    const b = ctl.accept({ type: "speak", sessionId: "s1", text: "Old two." });
    expect(a.legacy).toBe(true);
    expect(a.requestId).toBe("legacy:1");
    expect(b.requestId).toBe("legacy:2");
    ctl.onPlayStart(a.requestId);
    ctl.onBargeIn();
    ctl.onReplyEnd(a.requestId, { playedMs: 10, interrupted: true });
    ctl.endSession();
    expect(results()).toEqual([]);
    expect(interruptions()[0]!.cancelledRequestIds).toEqual([]);
  });

  it("playedText contains earlier played speaks of the turn and the estimated prefix of the cut one", () => {
    accept("r1", "Hello there.", { turnId: "t" });
    accept("r2", "Your order ships tomorrow morning.", { turnId: "t" });
    ctl.onPlayStart("r1");
    ctl.onReplyEnd("r1", {
      playedMs: 800,
      interrupted: false,
      synthesizedMs: 800,
      synthesisComplete: true,
    });
    ctl.onPlayStart("r2");
    ctl.onBargeIn();
    ctl.onReplyEnd("r2", {
      playedMs: 1000,
      interrupted: true,
      synthesizedMs: 2000,
      synthesisComplete: true,
    });
    const i = interruptions()[0]!;
    expect(i.playedText).toBe("Hello there. Your order ships");
    expect(i.unplayedText).toBe("tomorrow morning.");
    expect(i.replyPlayedMs).toBe(1800);
    expect(i.playedTextExact).toBe(false);
  });

  it("flushPendingInterruption emits once with an elapsed-time estimate before the reply end arrives", () => {
    accept("r1", "Your order ships tomorrow morning.", { turnId: "t" });
    ctl.onPlayStart("r1");
    clock += 1000;
    ctl.onBargeIn();
    clock += 500;
    ctl.flushPendingInterruption();
    ctl.flushPendingInterruption();
    expect(interruptions()).toHaveLength(1);
    expect(interruptions()[0]!.replyPlayedMs).toBe(1500);
    ctl.onReplyEnd("r1", { playedMs: 900, interrupted: true });
    expect(interruptions()).toHaveLength(1);
    expect(results()).toHaveLength(1);
  });

  it("cut before the first frame gives empty playedText", () => {
    accept("r1", "Your order ships tomorrow morning.");
    ctl.onPlayStart("r1");
    ctl.onBargeIn();
    ctl.onReplyEnd("r1", {
      playedMs: 0,
      interrupted: true,
      synthesizedMs: 2000,
      synthesisComplete: true,
    });
    const i = interruptions()[0]!;
    expect(i.playedText).toBe("");
    expect(i.unplayedText).toBe("Your order ships tomorrow morning.");
  });

  it("barge-in with only queued speaks reports at once", () => {
    accept("r1", "Queued.", { turnId: "t" });
    ctl.onBargeIn();
    expect(interruptions()[0]).toMatchObject({
      replyPlayedMs: 0,
      playedText: "",
      unplayedText: "Queued.",
      playedTextExact: true,
      cancelledRequestIds: ["r1"],
    });
  });

  it("endSession cancels pending speaks with session_ended", () => {
    accept("r1", "One.");
    accept("r2", "Two.");
    ctl.onPlayStart("r1");
    ctl.endSession();
    expect(results()).toHaveLength(2);
    for (const r of results()) {
      expect(r).toMatchObject({
        status: "cancelled",
        errorCode: "session_ended",
      });
    }
  });
});
