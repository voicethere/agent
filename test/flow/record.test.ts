import { describe, expect, it } from "vitest";
import {
  compileFlow,
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
});
