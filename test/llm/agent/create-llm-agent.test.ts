import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineTool } from "../../../src/llm/agent/define-tool.js";
import { createLlmAgent } from "../../../src/llm/agent/create-llm-agent.js";
import type { CreateLlmAgentOptions } from "../../../src/llm/agent/create-llm-agent.js";
import type { TurnSummary } from "../../../src/llm/agent/hooks.js";
import { openai } from "../../../src/llm/openai.js";
import { LlmProviderError } from "../../../src/llm/types.js";
import type {
  LlmProvider,
  LlmRequest,
  LlmStreamEvent,
  LlmToolCall,
} from "../../../src/llm/types.js";
import {
  SESSION_START_INIT_DELAY_ENABLED_ENV,
  defineAgent,
  resetAgentIpcStateForTests,
} from "../../../src/runtime.js";
import { installProcessMessageCapture } from "../../helpers/process-mock.js";

type Capture = ReturnType<typeof installProcessMessageCapture>;
type Msg = Record<string, unknown>;

const SESSION = "peer-1";

type Step = LlmStreamEvent | { gate: Promise<void> } | { fail: Error };

const delta = (text: string): Step => ({ type: "text_delta", text });
const done = (text: string, toolCalls: LlmToolCall[] = []): Step => ({
  type: "done",
  stopReason: toolCalls.length > 0 ? "tool_calls" : "end",
  text,
  toolCalls,
  usage: { inputTokens: 3, outputTokens: 4 },
});
const call = (id: string, name: string, input: unknown = {}): LlmToolCall => ({
  id,
  name,
  input,
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeProvider(scripts: Step[][]): {
  provider: LlmProvider;
  requests: LlmRequest[];
} {
  const requests: LlmRequest[] = [];
  let n = 0;
  const provider: LlmProvider = {
    id: "openai",
    stream(req) {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const script = scripts[Math.min(n, scripts.length - 1)];
      n += 1;
      return (async function* () {
        for (const step of script) {
          if (req.signal?.aborted) {
            throw new LlmProviderError("LLM_ABORTED", "aborted");
          }
          if ("gate" in step) {
            await Promise.race([
              step.gate,
              new Promise<void>((resolve) =>
                req.signal?.addEventListener("abort", () => resolve(), {
                  once: true,
                }),
              ),
            ]);
            if (req.signal?.aborted) {
              throw new LlmProviderError("LLM_ABORTED", "aborted");
            }
          } else if ("fail" in step) {
            throw step.fail;
          } else {
            yield step;
          }
        }
      })();
    },
  };
  return { provider, requests };
}

const BASE_CONFIG = {
  version: 1,
  provider: "openai",
  apiKeySecret: "AGENT_TEST_KEY",
  speech: { coalesceMs: 0 },
};

describe("createLlmAgent", () => {
  let capture: Capture;
  const summaries: TurnSummary[] = [];

  beforeEach(() => {
    resetAgentIpcStateForTests();
    process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = "false";
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    capture = installProcessMessageCapture();
    summaries.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    capture.emit({ type: "session_end", sessionId: SESSION });
    capture.restore();
    resetAgentIpcStateForTests();
    delete process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
    delete process.env.__CHILD_BUNDLE_PATH__;
  });

  const sent = (type?: string): Msg[] => {
    const all = capture.send.mock.calls.map((c) => c[0] as Msg);
    return type ? all.filter((m) => m.type === type) : all;
  };
  const speaks = () => sent("speak");
  const clientPayloads = () =>
    sent("send_to_client").map((m) => m.payload as Msg);

  async function boot(
    scripts: Step[][],
    over: {
      config?: Record<string, unknown>;
      options?: Partial<CreateLlmAgentOptions>;
      session?: { speakControlAvailable?: boolean };
      skipSessionAck?: boolean;
    } = {},
  ) {
    const fake = fakeProvider(scripts);
    const handlers = createLlmAgent({
      config: { ...BASE_CONFIG, ...over.config },
      systemPrompt: "You are a test agent.",
      provider: fake.provider,
      env: () => ({ AGENT_TEST_KEY: "secret-value" }),
      ...over.options,
      hooks: {
        onTurnEnd: (s) => {
          summaries.push(s);
        },
        ...over.options?.hooks,
      },
    });
    defineAgent(handlers);
    capture.emit({
      type: "session_start",
      sessionId: SESSION,
      env: { SESSION_ID: SESSION },
      speakControlAvailable: over.session?.speakControlAvailable ?? true,
    });
    if (!over.skipSessionAck) {
      await vi.waitFor(() => expect(sent("session_start_ack")).toHaveLength(1));
      capture.send.mockClear();
    }
    return { ...fake, handlers };
  }

  const say = (text: string) =>
    capture.emit({
      type: "speech_event",
      sessionId: SESSION,
      event: { type: "user_speech_final", text },
    });
  const chat = (text: string) =>
    capture.emit({
      type: "data_channel_message",
      sessionId: SESSION,
      payload: JSON.stringify({ type: "chat", text }),
    });
  const speakResult = (requestId: unknown, turnId?: unknown) =>
    capture.emit({
      type: "speak_result",
      sessionId: SESSION,
      requestId,
      turnId,
      status: "played",
      playedMs: 100,
    });

  it("never speaks or keeps a <thinking> block, and counts the stripped characters", async () => {
    const full =
      "<thinking> The user wants a word. </thinking> Sorry, I cannot share it.";
    const { requests } = await boot([
      [
        delta("<thi"),
        delta("nking> The user wants a word. </thin"),
        delta("king> Sorry, I cannot "),
        delta("share it."),
        done(full),
      ],
      [delta("Fine."), done("Fine.")],
    ]);
    say("hi");
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    expect(speaks().map((m) => m.text)).toEqual(["Sorry, I cannot share it."]);
    expect(summaries[0].assistantText).toBe("Sorry, I cannot share it.");
    say("again");
    await vi.waitFor(() => expect(summaries).toHaveLength(2));
    const prior = requests[1].messages.find((m) => m.role === "assistant");
    expect(prior && "text" in prior ? prior.text.trim() : "").toBe(
      "Sorry, I cannot share it.",
    );
    const turnLog = sent("log").find((m) => m.message === "llm turn");
    expect(JSON.stringify(turnLog)).toContain(
      `"thinkingCharsStripped":${"<thinking> The user wants a word. </thinking>".length}`,
    );
    expect(JSON.stringify(sent())).not.toContain("The user wants a word");
  });

  it("a final streams sentences as speaks with one turnId", async () => {
    const { requests } = await boot([
      [
        delta("Hello there. How "),
        delta("are you?"),
        done("Hello there. How are you?"),
      ],
    ]);
    say("hi");
    await vi.waitFor(() => expect(speaks()).toHaveLength(2));
    expect(speaks().map((m) => m.text)).toEqual([
      "Hello there.",
      "How are you?",
    ]);
    const ids = new Set(speaks().map((m) => m.turnId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTruthy();
    expect(speaks().every((m) => m.inReplyTo === undefined)).toBe(true);
    expect(requests[0].system).toBe("You are a test agent.");
    expect(requests[0].messages).toEqual([{ role: "user", text: "hi" }]);
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    expect(summaries[0]).toMatchObject({
      status: "completed",
      llmCalls: 1,
      inputTokens: 3,
      outputTokens: 4,
    });
    const states = sent("agent_state").map((m) => m.state);
    expect(states).toEqual(["thinking", "speaking", "listening"]);
  });

  it("the handler returns before the LLM stream finishes", async () => {
    const gate = deferred();
    const { handlers, requests } = await boot([
      [delta("Start. "), { gate: gate.promise }, done("Start.")],
    ]);
    const result = handlers.onUserSpeechFinal!({
      sessionId: SESSION,
      text: "hi",
    });
    expect(result).toBeUndefined();
    await vi.waitFor(() => expect(speaks()).toHaveLength(1));
    expect(requests).toHaveLength(1);
    expect(summaries).toHaveLength(0);
    gate.resolve();
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
  });

  it("a tool call round feeds the tool result back and speaks the final answer", async () => {
    const handler = vi.fn(async (args: { q: number }) => `result:${args.q}`);
    const { requests } = await boot(
      [
        [done("", [call("c1", "lookup", { q: 1 })])],
        [delta("It is sunny."), done("It is sunny.")],
      ],
      {
        options: {
          tools: [
            defineTool({
              name: "lookup",
              description: "look up",
              inputSchema: { type: "object" },
              handler,
            }),
          ],
        },
      },
    );
    say("weather?");
    await vi.waitFor(() => expect(speaks()).toHaveLength(1));
    expect(speaks()[0].text).toBe("It is sunny.");
    expect(requests).toHaveLength(2);
    expect(requests[0].tools.map((t) => t.name)).toEqual(["lookup"]);
    const last = requests[1].messages.at(-1);
    expect(last).toEqual({
      role: "tool",
      results: [
        { callId: "c1", name: "lookup", content: "result:1", isError: false },
      ],
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(sent("agent_state").map((m) => m.state)).toContain("tool_call");
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    expect(summaries[0].toolCalls).toMatchObject([
      { name: "lookup", isError: false },
    ]);
  });

  it("parallel tool calls run concurrently and are returned in one tool message", async () => {
    const gate = deferred();
    let started = 0;
    const mk = (name: string) =>
      defineTool({
        name,
        description: name,
        inputSchema: { type: "object" },
        handler: async () => {
          started += 1;
          await gate.promise;
          return `${name}-done`;
        },
      });
    const { requests } = await boot(
      [
        [done("", [call("a", "one"), call("b", "two")])],
        [delta("Both done."), done("Both done.")],
      ],
      { options: { tools: [mk("one"), mk("two")] } },
    );
    say("go");
    await vi.waitFor(() => expect(started).toBe(2));
    expect(requests).toHaveLength(1);
    gate.resolve();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const tool = requests[1].messages.filter((m) => m.role === "tool");
    expect(tool).toHaveLength(1);
    expect(tool[0]).toMatchObject({
      results: [
        { callId: "a", content: "one-done" },
        { callId: "b", content: "two-done" },
      ],
    });
  });

  it("maxRounds exceeded speaks the fallback text with LLM_TOOL_ROUNDS_EXCEEDED", async () => {
    const { requests } = await boot([[done("", [call("c", "lookup")])]], {
      config: { tools: { maxRounds: 2 } },
      options: {
        tools: [
          defineTool({
            name: "lookup",
            description: "d",
            inputSchema: { type: "object" },
            handler: () => "r",
          }),
        ],
      },
    });
    say("loop");
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    expect(requests).toHaveLength(2);
    expect(speaks().map((m) => m.text)).toEqual([
      "Sorry, something went wrong. Please try again.",
    ]);
    expect(summaries[0]).toMatchObject({
      status: "failed",
      errorCode: "LLM_TOOL_ROUNDS_EXCEEDED",
    });
  });

  it("a provider error speaks the fallback text once and ends failed", async () => {
    await boot([
      [
        delta("Partial. "),
        { fail: new LlmProviderError("LLM_RATE_LIMITED", "slow down", 429) },
      ],
    ]);
    say("hi");
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    expect(
      speaks().filter(
        (m) => m.text === "Sorry, something went wrong. Please try again.",
      ),
    ).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      status: "failed",
      errorCode: "LLM_RATE_LIMITED",
    });
    const logs = sent("log").map((m) => m.message);
    expect(logs).toContain("llm turn failed: LLM_RATE_LIMITED");
  });

  it("missing API key fails onAgentStart with LLM_API_KEY_MISSING", async () => {
    const handlers = createLlmAgent({
      config: BASE_CONFIG,
      systemPrompt: "p",
      providers: [openai],
      env: () => ({}),
    });
    const err = (await Promise.resolve(
      handlers.onAgentStart!({ env: {} }),
    ).catch((e: unknown) => e)) as Error & { code?: string };
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("LLM_API_KEY_MISSING");
    expect(err.message).toContain("AGENT_TEST_KEY");
  });

  it("missing API key error names AGENT_OPENAI_API_KEY", async () => {
    const handlers = createLlmAgent({
      config: {
        version: 1,
        provider: "openai",
        apiKeySecret: "AGENT_OPENAI_API_KEY",
      },
      systemPrompt: "p",
      providers: [openai],
      env: () => ({}),
    });
    const err = (await Promise.resolve(
      handlers.onAgentStart!({ env: {} }),
    ).catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe("LLM_API_KEY_MISSING");
    expect(err.message).toContain("AGENT_OPENAI_API_KEY");
  });

  it("throws at createLlmAgent when the selected provider module is not registered", () => {
    let caught: (Error & { code?: string }) | undefined;
    try {
      createLlmAgent({
        config: {
          version: 1,
          provider: "anthropic",
          apiKeySecret: "AGENT_ANTHROPIC_API_KEY",
        },
        systemPrompt: "p",
        providers: [openai],
      });
    } catch (e) {
      caught = e as Error & { code?: string };
    }
    expect(caught?.code).toBe("LLM_CONFIG_INVALID");
    expect(caught?.message).toContain("@voicethere/agent/llm/anthropic");
  });

  it("openrouter is served by the openai module", () => {
    expect(() =>
      createLlmAgent({
        config: {
          version: 1,
          provider: "openrouter",
          apiKeySecret: "AGENT_OPENROUTER_API_KEY",
        },
        systemPrompt: "p",
        providers: [openai],
      }),
    ).not.toThrow();
  });

  it("invalid config throws LLM_CONFIG_INVALID with paths", () => {
    let caught: (Error & { code?: string }) | undefined;
    try {
      createLlmAgent({
        config: { version: 1, provider: "nope", apiKeySecret: "lower" },
        systemPrompt: "p",
      });
    } catch (e) {
      caught = e as Error & { code?: string };
    }
    expect(caught?.code).toBe("LLM_CONFIG_INVALID");
    expect(caught?.message).toContain("provider: ");
    expect(caught?.message).toContain("apiKeySecret: ");
  });

  it("barge-in interruption replaces the assistant text with playedText and adds the note to the next turn", async () => {
    const { requests } = await boot([
      [delta("First part. Second part."), done("First part. Second part.")],
      [delta("Sure."), done("Sure.")],
    ]);
    say("tell me");
    await vi.waitFor(() => expect(speaks()).toHaveLength(2));
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    const turnId = speaks()[0].turnId;
    capture.emit({
      type: "agent_interrupted",
      sessionId: SESSION,
      turnId,
      replyPlayedMs: 500,
      playedText: "First part.",
      unplayedText: "Second part.",
      playedTextExact: true,
      cancelledRequestIds: [],
    });
    say("wait");
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const msgs = requests[1].messages;
    expect(msgs[1]).toEqual({ role: "assistant", text: "First part." });
    expect(msgs[2]).toEqual({
      role: "user",
      text: '(The caller interrupted your previous reply after: "First part.". They did not hear: "Second part.".)\nwait',
    });
  });

  it("a new final with cancel policy cancels the running turn", async () => {
    const gate = deferred();
    const { requests } = await boot([
      [delta("One. Two"), { gate: gate.promise }, done("One. Two")],
      [delta("Answer."), done("Answer.")],
    ]);
    say("first");
    await vi.waitFor(() => expect(speaks()).toHaveLength(1));
    const firstTurn = speaks()[0].turnId;
    say("second");
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(sent("speak_cancel")).toContainEqual(
      expect.objectContaining({ turnId: firstTurn }),
    );
    await vi.waitFor(() => expect(summaries).toHaveLength(2));
    expect(summaries[0].status).toBe("cancelled");
    expect(summaries[1].status).toBe("completed");
    expect(speaks().at(-1)).toMatchObject({ text: "Answer." });
    expect(speaks().at(-1)!.turnId).not.toBe(firstTurn);
    expect(
      requests[1].messages.map((m) => (m.role === "user" ? m.text : m.role)),
    ).toEqual(["first", "assistant", "second"]);
  });

  it("finish policy runs the latest queued input after the current turn", async () => {
    const gate = deferred();
    const { requests } = await boot(
      [
        [delta("Working. "), { gate: gate.promise }, done("Working.")],
        [delta("Later."), done("Later.")],
      ],
      { config: { interruptPolicy: "finish" } },
    );
    say("first");
    await vi.waitFor(() => expect(speaks()).toHaveLength(1));
    say("second");
    say("third");
    await new Promise((r) => setTimeout(r, 20));
    expect(sent("speak_cancel")).toHaveLength(0);
    expect(requests).toHaveLength(1);
    gate.resolve();
    await vi.waitFor(() => expect(summaries).toHaveLength(2));
    expect(requests).toHaveLength(2);
    const users = requests[1].messages.filter((m) => m.role === "user");
    expect(users.map((m) => (m as { text: string }).text)).toEqual([
      "first",
      "third",
    ]);
  });

  it("discard mode drops a final during an announcement", async () => {
    const { requests } = await boot([[delta("Hi."), done("Hi.")]], {
      config: {
        speechDuringNonInterruptible: "discard",
        greeting: { text: "Welcome to the line." },
      },
      skipSessionAck: true,
    });
    await vi.waitFor(() => expect(speaks()).toHaveLength(1));
    const greet = speaks()[0];
    expect(greet).toMatchObject({
      text: "Welcome to the line.",
      interruptible: false,
    });
    say("hello?");
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    expect(summaries[0].status).toBe("discarded");
    expect(requests).toHaveLength(0);
    speakResult(greet.requestId, greet.turnId);
    await new Promise((r) => setTimeout(r, 10));
    say("hello again");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
  });

  it("the filler is spoken once when tools take longer than afterMs", async () => {
    const gate = deferred();
    let started = false;
    await boot(
      [
        [done("", [call("c", "slow")])],
        [delta("Finished."), done("Finished.")],
      ],
      {
        config: {
          tools: { filler: { text: "One moment please.", afterMs: 1500 } },
        },
        options: {
          tools: [
            defineTool({
              name: "slow",
              description: "slow",
              inputSchema: { type: "object" },
              handler: async () => {
                started = true;
                await gate.promise;
                return "ok";
              },
            }),
          ],
        },
      },
    );
    vi.useFakeTimers();
    say("go");
    await vi.waitFor(() => expect(started).toBe(true));
    expect(speaks()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1600);
    expect(speaks()).toHaveLength(1);
    expect(speaks()[0]).toMatchObject({
      text: "One moment please.",
      interruptible: false,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(speaks()).toHaveLength(1);
    gate.resolve();
    await vi.waitFor(() => expect(speaks()).toHaveLength(2));
    expect(speaks()[1].text).toBe("Finished.");
  });

  it("chat input gets assistant_delta, assistant_done and chat_reply", async () => {
    await boot([[delta("Hi. There."), done("Hi. There.")]]);
    chat("hello");
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    const payloads = clientPayloads();
    const turnId = speaks()[0].turnId;
    expect(payloads.filter((p) => p.type === "assistant_delta")).toEqual([
      { type: "assistant_delta", turnId, text: "Hi." },
      { type: "assistant_delta", turnId, text: "There." },
    ]);
    expect(payloads).toContainEqual({
      type: "assistant_done",
      turnId,
      text: "Hi. There.",
    });
    expect(payloads).toContainEqual({
      type: "chat_reply",
      text: "Hi. There.",
    });
  });

  it("service tool source uses AGENT_SERVICE_URL and the bearer token", async () => {
    const sourceFactory = vi.fn((o: { name: string }) => ({
      name: o.name,
      status: "ready",
      start: vi.fn(),
      ready: async () => true,
      tools: () => [],
      callTool: async () => ({ content: "", isError: false }),
    }));
    const handlers = createLlmAgent({
      config: {
        ...BASE_CONFIG,
        toolSources: [{ kind: "service", path: "/mcp" }],
      },
      systemPrompt: "p",
      provider: fakeProvider([[done("x")]]).provider,
      env: () => ({
        AGENT_TEST_KEY: "k",
        AGENT_SERVICE_URL: "http://svc.internal:3000",
        AGENT_SERVICE_TOKEN: "tok-123",
      }),
      sourceFactory:
        sourceFactory as unknown as CreateLlmAgentOptions["sourceFactory"],
    });
    await handlers.onAgentStart!({ env: {} });
    expect(sourceFactory).toHaveBeenCalledTimes(1);
    expect(sourceFactory.mock.calls[0][0]).toMatchObject({
      name: "service",
      url: "http://svc.internal:3000/mcp",
      headers: { Authorization: "Bearer tok-123" },
    });
  });

  it("service source reports kind service", async () => {
    const sourceFactory = vi.fn((o: { name: string }) => ({
      name: o.name,
      status: "ready",
      start: vi.fn(),
      ready: async () => true,
      tools: () => [],
      callTool: async () => ({ content: "", isError: false }),
    }));
    const handlers = createLlmAgent({
      config: {
        ...BASE_CONFIG,
        toolSources: [
          { kind: "service" },
          { kind: "mcp", name: "m", url: "https://x.example" },
        ],
      },
      systemPrompt: "p",
      provider: fakeProvider([[done("x")]]).provider,
      env: () => ({
        AGENT_TEST_KEY: "k",
        AGENT_SERVICE_URL: "http://svc.internal:3000",
        AGENT_SERVICE_TOKEN: "tok-123",
      }),
      sourceFactory:
        sourceFactory as unknown as CreateLlmAgentOptions["sourceFactory"],
    });
    await handlers.onAgentStart!({ env: {} });
    expect(sourceFactory).toHaveBeenCalledTimes(2);
    const byName = Object.fromEntries(
      sourceFactory.mock.calls.map((c) => [
        (c[0] as { name: string }).name,
        c[0] as { kind?: string },
      ]),
    );
    expect(byName.service.kind).toBe("service");
    expect(byName.m.kind).toBeUndefined();
  });

  it("hook-answered call writes one llm.tool.call line", async () => {
    const handler = vi.fn(async () => "never");
    await boot(
      [
        [done("", [{ id: "c1", name: "mine", input: { q: 1 } }])],
        [delta("Ok."), done("Ok.")],
      ],
      {
        options: {
          tools: [
            {
              name: "mine",
              description: "d",
              inputSchema: { type: "object" },
              handler,
            },
          ],
          hooks: { onToolCall: () => ({ result: "x" }) },
        },
      },
    );
    say("hi");
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    const lines = sent("log").filter(
      (m) => (m.fields as Msg | undefined)?.event === "llm.tool.call",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].sessionId).toBe(SESSION);
    expect(lines[0].fields).toMatchObject({
      kind: "hook",
      tool: "mine",
      callId: "c1",
      output: "x",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("onAssistantText returning null suppresses a sentence", async () => {
    await boot(
      [[delta("Secret one. Public two."), done("Secret one. Public two.")]],
      {
        options: {
          hooks: {
            onAssistantText: (text) =>
              text.startsWith("Secret") ? null : text,
          },
        },
      },
    );
    say("hi");
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    expect(speaks().map((m) => m.text)).toEqual(["Public two."]);
    expect(summaries[0].assistantText).toBe("Public two.");
  });

  it("respond hook can answer without calling the LLM", async () => {
    const { requests } = await boot([[done("never")]], {
      options: {
        hooks: {
          respond: async (ctx) => {
            ctx.speak("Canned answer.");
          },
        },
      },
    });
    say("hi");
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    expect(requests).toHaveLength(0);
    expect(speaks().map((m) => m.text)).toEqual(["Canned answer."]);
    expect(summaries[0]).toMatchObject({
      status: "completed",
      assistantText: "Canned answer.",
      llmCalls: 0,
    });
  });

  it("a throwing hook is logged and ignored", async () => {
    await boot([[delta("Fine."), done("Fine.")]], {
      options: {
        hooks: {
          onBeforeLlmCall: () => {
            throw new Error("boom");
          },
        },
      },
    });
    say("hi");
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    expect(sent("log").map((m) => m.message)).toContain(
      "llm hook onBeforeLlmCall failed: boom",
    );
    expect(speaks().map((m) => m.text)).toEqual(["Fine."]);
    expect(summaries[0].status).toBe("completed");
  });

  it("bargeIn mode off calls setBargeIn(false) on session start", async () => {
    await boot([[done("x")]], {
      config: { bargeIn: { mode: "off" } },
      skipSessionAck: true,
    });
    await vi.waitFor(() => expect(sent("barge_in_control")).toHaveLength(1));
    const req = sent("barge_in_control")[0];
    expect(req).toMatchObject({ sessionId: SESSION, enabled: false });
    capture.emit({
      type: "barge_in_control_ack",
      sessionId: SESSION,
      requestId: req.requestId,
      enabled: false,
      ok: true,
      reason: "applied",
    });
    await vi.waitFor(() => expect(sent("session_start_ack")).toHaveLength(1));
  });
});
