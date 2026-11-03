import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFlowAgent } from "../../src/flow/create-flow-agent.js";
import { openai } from "../../src/llm/openai.js";
import {
  SESSION_START_INIT_DELAY_ENABLED_ENV,
  defineAgent,
  resetAgentIpcStateForTests,
} from "../../src/runtime.js";
import { installProcessMessageCapture } from "../helpers/process-mock.js";
import { baseFlow } from "./fixtures.js";

type Msg = Record<string, unknown>;
type Capture = ReturnType<typeof installProcessMessageCapture>;

const SESSION = "peer-1";

function flowDoc(): any {
  return {
    version: 1,
    start: "greet",
    models: {
      default: {
        provider: "openrouter",
        model: "amazon/nova-micro-v1",
        apiKeySecret: "AGENT_K",
      },
    },
    nodes: [
      {
        id: "greet",
        type: "speak",
        text: "Hello, billing or support?",
        next: "ask",
      },
      { id: "ask", type: "listen", next: "topic", onNoInput: "ask" },
      {
        id: "topic",
        type: "route",
        paths: [
          {
            id: "billing",
            examples: ["why was I charged twice"],
            keywords: ["refund"],
            next: "bill",
          },
          {
            id: "support",
            examples: ["my app is broken"],
            keywords: ["broken"],
            next: "supp",
          },
        ],
        onNone: "again",
        onError: "again",
      },
      { id: "again", type: "speak", text: "Sorry?", next: "ask" },
      { id: "bill", type: "speak", text: "Billing it is.", next: "bye" },
      { id: "supp", type: "speak", text: "Support it is.", next: "bye" },
      { id: "bye", type: "end", reason: "done" },
    ],
  };
}

const fakeProvider = {
  id: "openai" as const,
  stream() {
    throw new Error("the classifier must not run for a rule hit");
  },
};

describe("createFlowAgent", () => {
  let capture: Capture;

  beforeEach(() => {
    resetAgentIpcStateForTests();
    process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = "false";
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    capture = installProcessMessageCapture();
  });

  afterEach(async () => {
    capture.emit({ type: "session_end", sessionId: SESSION });
    // let cancelled speaks settle and log before process.send is restored
    await new Promise((r) => setTimeout(r, 50));
    capture.restore();
    resetAgentIpcStateForTests();
    delete process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
    delete process.env.__CHILD_BUNDLE_PATH__;
  });

  const sent = (type?: string): Msg[] => {
    const all = capture.send.mock.calls.map((c) => c[0] as Msg);
    return type ? all.filter((m) => m.type === type) : all;
  };

  function boot(doc: unknown = flowDoc()) {
    const handlers = createFlowAgent({
      flow: doc,
      provider: fakeProvider,
      env: () => ({}),
    });
    defineAgent(handlers);
    capture.emit({
      type: "session_start",
      sessionId: SESSION,
      env: { SESSION_ID: SESSION },
      speakControlAvailable: true,
    });
    return handlers;
  }
  const say = (text: string) =>
    capture.emit({
      type: "speech_event",
      sessionId: SESSION,
      event: { type: "user_speech_final", text, utteranceId: "u1" },
    });
  const played = (requestId: unknown) =>
    capture.emit({
      type: "speak_result",
      sessionId: SESSION,
      requestId,
      status: "played",
      playedMs: 100,
    });

  it("an invalid flow throws FLOW_INVALID with the first issues", () => {
    const bad = baseFlow();
    bad.nodes[0].next = "ghost";
    let caught: any;
    try {
      createFlowAgent({ flow: bad, provider: fakeProvider });
    } catch (e) {
      caught = e;
    }
    expect(caught.code).toBe("FLOW_INVALID");
    expect(caught.message).toContain("ghost");
  });

  it("an unregistered provider names the import to add", () => {
    let caught: any;
    try {
      createFlowAgent({ flow: flowDoc(), providers: [] });
    } catch (e) {
      caught = e;
    }
    expect(caught.code).toBe("FLOW_INVALID");
    expect(caught.message).toContain("@voicethere/agent/llm/openai");
    expect(() =>
      createFlowAgent({ flow: flowDoc(), providers: [openai] }),
    ).not.toThrow();
  });

  it("session start returns before the greeting finishes playing", async () => {
    boot();
    await vi.waitFor(() => expect(sent("session_start_ack")).toHaveLength(1));
    expect(sent("speak").map((m) => m.text)).toEqual([
      "Hello, billing or support?",
    ]);
    // no speak_result was sent: the greeting is still pending
    expect(sent("speak")).toHaveLength(1);
  });

  it("handlers return without a promise even when speech never completes", () => {
    const handlers = createFlowAgent({
      flow: flowDoc(),
      provider: fakeProvider,
      env: () => ({}),
      effectsFactory: () => ({
        speak: () => ({ done: new Promise(() => {}), cancel() {} }),
        http: () => new Promise(() => {}),
        tool: () => new Promise(() => {}),
        llm: () => (async function* () {})(),
        classify: () => new Promise(() => {}),
        end() {},
        trace() {},
        clock: {
          now: () => Date.now(),
          setTimeout: (fn, ms) => {
            const t = setTimeout(fn, ms);
            return () => clearTimeout(t);
          },
        },
      }),
    });
    const ctx = { sessionId: "direct-1" } as any;
    expect(handlers.onSessionStart!(ctx)).toBeUndefined();
    expect(
      handlers.onUserSpeechFinal!({ sessionId: "direct-1", text: "refund" }),
    ).toBeUndefined();
    expect(
      handlers.onDataChannelMessage!({
        sessionId: "direct-1",
        message: { type: "chat", text: "refund" },
      } as any),
    ).toBeUndefined();
    handlers.onSessionEnd!({ sessionId: "direct-1" });
  });

  it("a voice call: greeting, keyword route, reply; flow logs carry no transcript", async () => {
    boot();
    await vi.waitFor(() => expect(sent("speak")).toHaveLength(1));
    played(sent("speak")[0]!.requestId);
    await vi.waitFor(() =>
      expect(
        sent("log").some(
          (m) =>
            m.message === "flow_step" &&
            (m.fields as Msg).nodeId === "ask" &&
            (m.fields as Msg).phase === "enter",
        ),
      ).toBe(true),
    );
    say("I would like a refund please");
    await vi.waitFor(() => expect(sent("speak")).toHaveLength(2));
    expect(sent("speak")[1]!.text).toBe("Billing it is.");

    const lines = sent("log").filter(
      (m) => m.message === "flow_step" || m.message === "flow_route",
    );
    expect(lines.length).toBeGreaterThan(4);
    const text = JSON.stringify(lines);
    expect(text).not.toContain("refund please");
    expect(text).not.toContain("I would like");
    const route = lines.find((m) => m.message === "flow_route")!;
    expect(route.fields).toMatchObject({
      nodeId: "topic",
      path: "billing",
      via: "rule",
    });
    const names = lines
      .filter(
        (m) =>
          (m.fields as Msg).nodeId === "ask" && (m.fields as Msg).varsChanged,
      )
      .flatMap((m) => (m.fields as Msg).varsChanged as string[]);
    expect(names).toContain("last.transcript");
  });

  it("a chat message is answered over the data channel", async () => {
    boot();
    await vi.waitFor(() => expect(sent("speak")).toHaveLength(1));
    played(sent("speak")[0]!.requestId);
    await vi.waitFor(() =>
      expect(
        sent("log").some(
          (m) =>
            m.message === "flow_step" &&
            (m.fields as Msg).nodeId === "ask" &&
            (m.fields as Msg).phase === "enter",
        ),
      ).toBe(true),
    );
    capture.emit({
      type: "data_channel_message",
      sessionId: SESSION,
      payload: JSON.stringify({ type: "chat", text: "my app is broken" }),
    });
    await vi.waitFor(() =>
      expect(
        sent("send_to_client").map((m) => (m.payload as Msg).type),
      ).toContain("chat_reply"),
    );
    const reply = sent("send_to_client")
      .map((m) => m.payload as Msg)
      .find((p) => p.type === "chat_reply")!;
    expect(reply.text).toBe("Support it is.");
  });
});
