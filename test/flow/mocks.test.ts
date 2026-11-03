import { describe, expect, it } from "vitest";
import {
  compileFlow,
  createMockEffects,
  FlowSession,
  validateFlow,
  validateMocks,
  type FlowMocks,
} from "../../src/flow/core/index.js";
import { flush, makeHarness } from "./harness.js";

const model = { provider: "openrouter", model: "m", apiKeySecret: "AGENT_K" };

function doc(): any {
  return {
    version: 1,
    start: "call",
    models: { default: model, classifier: { use: "default" } },
    tools: {
      toolSources: [
        { kind: "mcp", name: "crm", url: "https://mcp.example.com/mcp" },
      ],
    },
    nodes: [
      {
        id: "call",
        type: "http",
        method: "GET",
        url: "https://api.example.com/c",
        map: { balance: "/data/balance" },
        next: "pick",
        onError: "bad",
      },
      {
        id: "pick",
        type: "route",
        input: "zzz unrelated",
        paths: [
          { id: "one", examples: ["alpha beta"], next: "tool" },
          { id: "two", examples: ["gamma delta"], next: "end2" },
        ],
        onNone: "bad",
        onError: "bad",
      },
      {
        id: "tool",
        type: "mcp",
        source: "crm",
        tool: "lookup",
        next: "think",
        onError: "bad",
      },
      {
        id: "think",
        type: "llm",
        instructions: "answer",
        send: "message",
        message: "hi",
        speak: true,
        saveAs: "ans",
        next: "end1",
        onError: "bad",
      },
      { id: "end1", type: "end", reason: "ok" },
      { id: "end2", type: "end", reason: "two" },
      { id: "bad", type: "end", reason: "bad" },
    ],
  };
}

function flowOf(d: any) {
  const v = validateFlow(d);
  expect(v.errors).toEqual([]);
  return v.flow!;
}

async function run(mocks: FlowMocks, pick?: any) {
  const h = makeHarness();
  const flow = flowOf(doc());
  const fx = createMockEffects(h.effects, mocks, { pick });
  const s = new FlowSession(compileFlow(flow), fx, {
    sessionId: "s1",
    channel: "voice",
  });
  await s.start();
  await flush();
  return { h, s };
}

const full: FlowMocks = {
  version: 1,
  nodes: {
    call: [
      { name: "ok", http: { status: 200, body: { data: { balance: 5 } } } },
    ],
    pick: [{ name: "p", route: { path: "one" } }],
    tool: [{ name: "t", mcp: { result: { id: 1 } } }],
    think: [{ name: "l", llm: { text: "Mock answer." } }],
  },
};

describe("validateMocks", () => {
  const flow = flowOf(doc());
  it("accepts matching cases", () => {
    expect(validateMocks(full, flow).ok).toBe(true);
  });
  it("rejects an unknown node", () => {
    const r = validateMocks({ version: 1, nodes: { nope: [] } }, flow);
    expect(r.errors.map((e) => e.code)).toEqual(["MOCK_UNKNOWN_NODE"]);
  });
  it("rejects a case kind that does not match the node type", () => {
    const r = validateMocks(
      { version: 1, nodes: { call: [{ name: "x", mcp: { result: 1 } }] } },
      flow,
    );
    expect(r.errors.map((e) => e.code)).toEqual(["MOCK_KIND_MISMATCH"]);
  });
  it("rejects a route path the node does not declare", () => {
    const r = validateMocks(
      { version: 1, nodes: { pick: [{ name: "x", route: { path: "zz" } }] } },
      flow,
    );
    expect(r.errors.map((e) => e.code)).toEqual(["MOCK_UNKNOWN_PATH"]);
  });
});

describe("createMockEffects", () => {
  it("runs a whole flow on mocks without keys or network", async () => {
    const { h } = await run(full);
    expect(h.ends).toEqual(["ok"]);
    expect(h.speaks.map((x) => x.text)).toEqual(["Mock answer."]);
  });

  it("marks a mocked classifier route with via mock", async () => {
    const { h } = await run(full);
    const exit = h.traces.find(
      (e) => e.nodeId === "pick" && e.phase === "exit",
    );
    expect(exit?.via).toBe("mock");
    expect(exit?.edge).toBe("one");
  });

  it("an http error case drives onError", async () => {
    const { h } = await run({
      ...full,
      nodes: {
        ...full.nodes,
        call: [{ name: "e", http: { error: "HTTP_TIMEOUT" } }],
      },
    });
    expect(h.ends).toEqual(["bad"]);
  });

  it("an mcp isError case drives onError", async () => {
    const { h } = await run({
      ...full,
      nodes: {
        ...full.nodes,
        tool: [{ name: "e", mcp: { isError: true, content: "boom" } }],
      },
    });
    expect(h.ends).toEqual(["bad"]);
  });

  it("a node without a case fails with MOCK_MISSING on its onError", async () => {
    const nodes = { ...full.nodes };
    delete (nodes as any).tool;
    const { h } = await run({ version: 1, nodes });
    expect(h.ends).toEqual(["bad"]);
    const exit = h.traces.find(
      (e) => e.nodeId === "tool" && e.phase === "exit",
    );
    expect(exit?.error).toBe("MOCK_MISSING");
  });

  it("pick chooses a named case", async () => {
    const { h } = await run(
      {
        ...full,
        nodes: {
          ...full.nodes,
          pick: [
            { name: "one", route: { path: "one" } },
            { name: "two", route: { path: "two" } },
          ],
        },
      },
      (_id: string, cases: any[]) =>
        cases.find((c) => c.name === "two") ?? cases[0],
    );
    expect(h.ends).toEqual(["two"]);
  });
});

describe("createFlowAgent({ mocks })", () => {
  it("starts without any key or provider module", async () => {
    const { createFlowAgent } =
      await import("../../src/flow/create-flow-agent.js");
    const h = createFlowAgent({ flow: doc(), mocks: full, env: () => ({}) });
    expect(() => h.onAgentStart!({} as any)).not.toThrow();
  });

  it("rejects mocks that do not fit the flow with FLOW_MOCKS_INVALID", async () => {
    const { createFlowAgent } =
      await import("../../src/flow/create-flow-agent.js");
    expect(() =>
      createFlowAgent({
        flow: doc(),
        mocks: { version: 1, nodes: { nope: [] } },
      }),
    ).toThrowError(expect.objectContaining({ code: "FLOW_MOCKS_INVALID" }));
  });

  it("does not start tool sources", async () => {
    const { createFlowAgent } =
      await import("../../src/flow/create-flow-agent.js");
    const h = createFlowAgent({
      flow: doc(),
      mocks: full,
      env: () => ({}),
      sourceFactory: () => {
        throw new Error("network");
      },
    });
    expect(() => h.onAgentStart!({} as any)).not.toThrow();

    // drive a session through the handlers, on mocks only
    const base = makeHarness();
    const h2 = createFlowAgent({
      flow: doc(),
      mocks: full,
      env: () => ({}),
      sourceFactory: () => {
        throw new Error("network");
      },
      effectsFactory: () => base.effects,
    });
    h2.onAgentStart!({} as any);
    h2.onSessionStart!({ sessionId: "s9" } as any);
    h2.onUserSpeechFinal!({ sessionId: "s9", text: "hello" } as any);
    await flush();
    await flush();
    expect(base.ends).toEqual(["ok"]);
    expect(base.speaks.map((x) => x.text)).toEqual(["Mock answer."]);
    h2.onSessionEnd!({ sessionId: "s9" } as any);
  });
});
