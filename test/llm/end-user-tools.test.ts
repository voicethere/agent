import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLlmAgent } from "../../src/llm/agent/create-llm-agent.js";
import { defineTool } from "../../src/llm/agent/define-tool.js";
import { endUserTools } from "../../src/llm/end-user/end-user-tools.js";
import {
  ToolRegistry,
  VERIFIED_USER_REQUIRED_MESSAGE,
} from "../../src/llm/mcp/tool-registry.js";
import type {
  LlmProvider,
  LlmRequest,
  LlmStreamEvent,
} from "../../src/llm/types.js";
import {
  SESSION_START_INIT_DELAY_ENABLED_ENV,
  defineAgent,
  resetAgentIpcStateForTests,
} from "../../src/runtime.js";
import { installProcessMessageCapture } from "../helpers/process-mock.js";

const verified = { id: "u1", verified: true };
const unverified = { id: "u1", verified: false };
const ctx = { timeoutMs: 1_000, sessionId: "s1" };

function guarded() {
  return defineTool({
    name: "order_status",
    description: "d",
    inputSchema: { type: "object" },
    requiresVerifiedUser: true,
    handler: (_a, c) => `user=${c.user?.id}`,
  });
}

describe("ToolRegistry requiresVerifiedUser", () => {
  it("hides the tool without a verified user and shows it with one", () => {
    const reg = new ToolRegistry();
    reg.addCustomTool(guarded());
    expect(reg.list()).toEqual([]);
    expect(reg.list({ user: unverified })).toEqual([]);
    expect(reg.list({ user: verified }).map((t) => t.spec.name)).toEqual([
      "order_status",
    ]);
  });

  it("refuses a forced call while unverified", async () => {
    const reg = new ToolRegistry();
    reg.addCustomTool(guarded());
    const r = await reg.call("order_status", {}, { ...ctx, user: unverified });
    expect(r).toEqual({
      isError: true,
      content: VERIFIED_USER_REQUIRED_MESSAGE,
    });
    const none = await reg.call("order_status", {}, ctx);
    expect(none.isError).toBe(true);
  });

  it("the handler sees the session user, not an id in the model input", async () => {
    const reg = new ToolRegistry();
    reg.addCustomTool(guarded());
    const r = await reg.call(
      "order_status",
      { userId: "456", user: { id: "456" } },
      { ...ctx, user: verified },
    );
    expect(r).toEqual({ isError: false, content: "user=u1" });
  });
});

describe("endUserTools", () => {
  it("get_previous_conversations reads history for the session, ignoring a model-supplied user", async () => {
    const load = vi.fn().mockResolvedValue({
      ok: true,
      conversations: [
        {
          sessionStartedAt: "2026-11-01T10:00:00Z",
          turns: [{ role: "user", text: "router is down", at: "t" }],
        },
      ],
    });
    const reg = new ToolRegistry();
    for (const t of endUserTools(load)) reg.addCustomTool(t);
    const r = await reg.call(
      "get_previous_conversations",
      { userId: "456", limit: 2 },
      { ...ctx, user: verified },
    );
    expect(load).toHaveBeenCalledWith("s1", { limit: 2 });
    expect(r.content).toContain("user: router is down");
  });

  it("get_previous_conversations reports unavailable history", async () => {
    const reg = new ToolRegistry();
    for (const t of endUserTools(async () => ({
      ok: false,
      conversations: [],
    })))
      reg.addCustomTool(t);
    const r = await reg.call(
      "get_previous_conversations",
      {},
      { ...ctx, user: verified },
    );
    expect(r.content).toContain("unavailable");
  });

  it("get_current_user returns the session user", async () => {
    const reg = new ToolRegistry();
    for (const t of endUserTools()) reg.addCustomTool(t);
    const r = await reg.call(
      "get_current_user",
      {},
      { ...ctx, user: { ...verified, attributes: { plan: "pro" } } },
    );
    expect(JSON.parse(r.content)).toEqual({
      id: "u1",
      verified: true,
      attributes: { plan: "pro" },
    });
  });
});

describe("createLlmAgent endUserTools", () => {
  let capture: ReturnType<typeof installProcessMessageCapture>;
  beforeEach(() => {
    resetAgentIpcStateForTests();
    process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = "false";
    capture = installProcessMessageCapture();
  });
  afterEach(() => {
    capture.emit({ type: "session_end", sessionId: "p1" });
    capture.emit({ type: "session_end", sessionId: "A" });
    capture.restore();
    resetAgentIpcStateForTests();
    delete process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
  });

  it("offers the verified-user tool only after user_identified", async () => {
    const requests: LlmRequest[] = [];
    const provider: LlmProvider = {
      id: "openai",
      stream(req) {
        requests.push({ ...req, signal: undefined });
        const events: LlmStreamEvent[] = [
          { type: "text_delta", text: "ok." },
          {
            type: "done",
            stopReason: "end",
            text: "ok.",
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        ];
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
    };
    defineAgent(
      createLlmAgent({
        config: {
          version: 1,
          provider: "openai",
          apiKeySecret: "AGENT_TEST_KEY",
          speech: { coalesceMs: 0 },
        },
        systemPrompt: "t",
        provider,
        endUserTools: true,
        env: () => ({ AGENT_TEST_KEY: "k" }),
      }),
    );
    const sent = (type: string) =>
      capture.send.mock.calls
        .map((c) => c[0] as { type: string })
        .filter((m) => m.type === type);
    capture.emit({
      type: "session_start",
      sessionId: "p1",
      env: { SESSION_ID: "p1" },
      endUser: unverified,
    });
    await vi.waitFor(() => expect(sent("session_start_ack")).toHaveLength(1));
    capture.emit({
      type: "speech_event",
      sessionId: "p1",
      event: { type: "user_speech_final", text: "hi" },
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.tools.map((t) => t.name)).toEqual(["get_current_user"]);

    capture.emit({
      type: "user_identified",
      sessionId: "p1",
      endUser: verified,
    });
    capture.emit({
      type: "speech_event",
      sessionId: "p1",
      event: { type: "user_speech_final", text: "again" },
    });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]!.tools.map((t) => t.name).sort()).toEqual([
      "get_current_user",
      "get_previous_conversations",
    ]);
  });

  async function boot(over: { spread?: boolean } = {}) {
    const requests: LlmRequest[] = [];
    const provider: LlmProvider = {
      id: "openai",
      stream(req) {
        requests.push({ ...req, signal: undefined });
        return (async function* () {
          yield { type: "text_delta", text: "ok." } as LlmStreamEvent;
          yield {
            type: "done",
            stopReason: "end",
            text: "ok.",
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1 },
          } as LlmStreamEvent;
        })();
      },
    };
    const base = createLlmAgent({
      config: {
        version: 1,
        provider: "openai",
        apiKeySecret: "AGENT_TEST_KEY",
        speech: { coalesceMs: 0 },
      },
      systemPrompt: "t",
      provider,
      endUserTools: true,
      env: () => ({ AGENT_TEST_KEY: "k" }),
    });
    defineAgent(over.spread ? { ...base, onUserIdentified: () => {} } : base);
    const acks = () =>
      capture.send.mock.calls.filter(
        (c) => (c[0] as { type: string }).type === "session_start_ack",
      ).length;
    for (const id of ["A", "B"]) {
      capture.emit({
        type: "session_start",
        sessionId: id,
        env: {},
        endUser: { id: id.toLowerCase(), verified: false },
      });
    }
    await vi.waitFor(() => expect(acks()).toBe(2));
    const say = (sessionId: string, text: string) =>
      capture.emit({
        type: "speech_event",
        sessionId,
        event: { type: "user_speech_final", text },
      });
    return { requests, say };
  }

  it("identifying session A leaves session B's tool list unchanged", async () => {
    const { requests, say } = await boot();
    capture.emit({
      type: "user_identified",
      sessionId: "A",
      endUser: { id: "a", verified: true },
    });
    say("B", "hi");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.tools.map((t) => t.name)).toEqual(["get_current_user"]);
    say("A", "hi");
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]!.tools.map((t) => t.name)).toContain(
      "get_previous_conversations",
    );
    capture.emit({ type: "session_end", sessionId: "B" });
  });

  it("a customer onUserIdentified override does not stale the tool list", async () => {
    const { requests, say } = await boot({ spread: true });
    capture.emit({
      type: "user_identified",
      sessionId: "A",
      endUser: { id: "a", verified: true },
    });
    say("A", "hi");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.tools.map((t) => t.name)).toContain(
      "get_previous_conversations",
    );
    capture.emit({ type: "session_end", sessionId: "B" });
  });
});
