import { describe, expect, it, vi } from "vitest";
import {
  compileFlow,
  FlowSession,
  resolvePointer,
} from "../../src/flow/core/index.js";
import { createNodeEffects } from "../../src/flow/effects-node.js";
import { flush, makeHarness } from "./harness.js";

const model = { provider: "openrouter", model: "m", apiKeySecret: "AGENT_K" };

function doc(nodes: any[], start = nodes[0].id): any {
  return {
    version: 1,
    start,
    models: { default: model },
    secrets: ["AGENT_T"],
    nodes,
  };
}

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

describe("resolvePointer", () => {
  const body = { a: { "b/c": [10, { d: "x" }], "~k": 1 }, n: null };
  it("follows RFC 6901 escapes and array indexes", () => {
    expect(resolvePointer(body, "")).toBe(body);
    expect(resolvePointer(body, "/a/b~1c/1/d")).toBe("x");
    expect(resolvePointer(body, "/a/~0k")).toBe(1);
    expect(resolvePointer(body, "/a/b~1c/0")).toBe(10);
  });
  it("returns undefined for misses, prototypes and bad pointers", () => {
    expect(resolvePointer(body, "/a/zzz")).toBeUndefined();
    expect(resolvePointer(body, "/a/b~1c/01")).toBeUndefined();
    expect(resolvePointer(body, "/__proto__")).toBeUndefined();
    expect(resolvePointer(body, "/n/x")).toBeUndefined();
    expect(resolvePointer(body, "a")).toBeUndefined();
  });
});

describe("listen and buffered finals", () => {
  const loop = () =>
    doc([
      { id: "l", type: "listen", next: "s", onNoInput: "l" },
      { id: "s", type: "speak", text: "[{{last.language}}]", next: "l" },
    ]);

  it("a turn with language es then a turn without renders {{last.language}} empty", async () => {
    const h = makeHarness();
    const s = session(loop(), h);
    await s.start();
    await s.onUserText("hola", { language: "es" });
    await s.onUserText("hi");
    expect(h.speaks.map((x) => x.text)).toEqual(["[es]", "[]"]);
  });

  it("logs a buffered final once, metadata only", async () => {
    const h = makeHarness({ autoSpeak: false });
    const d = doc([
      { id: "q", type: "speak", text: "question", next: "l" },
      { id: "l", type: "listen", next: "e", onNoInput: "l" },
      { id: "e", type: "end", reason: "ok" },
    ]);
    const s = session(d, h);
    const p = s.start();
    await flush();
    await s.onUserText("secret words here", { utteranceId: "u9" });
    const buffered = h.logs.filter((l) => l.message === "flow_input_buffered");
    expect(buffered).toHaveLength(1);
    expect(buffered[0]!.fields).toEqual({
      length: 17,
      utteranceId: "u9",
      replaced: false,
    });
    expect(JSON.stringify(h.logs)).not.toContain("secret words");
    // latest final wins and is consumed by the next listen
    await s.onUserText("later", { utteranceId: "u10" });
    expect(
      h.logs.filter((l) => l.message === "flow_input_buffered")[1]!.fields,
    ).toMatchObject({ replaced: true });
    h.pending[0]!.resolve();
    await p;
    expect(s.variables["last.transcript"]).toBe("later");
    expect(h.ends).toEqual(["ok"]);
  });
});

describe("fallback chat speech", () => {
  const loop = () =>
    doc([
      { id: "l", type: "listen", next: "s", onNoInput: "l" },
      { id: "s", type: "speak", text: "reply", next: "l" },
    ]);
  const stubChat = (h: ReturnType<typeof makeHarness>) => {
    const cancels: ReturnType<typeof vi.fn>[] = [];
    h.effects.chat = () => {
      const cancel = vi.fn();
      cancels.push(cancel);
      return { done: new Promise<{ status: string }>(() => {}), cancel };
    };
    return cancels;
  };

  it("fallback chat speech of turn 1 is cancelled when turn 2 input arrives", async () => {
    const h = makeHarness();
    const cancels = stubChat(h);
    const s = session(loop(), h, { channel: "chat" });
    await s.start();
    await s.onUserText("one");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).not.toHaveBeenCalled();
    await s.onUserText("two");
    expect(cancels).toHaveLength(2);
    expect(cancels[0]).toHaveBeenCalledTimes(1);
    expect(cancels[1]).not.toHaveBeenCalled();
  });

  it("stop cancels fallback chat speech", async () => {
    const h = makeHarness();
    const cancels = stubChat(h);
    const s = session(loop(), h, { channel: "chat" });
    await s.start();
    await s.onUserText("one");
    expect(cancels[0]).not.toHaveBeenCalled();
    s.stop();
    expect(cancels[0]).toHaveBeenCalledTimes(1);
  });
});

describe("http node", () => {
  const flow = (extra: any = {}) =>
    doc([
      {
        id: "call",
        type: "http",
        method: "POST",
        url: "https://api.example.com/{{who}}",
        headers: {
          Authorization: { secret: "AGENT_T", prefix: "Bearer " },
          "X-Who": "{{who}}",
        },
        body: { name: "{{who}}", n: 3 },
        map: { balance: "/data/balance", missing: "/nope" },
        next: "ok",
        onError: "bad",
        ...extra,
      },
      { id: "ok", type: "end", reason: "ok" },
      { id: "bad", type: "end", reason: "bad" },
    ]);
  const init = { who: "ann" };

  it("renders the request, maps the body and sets <id>.status", async () => {
    const h = makeHarness();
    let seen: any;
    h.effects.http = async (req) => {
      seen = req;
      return { status: 200, body: { data: { balance: 42 } } };
    };
    const s = session(flow(), h, { initialVars: init });
    await s.start();
    expect(seen).toMatchObject({
      method: "POST",
      url: "https://api.example.com/ann",
      headers: {
        Authorization: { secret: "AGENT_T", prefix: "Bearer " },
        "X-Who": "ann",
      },
      body: { name: "ann", n: 3 },
      timeoutMs: 5000,
    });
    expect(s.variables["balance"]).toBe(42);
    expect(Object.hasOwn(s.variables, "missing")).toBe(false);
    expect(s.variables["call.status"]).toBe(200);
    expect(h.ends).toEqual(["ok"]);
  });

  it("non-2xx -> error.<id> = HTTP_<status> and onError", async () => {
    const h = makeHarness();
    h.effects.http = async () => ({ status: 404, body: {} });
    const s = session(flow(), h, { initialVars: init });
    await s.start();
    expect(s.variables["error.call"]).toBe("HTTP_404");
    expect(h.ends).toEqual(["bad"]);
  });

  it("effect error codes pass through; no code means HTTP_NETWORK", async () => {
    for (const [err, code] of [
      [
        Object.assign(new Error("x"), { code: "HTTP_REDIRECT_BLOCKED" }),
        "HTTP_REDIRECT_BLOCKED",
      ],
      [new Error("boom"), "HTTP_NETWORK"],
    ] as const) {
      const h = makeHarness();
      h.effects.http = () => Promise.reject(err);
      const s = session(flow(), h, { initialVars: init });
      await s.start();
      expect(s.variables["error.call"]).toBe(code);
      expect(h.ends).toEqual(["bad"]);
    }
  });

  it("a hang ends with HTTP_TIMEOUT at timeoutMs and aborts the request", async () => {
    const h = makeHarness();
    let aborted = false;
    h.effects.http = (_req, signal) =>
      new Promise((_r, rej) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          rej(new Error("aborted"));
        }),
      );
    const s = session(flow({ timeoutMs: 1000 }), h, { initialVars: init });
    const p = s.start();
    await flush();
    h.advance(999);
    await flush();
    expect(h.ends).toEqual([]);
    h.advance(1);
    await p;
    expect(aborted).toBe(true);
    expect(s.variables["error.call"]).toBe("HTTP_TIMEOUT");
    expect(h.ends).toEqual(["bad"]);
  });

  it("a late response after stop is dropped", async () => {
    const h = makeHarness();
    let release!: () => void;
    h.effects.http = () =>
      new Promise((r) => {
        release = () => r({ status: 200, body: { data: { balance: 1 } } });
      });
    const s = session(flow(), h, { initialVars: init });
    const p = s.start();
    await flush();
    s.stop();
    release();
    await p;
    expect(h.ends).toEqual([]);
    expect(Object.hasOwn(s.variables, "balance")).toBe(false);
  });
});

describe("mcp node", () => {
  const flow = (extra: any = {}) =>
    doc([
      {
        id: "look",
        type: "mcp",
        source: "service",
        tool: "get_balance",
        args: { id: "{{who}}" },
        next: "ok",
        onError: "bad",
        ...extra,
      },
      { id: "ok", type: "end", reason: "ok" },
      { id: "bad", type: "end", reason: "bad" },
    ]);

  it("maps a JSON result", async () => {
    const h = makeHarness();
    let seen: any[] = [];
    h.effects.tool = async (...a) => {
      seen = a;
      return { content: JSON.stringify({ amount: 7 }) };
    };
    const s = session(flow({ map: { amount: "/amount" } }), h, {
      initialVars: { who: "ann" },
    });
    await s.start();
    expect(seen.slice(0, 3)).toEqual(["service", "get_balance", { id: "ann" }]);
    expect(seen[4]).toEqual({ timeoutMs: 15000 });
    expect(s.variables["amount"]).toBe(7);
    expect(h.ends).toEqual(["ok"]);
  });

  it("without a map the parsed content is <id>.result", async () => {
    const h = makeHarness();
    h.effects.tool = async () => ({ content: '{"a":{"b":"deep"}}' });
    const s = session(flow(), h);
    await s.start();
    expect(s.variables["look.result"]).toEqual({ a: { b: "deep" } });
    const h2 = makeHarness();
    h2.effects.tool = async () => ({ content: "plain text" });
    const s2 = session(flow(), h2);
    await s2.start();
    expect(s2.variables["look.result"]).toBe("plain text");
  });

  it("isError -> MCP_TOOL_ERROR; throw -> MCP_ERROR; hang -> MCP_TIMEOUT", async () => {
    const h = makeHarness();
    h.effects.tool = async () => ({ content: "nope", isError: true });
    const s = session(flow(), h);
    await s.start();
    expect(s.variables["error.look"]).toBe("MCP_TOOL_ERROR");
    expect(h.ends).toEqual(["bad"]);

    const h2 = makeHarness();
    h2.effects.tool = () => Promise.reject(new Error("x"));
    const s2 = session(flow(), h2);
    await s2.start();
    expect(s2.variables["error.look"]).toBe("MCP_ERROR");

    const h3 = makeHarness();
    h3.effects.tool = () => new Promise(() => {});
    const s3 = session(flow({ timeoutMs: 500 }), h3);
    const p = s3.start();
    await flush();
    h3.advance(500);
    await p;
    expect(s3.variables["error.look"]).toBe("MCP_TIMEOUT");
    expect(h3.ends).toEqual(["bad"]);
  });
});

describe("llm node", () => {
  const flow = (extra: any = {}) =>
    doc([
      {
        id: "think",
        type: "llm",
        instructions: "Help {{who}}.",
        send: "conversation",
        speak: true,
        saveAs: "answer",
        next: "ok",
        onError: "bad",
        ...extra,
      },
      { id: "ok", type: "end", reason: "ok" },
      { id: "bad", type: "end", reason: "bad" },
    ]);

  it("two sentences -> two speaks in one turnId; filler kept out of history", async () => {
    const h = makeHarness();
    let call: any;
    h.effects.llm = (req) => {
      call = req;
      return (async function* () {
        yield { type: "sentence", text: "One moment.", filler: true } as const;
        yield { type: "sentence", text: "First." } as const;
        yield { type: "sentence", text: "Second." } as const;
        yield {
          type: "done",
          text: "First. Second.",
          tokens: { input: 5, output: 3 },
        } as const;
      })();
    };
    const s = session(flow(), h, { initialVars: { who: "ann" } });
    await s.start();
    expect(h.speaks.map((x) => x.text)).toEqual([
      "One moment.",
      "First.",
      "Second.",
    ]);
    expect(new Set(h.speaks.map((x) => x.turnId)).size).toBe(1);
    expect(call.system).toBe("Help ann.");
    expect(call.tools).toBe("none");
    expect(s.variables["answer"]).toBe("First. Second.");
    expect(s.conversation).toEqual([
      { role: "assistant", text: "First. Second." },
    ]);
    const exit = h.traces.find(
      (t) => t.nodeId === "think" && t.phase === "exit",
    );
    expect(exit?.tokens).toEqual({ input: 5, output: 3 });
  });

  it("send message sends only the rendered message; historyTurns slices the conversation", async () => {
    const h = makeHarness();
    const calls: any[] = [];
    h.effects.llm = (req) => {
      calls.push(req);
      return (async function* () {
        yield { type: "done", text: "" } as const;
      })();
    };
    await session(
      flow({ send: "message", message: "Hi {{who}}", speak: false }),
      h,
      { initialVars: { who: "bo" } },
    ).start();
    expect(calls[0].messages).toEqual([{ role: "user", text: "Hi bo" }]);
  });

  it("chat channel sends chat text instead of speaking", async () => {
    const h = makeHarness();
    h.effects.llm = () =>
      (async function* () {
        yield { type: "sentence", text: "filler", filler: true } as const;
        yield { type: "sentence", text: "Hello." } as const;
        yield { type: "done", text: "Hello." } as const;
      })();
    await session(flow(), h, { channel: "chat" }).start();
    expect(h.chats).toEqual(["Hello."]);
    expect(h.speaks).toEqual([]);
  });

  it("chat channel: three sentences become exactly one chat reply", async () => {
    const h = makeHarness();
    h.effects.llm = () =>
      (async function* () {
        yield { type: "sentence", text: "One." } as const;
        yield { type: "sentence", text: "Two." } as const;
        yield { type: "sentence", text: "Three." } as const;
        yield { type: "done", text: "One. Two. Three." } as const;
      })();
    const s = session(flow(), h, { channel: "chat" });
    await s.start();
    expect(h.chats).toEqual(["One. Two. Three."]);
    expect(h.speaks).toEqual([]);
    expect(s.conversation).toEqual([
      { role: "assistant", text: "One. Two. Three." },
    ]);
  });

  it("chat channel: an llm reply carries the turn id", async () => {
    const h = makeHarness();
    h.effects.llm = () =>
      (async function* () {
        yield { type: "sentence", text: "One." } as const;
        yield { type: "sentence", text: "Two." } as const;
        yield { type: "sentence", text: "Three." } as const;
        yield { type: "done", text: "One. Two. Three." } as const;
      })();
    await session(flow(), h, { channel: "chat" }).start();
    expect(h.chatTurnIds).toHaveLength(1);
    expect(h.chatTurnIds[0]?.startsWith("s1:")).toBe(true);
  });

  it("chat channel: a speak node reply carries the turn id", async () => {
    const h = makeHarness();
    await session(
      doc([
        { id: "a", type: "speak", text: "Hello.", next: "e" },
        { id: "e", type: "end", reason: "ok" },
      ]),
      h,
      { channel: "chat" },
    ).start();
    expect(h.chats).toEqual(["Hello."]);
    expect(h.chatTurnIds).toHaveLength(1);
    expect(h.chatTurnIds[0]?.startsWith("s1:")).toBe(true);
  });

  it("chat channel: an end node reply carries the turn id", async () => {
    const h = makeHarness();
    await session(
      doc([{ id: "e", type: "end", reason: "ok", text: "Bye." }]),
      h,
      { channel: "chat" },
    ).start();
    expect(h.chats).toEqual(["Bye."]);
    expect(h.chatTurnIds).toHaveLength(1);
    expect(h.chatTurnIds[0]?.startsWith("s1:")).toBe(true);
  });

  it("stop while a sentence event is already resolved: nothing is spoken", async () => {
    const h = makeHarness();
    let s!: FlowSession;
    h.effects.llm = () => {
      queueMicrotask(() => s.stop());
      let n = 0;
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              Promise.resolve(
                n++ === 0
                  ? {
                      done: false as const,
                      value: { type: "sentence" as const, text: "Late." },
                    }
                  : { done: true as const, value: undefined },
              ),
            return: () =>
              Promise.resolve({ done: true as const, value: undefined }),
          };
        },
      } as any;
    };
    s = session(flow(), h);
    await s.start();
    await flush();
    expect(h.speaks).toEqual([]);
  });

  it("tool events become child trace events of the node's enter", async () => {
    const h = makeHarness();
    h.effects.llm = () =>
      (async function* () {
        yield { type: "tool", name: "lookup", phase: "start" } as const;
        yield {
          type: "tool",
          name: "lookup",
          phase: "end",
          durationMs: 12,
          error: "TOOL_ERROR",
        } as const;
        yield { type: "done", text: "x" } as const;
      })();
    await session(flow({ speak: false }), h).start();
    const enter = h.traces.find(
      (t) => t.nodeId === "think" && t.phase === "enter" && !t.tool,
    )!;
    const kids = h.traces.filter((t) => t.tool === "lookup");
    expect(kids).toHaveLength(2);
    expect(kids.every((k) => k.parent === enter.seq)).toBe(true);
    expect(kids[1]).toMatchObject({ durationMs: 12, error: "TOOL_ERROR" });
  });

  it("an effect error code goes to onError", async () => {
    const h = makeHarness();
    h.effects.llm = () =>
      (async function* () {
        throw Object.assign(new Error("x"), { code: "LLM_TIMEOUT" });
        yield { type: "done", text: "" } as const;
      })();
    const s = session(flow(), h);
    await s.start();
    expect(s.variables["error.think"]).toBe("LLM_TIMEOUT");
    expect(h.ends).toEqual(["bad"]);
  });

  it("a stream that ends without done is LLM_NO_RESULT", async () => {
    const h = makeHarness();
    h.effects.llm = () => (async function* () {})();
    const s = session(flow(), h);
    await s.start();
    expect(s.variables["error.think"]).toBe("LLM_NO_RESULT");
  });
});

describe("route trace carries classifier token counts", () => {
  it("tokens are on the route exit event", async () => {
    const h = makeHarness();
    h.effects.classify = async () => ({
      path: "a",
      tokens: { input: 11, output: 2 },
    });
    const d = doc([
      { id: "l", type: "listen", next: "r", onNoInput: "l" },
      {
        id: "r",
        type: "route",
        paths: [{ id: "a", examples: ["alpha thing"], next: "e" }],
        onNone: "e",
        onError: "e",
      },
      { id: "e", type: "end", reason: "ok" },
    ]);
    const s = session(d, h);
    await s.start();
    await s.onUserText("something else entirely");
    const exit = h.traces.find((t) => t.nodeId === "r" && t.phase === "exit");
    expect(exit).toMatchObject({
      via: "classifier",
      edge: "a",
      tokens: { input: 11, output: 2 },
    });
  });
});

describe("flow_route log", () => {
  const make = () => {
    const logs: { m: string; f: Record<string, unknown> }[] = [];
    const fx = createNodeEffects({
      sessionId: "s1",
      env: {},
      providerFor: () => {
        throw new Error("unused");
      },
      log: (_l, m, f) => logs.push({ m, f }),
    });
    return { logs, fx };
  };

  it("flow_route log carries path, via, latency and token counts, no transcript", () => {
    const { logs, fx } = make();
    fx.trace({
      seq: 3,
      stepSeq: 1,
      nodeId: "topic",
      type: "route",
      phase: "exit",
      edge: "billing",
      via: "classifier",
      durationMs: 12,
      tokens: { input: 11, output: 2 },
      vars: { "last.transcript": "refund please" },
    } as any);
    const route = logs.find((l) => l.m === "flow_route")!;
    expect(route.f).toEqual({
      nodeId: "topic",
      path: "billing",
      via: "classifier",
      latencyMs: 12,
      tokens: { input: 11, output: 2 },
    });
    expect(JSON.stringify(logs)).not.toContain("refund please");
  });

  it("an errored route logs the error code and no path", () => {
    const { logs, fx } = make();
    fx.trace({
      seq: 3,
      stepSeq: 1,
      nodeId: "topic",
      type: "route",
      phase: "exit",
      edge: "again",
      error: "ROUTE_TIMEOUT",
    } as any);
    const route = logs.find((l) => l.m === "flow_route")!;
    expect(route.f.error).toBe("ROUTE_TIMEOUT");
    expect("path" in route.f).toBe(false);
  });
});
