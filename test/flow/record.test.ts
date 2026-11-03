import { describe, expect, it } from "vitest";
import {
  compileFlow,
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

  it("a late http result is recorded under its own node", async () => {
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
    expect((m.nodes["call"]![0]!.http as any).status).toBe(200);
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
