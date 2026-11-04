import { describe, expect, it } from "vitest";
import { cancelReason, wasCancelled } from "../../src/flow/core/abort.js";
import {
  compileFlow,
  createMockEffects,
  validateMocks,
  FlowSession,
  validateFlow,
} from "../../src/flow/core/index.js";
import { createMockRecorder, wrapRecording } from "../../src/flow/record.js";
import { flush, makeHarness } from "./harness.js";

const SECRET = "supersecret-token-1";

function flow(): any {
  return {
    version: 1,
    start: "call",
    models: {
      default: { provider: "openrouter", model: "m", apiKeySecret: "AGENT_X" },
    },
    nodes: [
      {
        id: "call",
        type: "http",
        method: "GET",
        url: "https://api.example.com/c",
        map: { note: "/note" },
        next: "end",
        onError: "end",
      },
      { id: "end", type: "end", reason: "done" },
    ],
  };
}

describe("wrapRecording", () => {
  it("records a response as a case and keeps secret values out of the file", async () => {
    const h = makeHarness();
    h.effects.http = async () => ({
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": "sid=abc",
        authorization: `Bearer ${SECRET}`,
      },
      body: { note: `token is ${SECRET}`, mail: "jane@example.com" },
    });
    const rec = createMockRecorder();
    const fx = wrapRecording(h.effects, rec.sink, {
      env: { AGENT_X: SECRET },
    });
    const s = new FlowSession(compileFlow(validateFlow(flow()).flow!), fx, {
      sessionId: "s1",
      channel: "voice",
    });
    await s.start();
    await flush();
    const mocks = rec.mocks();
    const text = JSON.stringify(mocks);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("jane@example.com");
    expect(text).not.toContain("sid=abc");
    expect(mocks.nodes["call"]![0]!.name).toBe("recorded-1");
    expect((mocks.nodes["call"]![0]!.http as any).status).toBe(200);
    expect(h.ends).toEqual(["done"]);
  });

  it("records a timeout as an error case and rethrows", async () => {
    const h = makeHarness();
    h.effects.http = async () => {
      const e = new Error("t") as Error & { code: string };
      e.code = "HTTP_TIMEOUT";
      throw e;
    };
    const rec = createMockRecorder();
    const fx = wrapRecording(h.effects, rec.sink, { env: {} });
    const s = new FlowSession(compileFlow(validateFlow(flow()).flow!), fx, {
      sessionId: "s1",
      channel: "voice",
    });
    await s.start();
    await flush();
    expect(rec.mocks().nodes["call"]![0]!.http).toEqual({
      error: "HTTP_TIMEOUT",
    });
  });

  it("a result after abort is recorded as the timeout case", async () => {
    const h = makeHarness();
    const d: any = flow();
    d.nodes[0] = { ...d.nodes[0], timeoutMs: 100, onError: "say" };
    d.nodes.splice(1, 0, {
      id: "say",
      type: "speak",
      text: "sorry",
      next: "end",
    });
    let release!: () => void;
    h.effects.http = () =>
      new Promise((resolve) => {
        release = () => resolve({ status: 200, body: { note: "late" } });
      });
    const rec = createMockRecorder();
    const fx = wrapRecording(h.effects, rec.sink, { env: {} });
    const s = new FlowSession(compileFlow(validateFlow(d).flow!), fx, {
      sessionId: "s1",
      channel: "voice",
    });
    const started = s.start();
    await flush();
    h.advance(150);
    await started;
    await flush();
    release();
    await flush();
    expect(h.speaks.map((x) => x.text)).toEqual(["sorry"]);
    const m = rec.mocks();
    expect(m.nodes["say"]).toBeUndefined();
    expect(m.nodes["call"]![0]!.http).toEqual({ error: "HTTP_TIMEOUT" });
    expect(validateMocks(m, validateFlow(d).flow!).ok).toBe(true);
  });

  it("a post-abort mcp result is recorded as MCP_TIMEOUT", async () => {
    const h = makeHarness();
    const rec = createMockRecorder();
    const fx = wrapRecording(h.effects, rec.sink, { env: {} });
    fx.trace({
      seq: 1,
      stepSeq: 1,
      nodeId: "tool",
      type: "mcp",
      phase: "enter",
    });
    h.effects.tool = async () => ({ content: "{}" });
    const ctl = new AbortController();
    ctl.abort();
    await fx.tool("crm", "lookup", {}, ctl.signal);
    const m = rec.mocks();
    expect(m.nodes["tool"]![0]!.mcp).toEqual({ error: "MCP_TIMEOUT" });
    expect(validateMocks(m, validateFlow(chainFlow()).flow!).ok).toBe(true);
  });

  it("a post-abort llm result is recorded as LLM_TIMEOUT", async () => {
    const h = makeHarness();
    const rec = createMockRecorder();
    const fx = wrapRecording(h.effects, rec.sink, { env: {} });
    fx.trace({
      seq: 1,
      stepSeq: 1,
      nodeId: "think",
      type: "llm",
      phase: "enter",
    });
    h.effects.llm = async function* () {
      yield { type: "done" as const, text: "late" };
    };
    const ctl = new AbortController();
    ctl.abort();
    for await (const _ of fx.llm({} as any, ctl.signal)) void _;
    const m = rec.mocks();
    expect(m.nodes["think"]![0]!.llm).toEqual({ error: "LLM_TIMEOUT" });
    expect(validateMocks(m, validateFlow(chainFlow()).flow!).ok).toBe(true);
  });

  it("a post-abort classify result is recorded as ROUTE_TIMEOUT", async () => {
    const h = makeHarness();
    const rec = createMockRecorder();
    const fx = wrapRecording(h.effects, rec.sink, { env: {} });
    fx.trace({
      seq: 1,
      stepSeq: 1,
      nodeId: "pick",
      type: "route",
      phase: "enter",
    });
    h.effects.classify = async () => ({ path: "billing" });
    const ctl = new AbortController();
    ctl.abort();
    await fx.classify({} as any, ctl.signal);
    const m = rec.mocks();
    expect(m.nodes["pick"]![0]!.route).toEqual({ error: "ROUTE_TIMEOUT" });
    expect(validateMocks(m, validateFlow(chainFlow()).flow!).ok).toBe(true);
  });

  function routeFlow(): any {
    return {
      version: 1,
      start: "pick",
      models: {
        default: {
          provider: "openrouter",
          model: "m",
          apiKeySecret: "AGENT_X",
        },
        classifier: { use: "default" },
      },
      nodes: [
        {
          id: "pick",
          type: "route",
          input: "zzz unrelated",
          paths: [
            { id: "billing", examples: ["alpha beta"], next: "ok" },
            { id: "other", examples: ["gamma delta"], next: "ok" },
          ],
          onNone: "nn",
          onError: "ee",
        },
        { id: "ok", type: "end", reason: "ok" },
        { id: "nn", type: "end", reason: "none" },
        { id: "ee", type: "end", reason: "error" },
      ],
    };
  }

  /** Records a live run with `classify`, then replays the recording and compares the outcome. */
  async function recordAndReplay(
    classify: (signal: AbortSignal) => Promise<{ path: string }>,
    drive?: (
      h: ReturnType<typeof makeHarness>,
      s: FlowSession,
    ) => Promise<void>,
    routeDoc: any = routeFlow(),
  ) {
    const flowDoc = validateFlow(routeDoc).flow!;
    const h = makeHarness();
    h.effects.classify = (_req, signal) => classify(signal);
    const rec = createMockRecorder();
    const fx = wrapRecording(h.effects, rec.sink, { env: {} });
    const s = new FlowSession(compileFlow(flowDoc), fx, {
      sessionId: "s1",
      channel: "voice",
    });
    if (drive) await drive(h, s);
    else {
      await s.start();
      await flush();
    }
    const mocks = rec.mocks();
    expect(validateMocks(mocks, flowDoc).ok).toBe(true);
    const h2 = makeHarness();
    const s2 = new FlowSession(
      compileFlow(flowDoc),
      createMockEffects(h2.effects, mocks),
      { sessionId: "s2", channel: "voice" },
    );
    await s2.start();
    await flush();
    return {
      mocks,
      live: h,
      replay: h2,
      liveVars: s.variables,
      replayVars: s2.variables,
    };
  }

  it("classifier none records path none and replays to onNone", async () => {
    const r = await recordAndReplay(async () => ({ path: "none" }));
    expect(r.mocks.nodes["pick"]![0]!.route).toEqual({ path: "none" });
    expect(r.live.ends).toEqual(["none"]);
    expect(r.replay.ends).toEqual(["none"]);
  });

  it("LLM_CLASSIFIER_NO_CALL records the code and replays to onError with the same code", async () => {
    const r = await recordAndReplay(async () => {
      throw Object.assign(new Error("no call"), {
        code: "LLM_CLASSIFIER_NO_CALL",
      });
    });
    expect(r.mocks.nodes["pick"]![0]!.route).toEqual({
      error: "LLM_CLASSIFIER_NO_CALL",
    });
    expect(r.live.ends).toEqual(["error"]);
    expect(r.replay.ends).toEqual(["error"]);
    expect(r.replayVars["error.pick"]).toBe("LLM_CLASSIFIER_NO_CALL");
    expect(r.liveVars["error.pick"]).toBe("LLM_CLASSIFIER_NO_CALL");
  });

  it("uncoded classifier throw records ROUTE_ERROR", async () => {
    const r = await recordAndReplay(async () => {
      throw new Error("boom");
    });
    expect(r.mocks.nodes["pick"]![0]!.route).toEqual({ error: "ROUTE_ERROR" });
    expect(r.replay.ends).toEqual(["error"]);
    expect(r.replayVars["error.pick"]).toBe("ROUTE_ERROR");
  });

  it("classifier abort at timeout records ROUTE_TIMEOUT", async () => {
    const h = makeHarness();
    const rec = createMockRecorder();
    const fx = wrapRecording(h.effects, rec.sink, { env: {} });
    fx.trace({
      seq: 1,
      stepSeq: 1,
      nodeId: "pick",
      type: "route",
      phase: "enter",
    });
    h.effects.classify = (_req, signal) =>
      new Promise((_res, rej) =>
        signal.addEventListener("abort", () =>
          rej(Object.assign(new Error("aborted"), { code: "ABORT_ERR" })),
        ),
      );
    const ctl = new AbortController();
    const p = fx.classify({} as any, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toThrow("aborted");
    expect(rec.mocks().nodes["pick"]![0]!.route).toEqual({
      error: "ROUTE_TIMEOUT",
    });
  });

  const hangUntilAbort = (signal: AbortSignal) =>
    new Promise<{ path: string }>((_res, rej) =>
      signal.addEventListener("abort", () =>
        rej(Object.assign(new Error("aborted"), { code: "ABORT_ERR" })),
      ),
    );

  async function stopDuringClassify(
    classify: (signal: AbortSignal) => Promise<{ path: string }>,
  ) {
    const flowDoc = validateFlow(routeFlow()).flow!;
    const h = makeHarness();
    h.effects.classify = (_req, signal) => classify(signal);
    const rec = createMockRecorder();
    const fx = wrapRecording(h.effects, rec.sink, { env: {} });
    const s = new FlowSession(compileFlow(flowDoc), fx, {
      sessionId: "s1",
      channel: "voice",
    });
    void s.start();
    await flush();
    s.stop();
    await flush();
    expect(validateMocks(rec.mocks(), flowDoc).ok).toBe(true);
    return rec.mocks();
  }

  it("a classify cancelled by stop records nothing", async () => {
    const m = await stopDuringClassify(hangUntilAbort);
    expect(m.nodes["pick"]).toBeUndefined();
  });

  it("a classify that resolves after stop records nothing", async () => {
    const m = await stopDuringClassify(
      (signal) =>
        new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve({ path: "billing" })),
        ),
    );
    expect(m.nodes["pick"]).toBeUndefined();
  });

  it("http / mcp / llm aborted with cancelReason() record nothing", async () => {
    const h = makeHarness();
    const rec = createMockRecorder();
    const fx = wrapRecording(h.effects, rec.sink, { env: {} });
    const enter = (nodeId: string, type: any) =>
      fx.trace({ seq: 1, stepSeq: 1, nodeId, type, phase: "enter" });
    const abortedSignal = () => {
      const ctl = new AbortController();
      ctl.abort(cancelReason());
      return ctl.signal;
    };
    enter("call", "http");
    h.effects.http = async () => ({ status: 200, body: {} });
    await fx.http(
      { method: "GET", url: "https://x.example" } as any,
      abortedSignal(),
    );
    h.effects.http = async () => {
      throw Object.assign(new Error("t"), { code: "HTTP_TIMEOUT" });
    };
    await expect(
      fx.http(
        { method: "GET", url: "https://x.example" } as any,
        abortedSignal(),
      ),
    ).rejects.toThrow("t");
    enter("tool", "mcp");
    h.effects.tool = async () => ({ content: "{}" });
    await fx.tool("crm", "lookup", {}, abortedSignal());
    enter("think", "llm");
    h.effects.llm = async function* () {
      yield { type: "done" as const, text: "late" };
    };
    for await (const _ of fx.llm({} as any, abortedSignal())) void _;
    expect(rec.mocks().nodes).toEqual({});
  });

  it("classifier timeout round trip", async () => {
    const d = routeFlow();
    d.nodes[0].timeoutMs = 1000;
    const r = await recordAndReplay(
      hangUntilAbort,
      async (h, s) => {
        const started = s.start();
        await flush();
        h.advance(1000);
        await started;
        await flush();
      },
      d,
    );
    expect(r.mocks.nodes["pick"]).toEqual([
      { name: "recorded-1", route: { error: "ROUTE_TIMEOUT" } },
    ]);
    expect(r.replay.ends).toEqual(["error"]);
    expect(r.replayVars["error.pick"]).toBe("ROUTE_TIMEOUT");
  });

  it("timeout then stop records the timeout once", async () => {
    const d = routeFlow();
    d.nodes[0].timeoutMs = 1000;
    const r = await recordAndReplay(
      hangUntilAbort,
      async (h, s) => {
        const started = s.start();
        await flush();
        h.advance(1000);
        await started;
        s.stop();
        await flush();
      },
      d,
    );
    expect(r.mocks.nodes["pick"]).toHaveLength(1);
    expect(r.mocks.nodes["pick"]![0]!.route).toEqual({
      error: "ROUTE_TIMEOUT",
    });
  });

  it("wasCancelled is true only for the interpreter's cancel reason", () => {
    const a = new AbortController();
    expect(wasCancelled(a.signal)).toBe(false);
    a.abort(cancelReason());
    expect(wasCancelled(a.signal)).toBe(true);
    const b = new AbortController();
    b.abort();
    expect(wasCancelled(b.signal)).toBe(false);
    const c = new AbortController();
    c.abort(new DOMException("x", "AbortError"));
    expect(wasCancelled(c.signal)).toBe(false);
  });

  function chainFlow(): any {
    return {
      version: 1,
      start: "tool",
      models: {
        default: {
          provider: "openrouter",
          model: "m",
          apiKeySecret: "AGENT_X",
        },
        classifier: { use: "default" },
      },
      tools: {
        toolSources: [
          { kind: "mcp", name: "crm", url: "https://mcp.example.com/mcp" },
        ],
      },
      nodes: [
        {
          id: "tool",
          type: "mcp",
          source: "crm",
          tool: "t",
          next: "think",
          onError: "end",
        },
        {
          id: "think",
          type: "llm",
          instructions: "x",
          send: "message",
          message: "hi",
          speak: true,
          next: "pick",
          onError: "end",
        },
        {
          id: "pick",
          type: "route",
          input: "zzz unrelated",
          paths: [
            { id: "billing", examples: ["alpha beta"], next: "end" },
            { id: "other", examples: ["gamma delta"], next: "end" },
          ],
          onNone: "end",
          onError: "end",
        },
        { id: "end", type: "end", reason: "done" },
      ],
    };
  }

  it("records mcp, llm and route cases that validateMocks accepts", async () => {
    const h = makeHarness();
    h.effects.tool = async () => ({ content: `{"k":"${SECRET}"}` });
    h.effects.llm = async function* () {
      yield { type: "done" as const, text: `the key is ${SECRET}` };
    };
    h.effects.classify = async () => ({ path: "billing" });
    const rec = createMockRecorder();
    const fx = wrapRecording(h.effects, rec.sink, { env: { AGENT_X: SECRET } });
    const flowDoc = validateFlow(chainFlow()).flow!;
    const s = new FlowSession(compileFlow(flowDoc), fx, {
      sessionId: "s1",
      channel: "voice",
    });
    await s.start();
    await flush();
    const m = rec.mocks();
    expect(JSON.stringify(m)).not.toContain(SECRET);
    expect(m.nodes["tool"]![0]!.name).toBe("recorded-1");
    expect(m.nodes["tool"]![0]!.mcp).toBeDefined();
    expect(m.nodes["think"]![0]!.name).toBe("recorded-1");
    expect(m.nodes["think"]![0]!.llm).toBeDefined();
    expect(m.nodes["pick"]![0]!.route).toEqual({ path: "billing" });
    expect(validateMocks(m, flowDoc).ok).toBe(true);
  });

  it("records a plain-text mcp result as a string", async () => {
    const h = makeHarness();
    h.effects.tool = async () => ({ content: "hello" });
    h.effects.llm = async function* () {
      yield { type: "done" as const, text: "x" };
    };
    h.effects.classify = async () => ({ path: "other" });
    const rec = createMockRecorder();
    const fx = wrapRecording(h.effects, rec.sink, { env: {} });
    const s = new FlowSession(
      compileFlow(validateFlow(chainFlow()).flow!),
      fx,
      { sessionId: "s1", channel: "voice" },
    );
    await s.start();
    await flush();
    expect(rec.mocks().nodes["tool"]![0]!.mcp).toEqual({ result: "hello" });
  });
});
