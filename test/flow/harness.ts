import type { FlowEffects, FlowTraceEvent } from "../../src/flow/core/index.js";

export interface Deferred {
  resolve(): void;
  cancelled: boolean;
}

export function makeHarness(opts: { autoSpeak?: boolean } = {}) {
  const autoSpeak = opts.autoSpeak ?? true;
  let now = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const calls: string[] = [];
  const speaks: { text: string; turnId: string; interruptible: boolean }[] = [];
  const chats: string[] = [];
  const chatTurnIds: (string | undefined)[] = [];
  const traces: FlowTraceEvent[] = [];
  const ends: string[] = [];
  const pending: Deferred[] = [];
  const logs: {
    level: string;
    message: string;
    fields: Record<string, unknown>;
  }[] = [];

  const effects: FlowEffects = {
    speak(text, o) {
      calls.push("speak");
      speaks.push({ text, turnId: o.turnId, interruptible: o.interruptible });
      let resolve!: (v: { status: string }) => void;
      const done = new Promise<{ status: string }>((r) => (resolve = r));
      const d: Deferred = {
        cancelled: false,
        resolve: () => resolve({ status: "completed" }),
      };
      if (autoSpeak) d.resolve();
      else pending.push(d);
      return {
        done,
        cancel() {
          d.cancelled = true;
        },
      };
    },
    chat(text, o) {
      calls.push("chat");
      chats.push(text);
      chatTurnIds.push(o?.turnId);
    },
    http: () => Promise.reject(new Error("unused")),
    tool: () => Promise.reject(new Error("unused")),
    llm: () => {
      throw new Error("unused");
    },
    classify: () => Promise.reject(new Error("unused")),
    end(reason) {
      calls.push("end");
      ends.push(reason);
    },
    trace(e) {
      traces.push(e);
    },
    log(level, message, fields) {
      logs.push({ level, message, fields });
    },
    clock: {
      now: () => now,
      setTimeout(fn, ms) {
        const t = { at: now + ms, fn, live: true };
        timers.push(t);
        return () => {
          t.live = false;
        };
      },
    },
  };

  return {
    effects,
    calls,
    speaks,
    chats,
    chatTurnIds,
    traces,
    logs,
    ends,
    pending,
    advance(ms: number) {
      now += ms;
      for (const t of timers) {
        if (t.live && t.at <= now) {
          t.live = false;
          t.fn();
        }
      }
    },
  };
}

export const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
