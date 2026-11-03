import { describe, expect, it } from "vitest";
import { compileFlow, FlowSession } from "../../src/flow/core/index.js";
import { flush, makeHarness } from "./harness.js";

const model = {
  provider: "openrouter",
  model: "m",
  apiKeySecret: "AGENT_K",
};

function doc(nodes: any[], start = nodes[0].id): any {
  return { version: 1, start, models: { default: model }, nodes };
}

const basic = (): any =>
  doc([
    { id: "greet", type: "speak", text: "Hi", next: "ask" },
    { id: "ask", type: "listen", next: "say", onNoInput: "noin" },
    {
      id: "say",
      type: "speak",
      text: "You said {{last.transcript}}",
      next: "end",
    },
    { id: "noin", type: "speak", text: "Still there?", next: "end" },
    { id: "end", type: "end", reason: "done" },
  ]);

function session(
  d: any,
  h: ReturnType<typeof makeHarness>,
  extra: Partial<ConstructorParameters<typeof FlowSession>[2]> = {},
) {
  return new FlowSession(compileFlow(d), h.effects, {
    sessionId: "s1",
    channel: "voice",
    ...extra,
  });
}

describe("FlowSession", () => {
  it("greet -> listen -> speak", async () => {
    const h = makeHarness();
    const s = session(basic(), h);
    await s.start();
    expect(h.speaks.map((x) => x.text)).toEqual(["Hi"]);
    await s.onUserText("yes", { utteranceId: "u1" });
    expect(h.speaks.map((x) => x.text)).toEqual(["Hi", "You said yes"]);
    expect(h.ends).toEqual(["done"]);
    expect(s.variables["last.utteranceId"]).toBe("u1");
    expect(s.conversation).toEqual([
      { role: "assistant", text: "Hi" },
      { role: "user", text: "yes" },
      { role: "assistant", text: "You said yes" },
    ]);
  });

  it("listen timeout takes onNoInput at exactly timeoutMs", async () => {
    const h = makeHarness();
    const s = session(basic(), h);
    await s.start();
    h.advance(7999);
    await flush();
    expect(h.speaks.map((x) => x.text)).toEqual(["Hi"]);
    h.advance(1);
    await flush();
    expect(h.speaks.map((x) => x.text)).toEqual(["Hi", "Still there?"]);
  });

  it("a final during speak is buffered and consumed by the next listen", async () => {
    const h = makeHarness({ autoSpeak: false });
    const s = session(basic(), h);
    const started = s.start();
    await flush();
    void s.onUserText("early");
    h.pending[0]!.resolve();
    await flush();
    h.pending[1]!.resolve();
    await started;
    await flush();
    expect(h.speaks.map((x) => x.text)).toEqual(["Hi", "You said early"]);
  });

  it("the latest buffered final wins", async () => {
    const h = makeHarness({ autoSpeak: false });
    const s = session(basic(), h);
    const started = s.start();
    await flush();
    void s.onUserText("first");
    void s.onUserText("second");
    h.pending[0]!.resolve();
    await flush();
    h.pending[1]!.resolve();
    await started;
    await flush();
    expect(h.speaks.at(-1)!.text).toBe("You said second");
  });

  it("drops a completion that settles after stop()", async () => {
    const h = makeHarness({ autoSpeak: false });
    const s = session(basic(), h);
    const started = s.start();
    await flush();
    s.stop();
    expect(h.pending[0]!.cancelled).toBe(true);
    h.pending[0]!.resolve();
    await started;
    await flush();
    expect(h.speaks).toHaveLength(1);
    expect(h.ends).toEqual([]);
    expect(s.staleDropped).toBe(1);
    expect(s.ended).toBe(true);
  });

  it("stops after the step limit on a busy loop", async () => {
    const h = makeHarness();
    const d = doc([
      { id: "a", type: "set", assign: { x: 1 }, next: "b" },
      { id: "b", type: "set", assign: { x: 2 }, next: "a" },
    ]);
    const s = session(d, h);
    await s.start();
    expect(h.ends).toEqual(["step_limit"]);
    expect(h.traces.filter((t) => t.phase === "enter")).toHaveLength(100);
    expect(h.traces.at(-1)!.error).toBe("FLOW_STEP_LIMIT");
  });

  it("chat channel calls chat, never speak", async () => {
    const h = makeHarness();
    const s = session(basic(), h, { channel: "chat" });
    await s.start();
    await s.onUserText("yes");
    expect(h.chats).toEqual(["Hi", "You said yes"]);
    expect(h.calls).not.toContain("speak");
    expect(h.ends).toEqual(["done"]);
  });

  it("uses one turnId for speaks between two listens", async () => {
    const h = makeHarness();
    const d = doc([
      { id: "a", type: "speak", text: "one", next: "b" },
      { id: "b", type: "speak", text: "two", next: "l" },
      { id: "l", type: "listen", next: "c", onNoInput: "c" },
      { id: "c", type: "speak", text: "three", next: "d" },
      { id: "d", type: "speak", text: "four", next: "e" },
      { id: "e", type: "end", reason: "x" },
    ]);
    const s = session(d, h);
    await s.start();
    await s.onUserText("go");
    const ids = h.speaks.map((x) => x.turnId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).toBe(ids[3]);
    expect(ids[0]).not.toBe(ids[2]);
  });

  it("traces enter/exit pairs with increasing seq; values only on request", async () => {
    const h = makeHarness();
    const s = session(basic(), h);
    await s.start();
    await s.onUserText("yes");
    const t = h.traces;
    expect(t.map((e) => e.seq)).toEqual(t.map((_, i) => i + 1));
    const enters = t.filter((e) => e.phase === "enter").length;
    const exits = t.filter((e) => e.phase === "exit").length;
    expect(enters).toBe(exits);
    expect(t.every((e) => e.vars === undefined)).toBe(true);
    const listenExit = t.find((e) => e.nodeId === "ask" && e.phase === "exit")!;
    expect(listenExit.edge).toBe("say");
    expect(listenExit.varsChanged).toEqual(["last.transcript"]);

    const h2 = makeHarness();
    const s2 = session(basic(), h2, { includeValuesInTrace: true });
    await s2.start();
    expect(h2.traces.find((e) => e.phase === "exit")!.vars).toMatchObject({
      "session.id": "s1",
    });
  });

  it("set and condition use variables and dotted paths", async () => {
    const h = makeHarness();
    const d = doc([
      { id: "s", type: "set", assign: { n: 5, who: "Ann" }, next: "c" },
      {
        id: "c",
        type: "condition",
        rules: { all: [{ var: "n", op: "gt", value: 3 }] },
        then: "yes",
        else: "no",
      },
      { id: "yes", type: "speak", text: "hi {{who}} {{obj.k}}", next: "e" },
      { id: "no", type: "speak", text: "no", next: "e" },
      { id: "e", type: "end", reason: "ok", text: "bye" },
    ]);
    const s = session(d, h, { initialVars: { obj: { k: "deep" } } });
    await s.start();
    expect(h.speaks.map((x) => [x.text, x.interruptible])).toEqual([
      ["hi Ann deep", true],
      ["bye", false],
    ]);
    expect(h.ends).toEqual(["ok"]);
  });

  it("wait resumes after ms", async () => {
    const h = makeHarness();
    const d = doc([
      { id: "w", type: "wait", ms: 500, next: "e" },
      { id: "e", type: "end", reason: "ok" },
    ]);
    const s = session(d, h);
    const p = s.start();
    await flush();
    h.advance(499);
    await flush();
    expect(h.ends).toEqual([]);
    h.advance(1);
    await p;
    expect(h.ends).toEqual(["ok"]);
  });

  it("ends with unsupported_node for nodes later chunks implement", async () => {
    const h = makeHarness();
    const d = doc([
      {
        id: "r",
        type: "route",
        paths: [{ id: "p", examples: ["x"], next: "r" }],
        onNone: "r",
        onError: "r",
      },
    ]);
    const s = session(d, h);
    await s.start();
    expect(h.ends).toEqual(["unsupported_node"]);
  });

  it("prototype names are not variables", async () => {
    const h = makeHarness();
    const d = doc([
      { id: "s", type: "set", assign: { who: "x" }, next: "a" },
      {
        id: "a",
        type: "speak",
        text: "a{{constructor}}b{{toString}}c",
        next: "c",
      },
      {
        id: "c",
        type: "condition",
        rules: { var: "valueOf", op: "exists" },
        then: "yes",
        else: "no",
      },
      { id: "yes", type: "speak", text: "yes", next: "e" },
      { id: "no", type: "speak", text: "{{who}}", next: "e" },
      { id: "e", type: "end", reason: "ok" },
    ]);
    const s = session(d, h);
    await s.start();
    expect(h.speaks.map((x) => x.text)).toEqual(["abc", "x"]);

    const h2 = makeHarness();
    const d2 = doc([
      { id: "s", type: "set", assign: {}, next: "a" },
      { id: "a", type: "speak", text: "{{__proto__}}", next: "e" },
      { id: "e", type: "end", reason: "ok" },
    ]);
    d2.nodes[0].assign = JSON.parse('{"__proto__":"p"}');
    const s2 = session(d2, h2);
    await s2.start();
    expect(h2.speaks.map((x) => x.text)).toEqual(["p"]);
    expect(s2.variablesPrototype).toBeNull();
  });

  describe("effect failures", () => {
    const rejections: unknown[] = [];
    const onRej = (r: unknown): void => {
      rejections.push(r);
    };

    it("a rejected speak ends with error, no unhandled rejection", async () => {
      process.on("unhandledRejection", onRej);
      try {
        const h = makeHarness();
        const fx = {
          ...h.effects,
          speak: () => ({
            done: Promise.reject(new Error("boom")),
            cancel() {},
          }),
        };
        const s = new FlowSession(compileFlow(basic()), fx, {
          sessionId: "s1",
          channel: "voice",
        });
        await s.start();
        await flush();
        expect(h.ends).toEqual(["error"]);
        const last = h.traces.at(-1)!;
        expect(last.error).toBe("FLOW_EFFECT_ERROR");
        expect(last.nodeId).toBe("greet");
        expect(rejections).toEqual([]);
      } finally {
        process.off("unhandledRejection", onRej);
      }
    });

    it("a rejection after a listen timeout is contained", async () => {
      process.on("unhandledRejection", onRej);
      try {
        const h = makeHarness();
        let n = 0;
        const fx = {
          ...h.effects,
          speak: (t: string, o: any) =>
            ++n === 1
              ? h.effects.speak(t, o)
              : { done: Promise.reject(new Error("boom")), cancel() {} },
        };
        const s = new FlowSession(compileFlow(basic()), fx, {
          sessionId: "s1",
          channel: "voice",
        });
        await s.start();
        h.advance(8000);
        await flush();
        await flush();
        expect(h.ends).toEqual(["error"]);
        expect(h.traces.at(-1)!.error).toBe("FLOW_EFFECT_ERROR");
        expect(rejections).toEqual([]);
      } finally {
        process.off("unhandledRejection", onRej);
      }
    });
  });

  it("a wait node resets the step counter; a loop without wait hits the cap", async () => {
    const h = makeHarness();
    const d = doc([
      { id: "w", type: "wait", ms: 10, next: "s" },
      { id: "s", type: "set", assign: { n: 1 }, next: "c" },
      {
        id: "c",
        type: "condition",
        rules: { var: "n", op: "gt", value: 0 },
        then: "w",
        else: "w",
      },
    ]);
    const s = session(d, h);
    const p = s.start();
    for (let i = 0; i < 200; i++) {
      await flush();
      h.advance(10);
    }
    await flush();
    expect(h.ends).toEqual([]);
    expect(
      h.traces.filter((t) => t.nodeId === "w" && t.phase === "enter").length,
    ).toBeGreaterThanOrEqual(200);
    s.stop();
    await p;

    const h2 = makeHarness();
    const d2 = doc([
      { id: "s", type: "set", assign: { n: 1 }, next: "c" },
      {
        id: "c",
        type: "condition",
        rules: { var: "n", op: "gt", value: 0 },
        then: "s",
        else: "s",
      },
    ]);
    await session(d2, h2).start();
    expect(h2.ends).toEqual(["step_limit"]);
  });

  it("onUserText language sets last.language", async () => {
    const h = makeHarness();
    const d = doc([
      { id: "l", type: "listen", next: "s", onNoInput: "s" },
      { id: "s", type: "speak", text: "[{{last.language}}]", next: "e" },
      { id: "e", type: "end", reason: "ok" },
    ]);
    const s = session(d, h);
    await s.start();
    await s.onUserText("hola", { language: "es" });
    expect(h.speaks.map((x) => x.text)).toEqual(["[es]"]);

    const h2 = makeHarness();
    const s2 = session(d, h2);
    await s2.start();
    await s2.onUserText("hi");
    expect(h2.speaks.map((x) => x.text)).toEqual(["[]"]);
    expect(Object.hasOwn(s2.variables, "last.language")).toBe(false);
  });
});
