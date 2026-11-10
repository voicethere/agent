import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineTool } from "../../../src/llm/agent/define-tool.js";
import {
  FAIL_CLOSE_SPEAK_WAIT_MS,
  createLlmAgent,
} from "../../../src/llm/agent/create-llm-agent.js";
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
import { assertProviderOrder } from "./provider-order.js";

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
const doneWithState = (text: string, providerState: unknown): Step => ({
  type: "done",
  stopReason: "end",
  text,
  toolCalls: [],
  providerState,
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
      session?: {
        speakControlAvailable?: boolean;
        chatReplyRecordAvailable?: boolean;
      };
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
      ...(over.session?.chatReplyRecordAvailable !== undefined
        ? { chatReplyRecordAvailable: over.session.chatReplyRecordAvailable }
        : {}),
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

  it("drops providerState when a thinking block was stripped", async () => {
    const full = "<thinking>x</thinking> Hi.";
    const { requests } = await boot([
      [delta(full), doneWithState(full, [{ type: "text", text: full }])],
      [delta("Ok."), done("Ok.")],
    ]);
    say("hi");
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    say("again");
    await vi.waitFor(() => expect(summaries).toHaveLength(2));
    const prior = requests[1].messages.find((m) => m.role === "assistant");
    expect(prior && "text" in prior ? prior.text.trim() : "").toBe("Hi.");
    expect(
      prior && "providerState" in prior ? prior.providerState : undefined,
    ).toBeUndefined();
  });

  it("keeps providerState when nothing was stripped", async () => {
    const state = [{ type: "text", text: "Hi." }];
    const { requests } = await boot([
      [delta("Hi."), doneWithState("Hi.", state)],
      [delta("Ok."), done("Ok.")],
    ]);
    say("hi");
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    say("again");
    await vi.waitFor(() => expect(summaries).toHaveLength(2));
    const prior = requests[1].messages.find((m) => m.role === "assistant");
    expect(
      prior && "providerState" in prior ? prior.providerState : undefined,
    ).toEqual(state);
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

  it("the llm turn failed row carries status, vendorCode and stream, never the vendor message", async () => {
    await boot([
      [
        {
          fail: new LlmProviderError(
            "LLM_PROVIDER_ERROR",
            "openrouter stream error",
            undefined,
            { vendorCode: 424, stream: true },
          ),
        },
      ],
    ]);
    say("hi");
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    const row = sent("log").find(
      (m) => m.message === "llm turn failed: LLM_PROVIDER_ERROR",
    );
    expect(row?.fields).toEqual({ vendorCode: 424, stream: true });
  });

  describe("a tool round left open never puts the next user message after a tool result", () => {
    const lookup = (handler: () => Promise<string>) =>
      defineTool({
        name: "lookup",
        description: "look up",
        inputSchema: { type: "object" },
        handler,
      });

    it("cancel barge-in before the first answer token after a tool round keeps a valid order", async () => {
      const gate = deferred();
      const turnIds: string[] = [];
      const { requests } = await boot(
        [
          [done("", [call("c1", "lookup")])],
          [
            { gate: gate.promise },
            delta("Within 60 days."),
            done("Within 60 days."),
          ],
          [delta("It is 349 dollars."), done("It is 349 dollars.")],
        ],
        {
          config: { interruptPolicy: "cancel" },
          options: {
            tools: [lookup(async () => "returns: 60 days")],
            hooks: {
              onBeforeLlmCall: (_m, ctx) => {
                turnIds.push(ctx.turnId);
              },
            },
          },
        },
      );
      say("returns?");
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      capture.emit({
        type: "agent_interrupted",
        sessionId: SESSION,
        turnId: turnIds[0],
        replyPlayedMs: 0,
        playedText: "",
        unplayedText: "",
        playedTextExact: true,
        cancelledRequestIds: [],
      });
      say("price?");
      await vi.waitFor(() => expect(requests).toHaveLength(3));
      const msgs = requests[2].messages;
      assertProviderOrder(msgs);
      expect(msgs.some((m) => m.role === "tool")).toBe(false);
      expect(msgs.at(-1)).toMatchObject({ role: "user" });
    });

    it("a provider error in the answer round after tools leaves a valid order for the next turn", async () => {
      const { requests } = await boot(
        [
          [done("", [call("c1", "lookup")])],
          [{ fail: new LlmProviderError("LLM_PROVIDER_ERROR", "x") }],
          [delta("It is 349 dollars."), done("It is 349 dollars.")],
        ],
        { options: { tools: [lookup(async () => "returns: 60 days")] } },
      );
      say("returns?");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      expect(summaries[0]).toMatchObject({ status: "failed" });
      say("price?");
      await vi.waitFor(() => expect(requests).toHaveLength(3));
      assertProviderOrder(requests[2].messages);
      expect(requests[2].messages.some((m) => m.role === "tool")).toBe(false);
    });

    it("a tool result written after the cancel settle bound is dropped and the next request keeps a valid order", async () => {
      // runTools races the abort, but an onToolResult hook that ignores it can
      // hold the cancelled turn past CANCEL_SETTLE_MS and write late.
      const slow = deferred();
      const started = deferred();
      const { requests } = await boot(
        [
          [done("", [call("c1", "lookup")])],
          [delta("It is 349 dollars."), done("It is 349 dollars.")],
        ],
        {
          config: { interruptPolicy: "cancel" },
          options: {
            tools: [lookup(async () => "late result")],
            hooks: {
              onToolResult: async () => {
                started.resolve();
                await slow.promise;
                return undefined;
              },
            },
          },
        },
      );
      say("returns?");
      await started.promise;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      say("price?");
      // The cancel waits at most CANCEL_SETTLE_MS (2 s) for the old turn.
      for (let i = 0; i < 50 && requests.length < 2; i += 1) {
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(requests).toHaveLength(2);
      slow.resolve();
      for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(10);
      vi.useRealTimers();
      assertProviderOrder(requests[1].messages);
      expect(requests[1].messages.some((m) => m.role === "tool")).toBe(false);
      await vi.waitFor(() =>
        expect(
          sent("log").filter((m) => m.message === "history late write dropped"),
        ).toHaveLength(1),
      );
      const row = sent("log").find(
        (m) => m.message === "history late write dropped",
      );
      expect(row?.fields).toMatchObject({ kind: "tool", count: 1 });
      expect(JSON.stringify(row)).not.toContain("late result");
    });
  });

  describe("output cap (max_tokens)", () => {
    const truncated = (
      text: string,
      usage = { inputTokens: 3, outputTokens: 300, reasoningTokens: 290 },
    ): Step => ({
      type: "done",
      stopReason: "max_tokens",
      text,
      toolCalls: [],
      usage,
    });
    const lookup = defineTool({
      name: "lookup",
      description: "d",
      inputSchema: { type: "object" },
      handler: () => "r",
    });
    const truncLog = () =>
      sent("log").find(
        (m) => m.message === "llm turn truncated: LLM_OUTPUT_TRUNCATED",
      );

    it("empty final round: speaks the fallback, ends failed with LLM_OUTPUT_TRUNCATED", async () => {
      await boot([[done("", [call("c", "lookup")])], [truncated("")]], {
        options: { tools: [lookup] },
      });
      say("question");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      expect(speaks().map((m) => m.text)).toEqual([
        "Sorry, something went wrong. Please try again.",
      ]);
      expect(summaries[0]).toMatchObject({
        status: "failed",
        errorCode: "LLM_OUTPUT_TRUNCATED",
        stopReason: "max_tokens",
        reasoningTokens: 290,
        outputTokens: 304,
      });
      const warn = truncLog();
      expect(warn).toMatchObject({
        level: "warn",
        fields: {
          code: "LLM_OUTPUT_TRUNCATED",
          round: 2,
          outputTokens: 300,
          reasoningTokens: 290,
          maxOutputTokens: 512,
          partial: false,
        },
      });
      const turnLog = sent("log").find((m) => m.message === "llm turn");
      expect(turnLog).toMatchObject({
        fields: {
          status: "failed",
          stopReason: "max_tokens",
          reasoningTokens: 290,
        },
      });
    });

    it("preamble before a tool call, then empty truncated answer: fails with the fallback", async () => {
      await boot(
        [
          [
            delta("Let me check."),
            done("Let me check.", [call("c", "lookup")]),
          ],
          [truncated("")],
        ],
        { options: { tools: [lookup] } },
      );
      say("question");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      const texts = speaks().map((m) => m.text);
      expect(texts.filter((t) => t === "Let me check.")).toHaveLength(1);
      expect(
        texts.filter(
          (t) => t === "Sorry, something went wrong. Please try again.",
        ),
      ).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        status: "failed",
        errorCode: "LLM_OUTPUT_TRUNCATED",
        stopReason: "max_tokens",
      });
      expect(truncLog()).toMatchObject({
        level: "warn",
        fields: { code: "LLM_OUTPUT_TRUNCATED", round: 2, partial: false },
      });
    });

    it("text already spoken: keeps it, sends it once, warns partial, ends completed", async () => {
      const { requests } = await boot([
        [
          delta("Partial answer. "),
          delta("Cut of"),
          truncated("Partial answer. Cut of"),
        ],
        [delta("Next."), done("Next.")],
      ]);
      say("question");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      const texts = speaks().map((m) => m.text);
      expect(texts.filter((t) => t === "Partial answer.")).toHaveLength(1);
      expect(texts).not.toContain(
        "Sorry, something went wrong. Please try again.",
      );
      expect(summaries[0]).toMatchObject({
        status: "completed",
        stopReason: "max_tokens",
      });
      expect(summaries[0].errorCode).toBeUndefined();
      expect(truncLog()).toMatchObject({
        level: "warn",
        fields: { code: "LLM_OUTPUT_TRUNCATED", round: 1, partial: true },
      });
      expect(JSON.stringify(truncLog())).not.toContain("Partial answer");
      say("again");
      await vi.waitFor(() => expect(summaries).toHaveLength(2));
      const prior = requests[1].messages.find((m) => m.role === "assistant");
      expect(prior && "text" in prior ? prior.text : "").toContain(
        "Partial answer.",
      );
    });

    it("normal stop: no truncation warn, summary stopReason end", async () => {
      await boot([[delta("All good."), done("All good.")]]);
      say("question");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      expect(speaks().map((m) => m.text)).toEqual(["All good."]);
      expect(summaries[0]).toMatchObject({
        status: "completed",
        stopReason: "end",
      });
      expect(summaries[0].errorCode).toBeUndefined();
      expect(summaries[0].reasoningTokens).toBeUndefined();
      expect(truncLog()).toBeUndefined();
    });
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

  it("finish policy keeps the queued final's utteranceId", async () => {
    const gate = deferred();
    await boot(
      [
        [delta("Working. "), { gate: gate.promise }, done("Working.")],
        [delta("Later."), done("Later.")],
      ],
      { config: { interruptPolicy: "finish" } },
    );
    const final = (text: string, utteranceId: string) =>
      capture.emit({
        type: "speech_event",
        sessionId: SESSION,
        event: { type: "user_speech_final", text, utteranceId },
      });
    final("first", "utt-1");
    await vi.waitFor(() => expect(speaks()).toHaveLength(1));
    final("second", "utt-2");
    final("third", "utt-3");
    await new Promise((r) => setTimeout(r, 20));
    gate.resolve();
    await vi.waitFor(() => expect(summaries).toHaveLength(2));
    const t1 = summaries[0].turnId;
    const t2 = summaries[1].turnId;
    expect(t1).not.toBe(t2);
    const mine = (turnId: string) => [
      ...clientPayloads().filter((p) => p.turnId === turnId),
      ...speaks().filter((m) => m.turnId === turnId),
    ];
    const first = mine(t1);
    const second = mine(t2);
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(second.length).toBeGreaterThanOrEqual(3);
    for (const m of first) expect(m.inReplyTo).toBe("utt-1");
    for (const m of second) expect(m.inReplyTo).toBe("utt-3");
    expect(second.map((m) => m.type)).toEqual(
      expect.arrayContaining(["assistant_delta", "assistant_done", "speak"]),
    );
  });

  it("cancelled voice turn sends done with status cancelled", async () => {
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
    await vi.waitFor(() => expect(summaries).toHaveLength(2));
    const dones = clientPayloads().filter((p) => p.type === "assistant_done");
    expect(dones.filter((d) => d.turnId === firstTurn)).toEqual([
      {
        type: "assistant_done",
        turnId: firstTurn,
        text: "One.",
        spoken: true,
        status: "cancelled",
      },
    ]);
    expect(new Set(dones.map((d) => d.turnId)).size).toBe(dones.length);
  });

  it("greeting sends spoken assistant_delta before speaking", async () => {
    await boot([[delta("Hi."), done("Hi.")]], {
      config: { greeting: { text: "Welcome to the line." } },
      skipSessionAck: true,
    });
    await vi.waitFor(() => expect(speaks()).toHaveLength(1));
    const order = sent()
      .filter((m) => m.type === "speak" || m.type === "send_to_client")
      .map((m) => m.type);
    expect(order.indexOf("send_to_client")).toBeLessThan(
      order.indexOf("speak"),
    );
    const d = clientPayloads().find((p) => p.type === "assistant_delta");
    expect(d).toMatchObject({
      type: "assistant_delta",
      spoken: true,
      text: "Welcome to the line.",
    });
    expect(String(d?.turnId)).toMatch(/^greet-/);
    expect(speaks()[0].turnId).toBe(d?.turnId);
  });

  it("greeting sends assistant_done before the speak settles", async () => {
    await boot([[delta("Hi."), done("Hi.")]], {
      config: { greeting: { text: "Welcome to the line." } },
      skipSessionAck: true,
    });
    await vi.waitFor(() => expect(speaks()).toHaveLength(1));
    const greet = speaks()[0];
    // The speak is never resolved: the done must not wait for playback.
    const dones = clientPayloads().filter((p) => p.type === "assistant_done");
    const delta0 = clientPayloads().find((p) => p.type === "assistant_delta");
    expect(dones).toEqual([
      {
        type: "assistant_done",
        turnId: greet.turnId,
        text: "Welcome to the line.",
        spoken: true,
        status: "completed",
      },
    ]);
    expect(delta0?.turnId).toBe(greet.turnId);
  });

  it("greeting delta then done come before a later turn's messages", async () => {
    await boot([[delta("Hi."), done("Hi.")]], {
      config: {
        greeting: { text: "Welcome to the line.", interruptible: true },
      },
      skipSessionAck: true,
    });
    await vi.waitFor(() => expect(speaks()).toHaveLength(1));
    const greet = speaks()[0];
    // A turn starts while the greeting is still playing.
    say("hello");
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    const seq = clientPayloads()
      .filter(
        (p) => p.type === "assistant_delta" || p.type === "assistant_done",
      )
      .map((p) => `${p.type}:${String(p.turnId).startsWith("greet-")}`);
    expect(seq.slice(0, 2)).toEqual([
      "assistant_delta:true",
      "assistant_done:true",
    ]);
    expect(seq.slice(2).every((x) => x.endsWith(":false"))).toBe(true);
    expect(seq.length).toBeGreaterThan(2);
    speakResult(greet.requestId, greet.turnId);
  });

  it("interrupted greeting sends exactly one assistant_done", async () => {
    await boot([[delta("Hi."), done("Hi.")]], {
      config: {
        greeting: { text: "Welcome to the line.", interruptible: true },
      },
      skipSessionAck: true,
    });
    await vi.waitFor(() => expect(speaks()).toHaveLength(1));
    const greet = speaks()[0];
    capture.emit({
      type: "speak_result",
      sessionId: SESSION,
      requestId: greet.requestId,
      turnId: greet.turnId,
      status: "interrupted",
      playedMs: 50,
    });
    await new Promise((r) => setTimeout(r, 20));
    const dones = clientPayloads().filter((p) => p.type === "assistant_done");
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({
      turnId: greet.turnId,
      status: "completed",
    });
  });

  it("no greeting sends nothing", async () => {
    await boot([[delta("Hi."), done("Hi.")]]);
    await new Promise((r) => setTimeout(r, 10));
    expect(
      clientPayloads().filter((p) => String(p.type).startsWith("assistant_")),
    ).toHaveLength(0);
  });

  it("session ended before the greeting finished sends no extra done", async () => {
    await boot([[delta("Hi."), done("Hi.")]], {
      config: { greeting: { text: "Welcome to the line." } },
      skipSessionAck: true,
    });
    await vi.waitFor(() => expect(speaks()).toHaveLength(1));
    const greet = speaks()[0];
    capture.emit({ type: "session_end", sessionId: SESSION });
    speakResult(greet.requestId, greet.turnId);
    await new Promise((r) => setTimeout(r, 20));
    expect(
      clientPayloads().filter((p) => p.type === "assistant_done"),
    ).toHaveLength(1);
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
      turnId,
    });
  });

  it("two chat turns send chat_reply with their own assistant_done turnId", async () => {
    await boot([
      [delta("One."), done("One.")],
      [delta("Two."), done("Two.")],
    ]);
    chat("first");
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    speakResult(speaks()[0].requestId, speaks()[0].turnId);
    await new Promise((r) => setTimeout(r, 0));
    chat("second");
    await vi.waitFor(() => expect(summaries).toHaveLength(2));
    expect(sent("speak_cancel")).toHaveLength(0);
    const payloads = clientPayloads();
    const dones = payloads.filter((p) => p.type === "assistant_done");
    const replies = payloads.filter((p) => p.type === "chat_reply");
    expect(dones).toHaveLength(2);
    expect(replies).toHaveLength(2);
    expect(replies[0].turnId).toBe(dones[0].turnId);
    expect(replies[1].turnId).toBe(dones[1].turnId);
    expect(replies[0].turnId).not.toBe(replies[1].turnId);
  });

  it("voice turn sends spoken assistant_delta per sentence and one assistant_done", async () => {
    await boot([[delta("Hi. There."), done("Hi. There.")]]);
    say("hello");
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    const payloads = clientPayloads();
    const turnId = speaks()[0].turnId;
    expect(payloads.filter((p) => p.type === "assistant_delta")).toEqual([
      { type: "assistant_delta", turnId, text: "Hi.", spoken: true },
      { type: "assistant_delta", turnId, text: "There.", spoken: true },
    ]);
    expect(payloads.filter((p) => p.type === "assistant_done")).toEqual([
      {
        type: "assistant_done",
        turnId,
        text: "Hi. There.",
        spoken: true,
        status: "completed",
      },
    ]);
    expect(payloads.some((p) => p.type === "chat_reply")).toBe(false);
  });

  it("voice turn carries inReplyTo", async () => {
    await boot([
      [delta("Hi. There."), done("Hi. There.")],
      [delta("Again."), done("Again.")],
    ]);
    capture.emit({
      type: "speech_event",
      sessionId: SESSION,
      event: { type: "user_speech_final", text: "hello", utteranceId: "utt-7" },
    });
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    const first = clientPayloads().filter((p) =>
      String(p.type).startsWith("assistant_"),
    );
    expect(first).toHaveLength(3);
    for (const p of first) expect(p.inReplyTo).toBe("utt-7");
    expect(speaks().every((m) => m.inReplyTo === "utt-7")).toBe(true);
    capture.send.mockClear();
    say("again");
    await vi.waitFor(() => expect(summaries).toHaveLength(2));
    const second = clientPayloads().filter((p) =>
      String(p.type).startsWith("assistant_"),
    );
    expect(second).toHaveLength(2);
    for (const p of second) expect("inReplyTo" in p).toBe(false);
  });

  it("interrupted voice turn sends done with status interrupted", async () => {
    const gate = deferred();
    await boot([[delta("One. Two"), { gate: gate.promise }, done("One. Two")]]);
    say("go");
    await vi.waitFor(() => expect(speaks()).toHaveLength(1));
    const turnId = speaks()[0].turnId;
    capture.emit({
      type: "agent_interrupted",
      sessionId: SESSION,
      turnId,
      replyPlayedMs: 100,
      playedText: "One.",
      unplayedText: "",
      playedTextExact: true,
      cancelledRequestIds: [],
    });
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    expect(summaries[0].status).toBe("interrupted");
    expect(clientPayloads().filter((p) => p.type === "assistant_done")).toEqual(
      [
        {
          type: "assistant_done",
          turnId,
          text: "One.",
          spoken: true,
          status: "interrupted",
        },
      ],
    );
  });

  it("chat turn with speakChat on keeps its exact payload keys", async () => {
    await boot([[delta("Hi."), done("Hi.")]]);
    chat("hello");
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    const payloads = clientPayloads();
    const turnId = speaks()[0].turnId;
    expect(payloads).toEqual([
      { type: "assistant_delta", turnId, text: "Hi." },
      { type: "assistant_done", turnId, text: "Hi." },
      { type: "chat_reply", text: "Hi.", turnId },
    ]);
  });

  it("speakChatReplies:false chat turn sends record_reply once with the joined reply and turnId", async () => {
    await boot([[delta("Hi. There."), done("Hi. There.")]], {
      config: { speakChatReplies: false },
      session: { chatReplyRecordAvailable: true },
    });
    chat("hello");
    await vi.waitFor(() => expect(sent("record_reply")).toHaveLength(1));
    const done_ = clientPayloads().find((p) => p.type === "assistant_done")!;
    expect(sent("record_reply")).toEqual([
      {
        type: "record_reply",
        sessionId: SESSION,
        text: "Hi. There.",
        turnId: done_.turnId,
      },
    ]);
    expect(speaks()).toHaveLength(0);
  });

  it("speakChatReplies:true chat turn sends no record_reply", async () => {
    await boot([[delta("Hi."), done("Hi.")]], {
      session: { chatReplyRecordAvailable: true },
    });
    chat("hello");
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    expect(sent("record_reply")).toHaveLength(0);
  });

  it("speakChatReplies:false on a runner without the capability sends no record_reply", async () => {
    await boot([[delta("Hi."), done("Hi.")]], {
      config: { speakChatReplies: false },
    });
    chat("hello");
    await vi.waitFor(() =>
      expect(clientPayloads().map((p) => p.type)).toContain("chat_reply"),
    );
    expect(sent("record_reply")).toHaveLength(0);
  });

  it("two voice turns in the same millisecond keep their own turnId", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    try {
      await boot([
        [delta("Alpha."), done("Alpha.")],
        [delta("Beta."), done("Beta.")],
      ]);
      say("one");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      say("two");
      await vi.waitFor(() => expect(summaries).toHaveLength(2));
      const dones = clientPayloads().filter((p) => p.type === "assistant_done");
      expect(dones).toHaveLength(2);
      expect(dones[0].turnId).not.toBe(dones[1].turnId);
      expect(dones.map((d) => d.text)).toEqual(["Alpha.", "Beta."]);
      expect(dones[0].turnId).toBe(summaries[0].turnId);
      expect(dones[1].turnId).toBe(summaries[1].turnId);
    } finally {
      vi.useRealTimers();
    }
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

  describe("a typed message barges in", () => {
    const settle = (m: Msg, status: string, playedMs = 0) =>
      capture.emit({
        type: "speak_result",
        sessionId: SESSION,
        requestId: m.requestId,
        turnId: m.turnId,
        status,
        playedMs,
      });

    it("chat after the reply finished generating flushes its pending speech and notes the interruption", async () => {
      const { requests } = await boot([
        [delta("First part. Second part."), done("First part. Second part.")],
        [delta("Sure."), done("Sure.")],
      ]);
      say("tell me");
      await vi.waitFor(() => expect(speaks()).toHaveLength(2));
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      const [first, second] = speaks();
      settle(first, "played", 500);
      await new Promise((r) => setTimeout(r, 0));
      chat("actually, something else");
      await vi.waitFor(() => expect(sent("speak_cancel")).toHaveLength(1));
      expect(sent("speak_cancel")[0]).toEqual({
        type: "speak_cancel",
        sessionId: SESSION,
        requestId: second.requestId,
      });
      settle(second, "interrupted", 200);
      await vi.waitFor(() => expect(summaries).toHaveLength(2));
      const all = sent();
      const cancelAt = all.findIndex((m) => m.type === "speak_cancel");
      const newSpeakAt = all.findIndex(
        (m) => m.type === "speak" && m.text === "Sure.",
      );
      expect(cancelAt).toBeGreaterThanOrEqual(0);
      expect(cancelAt).toBeLessThan(newSpeakAt);
      const msgs = requests[1].messages;
      expect(msgs[1]).toEqual({ role: "assistant", text: "First part." });
      expect(msgs[2]).toEqual({
        role: "user",
        text: '(The caller interrupted your previous reply after: "First part.". They did not hear: "Second part.".)\nactually, something else',
      });
      expect(sent("speak_cancel")).toHaveLength(1);
    });

    it("default speech coalescing: chat after generation flushes the coalesced reply", async () => {
      const { requests } = await boot(
        [
          [delta("First part. Second part."), done("First part. Second part.")],
          [delta("Sure."), done("Sure.")],
        ],
        { config: { speech: { coalesceMs: 150 } } },
      );
      say("tell me");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      await vi.waitFor(() => expect(speaks()).toHaveLength(1));
      const coalesced = speaks()[0];
      chat("next");
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(sent("speak_cancel")).toEqual([
        {
          type: "speak_cancel",
          sessionId: SESSION,
          requestId: coalesced.requestId,
        },
      ]);
      const users = requests[1].messages.filter((m) => m.role === "user");
      const last = users.at(-1) as { text: string };
      expect(
        last.text.startsWith(
          '(The caller interrupted your previous reply after: "". They did not hear: "First part. Second part.".)',
        ),
      ).toBe(true);
    });

    it("a second chat before the runner settles the flush does not re-cancel or re-note", async () => {
      const gate = deferred();
      const { requests } = await boot([
        [delta("First part. Second part."), done("First part. Second part.")],
        [{ gate: gate.promise }, done("Ok.")],
        [delta("Done."), done("Done.")],
      ]);
      say("tell me");
      await vi.waitFor(() => expect(speaks()).toHaveLength(2));
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      settle(speaks()[0], "played", 500);
      await new Promise((r) => setTimeout(r, 0));
      chat("one");
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      chat("two");
      await vi.waitFor(() => expect(requests).toHaveLength(3));
      const byRequest = sent("speak_cancel").filter(
        (m) => m.requestId !== undefined,
      );
      expect(byRequest).toHaveLength(1);
      const users = requests[2].messages.filter((m) => m.role === "user");
      expect((users.at(-1) as { text: string }).text).toBe("two");
    });

    it("chat during generation cancels the running turn once, by turnId", async () => {
      const gate = deferred();
      const { requests } = await boot([
        [delta("One. Two"), { gate: gate.promise }, done("One. Two")],
        [delta("Answer."), done("Answer.")],
      ]);
      say("first");
      await vi.waitFor(() => expect(speaks()).toHaveLength(1));
      const firstTurn = speaks()[0].turnId;
      chat("second");
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      await vi.waitFor(() => expect(summaries).toHaveLength(2));
      expect(sent("speak_cancel")).toEqual([
        { type: "speak_cancel", sessionId: SESSION, turnId: firstTurn },
      ]);
      expect(summaries[0].status).toBe("cancelled");
    });

    it("finish policy does not flush earlier speech on chat", async () => {
      await boot(
        [
          [delta("First part. Second part."), done("First part. Second part.")],
          [delta("Sure."), done("Sure.")],
        ],
        { config: { interruptPolicy: "finish" } },
      );
      say("tell me");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      chat("next");
      await vi.waitFor(() => expect(summaries).toHaveLength(2));
      expect(sent("speak_cancel")).toHaveLength(0);
    });

    it("a voice final does not flush earlier speech (the runner's barge-in does)", async () => {
      await boot([
        [delta("First part. Second part."), done("First part. Second part.")],
        [delta("Sure."), done("Sure.")],
      ]);
      say("tell me");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      say("next");
      await vi.waitFor(() => expect(summaries).toHaveLength(2));
      expect(sent("speak_cancel")).toHaveLength(0);
    });

    it("speech sent with interruptible:false keeps playing", async () => {
      await boot([[delta("Sure."), done("Sure.")]], {
        config: { greeting: { text: "Welcome.", interruptible: false } },
        skipSessionAck: true,
      });
      await vi.waitFor(() => expect(speaks()).toHaveLength(1));
      chat("hi");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      expect(sent("speak_cancel")).toHaveLength(0);
    });

    it("an interruptible greeting is flushed by chat", async () => {
      await boot([[delta("Sure."), done("Sure.")]], {
        config: { greeting: { text: "Welcome.", interruptible: true } },
        skipSessionAck: true,
      });
      await vi.waitFor(() => expect(speaks()).toHaveLength(1));
      const greet = speaks()[0];
      chat("hi");
      await vi.waitFor(() =>
        expect(sent("speak_cancel")).toEqual([
          {
            type: "speak_cancel",
            sessionId: SESSION,
            requestId: greet.requestId,
          },
        ]),
      );
      settle(greet, "cancelled");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
    });

    it("bargeIn.typedMessages false: chat after generation keeps speech and writes no interruption note", async () => {
      const { requests } = await boot(
        [
          [delta("First part. Second part."), done("First part. Second part.")],
          [delta("Sure."), done("Sure.")],
        ],
        { config: { bargeIn: { mode: "project", typedMessages: false } } },
      );
      say("tell me");
      await vi.waitFor(() => expect(speaks()).toHaveLength(2));
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      settle(speaks()[0], "played", 500);
      await new Promise((r) => setTimeout(r, 0));
      chat("actually, something else");
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(sent("speak_cancel")).toHaveLength(0);
      const users = requests[1].messages.filter((m) => m.role === "user");
      const last = users.at(-1) as { text: string };
      expect(last.text).toBe("actually, something else");
      expect(last.text).not.toContain("The caller interrupted");
    });

    it("bargeIn.typedMessages false: chat does not flush earlier speech", async () => {
      await boot([[delta("Sure."), done("Sure.")]], {
        config: {
          bargeIn: { mode: "project", typedMessages: false },
          greeting: { text: "Welcome.", interruptible: true },
        },
        skipSessionAck: true,
      });
      await vi.waitFor(() => expect(speaks()).toHaveLength(1));
      chat("hi");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      expect(sent("speak_cancel")).toHaveLength(0);
    });

    it("bargeIn mode off: chat does not flush earlier speech", async () => {
      await boot([[delta("Sure."), done("Sure.")]], {
        config: {
          bargeIn: { mode: "off" },
          greeting: { text: "Welcome.", interruptible: true },
        },
        skipSessionAck: true,
      });
      await vi.waitFor(() => expect(sent("barge_in_control")).toHaveLength(1));
      const req = sent("barge_in_control")[0];
      capture.emit({
        type: "barge_in_control_ack",
        sessionId: SESSION,
        requestId: req.requestId,
        enabled: false,
        ok: true,
        reason: "applied",
      });
      await vi.waitFor(() => expect(speaks()).toHaveLength(1));
      chat("hi");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      expect(sent("speak_cancel")).toHaveLength(0);
    });
  });

  describe("toolChoice", () => {
    const timeTool = defineTool({
      name: "get_time",
      description: "time",
      inputSchema: { type: "object" },
      handler: async () => "12:00",
    });

    it("required-first-round forces a tool on each turn's first call only", async () => {
      const { requests } = await boot(
        [
          [done("", [call("c1", "get_time")])],
          [delta("It is noon."), done("It is noon.")],
          [done("", [call("c2", "get_time")])],
          [delta("Still noon."), done("Still noon.")],
        ],
        {
          config: { toolChoice: "required-first-round" },
          options: { tools: [timeTool] },
        },
      );
      say("what time is it?");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      say("and now?");
      await vi.waitFor(() => expect(summaries).toHaveLength(2));
      expect(requests.map((r) => r.toolChoice)).toEqual([
        "required",
        undefined,
        "required",
        undefined,
      ]);
    });

    it("auto (default) never forces a tool", async () => {
      const { requests } = await boot(
        [
          [done("", [call("c1", "get_time")])],
          [delta("It is noon."), done("It is noon.")],
        ],
        { options: { tools: [timeTool] } },
      );
      say("what time is it?");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      expect(requests).toHaveLength(2);
      expect(requests.every((r) => r.toolChoice === undefined)).toBe(true);
    });
  });

  describe("links", () => {
    const URL_A = "https://app.voicethere.dev/docs/pricing";
    const URL_B = "https://app.voicethere.dev/docs/llm-agents";
    const docsTool = (result: string) =>
      defineTool({
        name: "search_docs",
        description: "search",
        inputSchema: { type: "object" },
        handler: async () => result,
      });
    const allText = () =>
      JSON.stringify([
        ...speaks().map((m) => m.text),
        ...clientPayloads()
          .filter(
            (p) => p.type === "assistant_delta" || p.type === "assistant_done",
          )
          .map((p) => p.text),
      ]);

    it("keeps a URL out of speech, deltas and done, and sends it once before done", async () => {
      await boot([
        [
          delta("It costs 45 dollars. Details: https://app.voice"),
          delta("there.dev/docs/pricing"),
          done(`It costs 45 dollars. Details: ${URL_A}`),
        ],
      ]);
      capture.emit({
        type: "speech_event",
        sessionId: SESSION,
        event: {
          type: "user_speech_final",
          text: "cost?",
          utteranceId: "utt-1",
        },
      });
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      expect(allText()).not.toContain("http");
      expect(speaks().map((m) => m.text)).toEqual(["It costs 45 dollars."]);
      const payloads = clientPayloads();
      const content = payloads.filter((p) => p.type === "assistant_content");
      const turnId = speaks()[0].turnId;
      expect(content).toEqual([
        {
          type: "assistant_content",
          turnId,
          content: { kind: "link", url: URL_A },
          spoken: true,
          inReplyTo: "utt-1",
        },
      ]);
      const doneIdx = payloads.findIndex((p) => p.type === "assistant_done");
      expect(payloads.indexOf(content[0])).toBeLessThan(doneIdx);
      expect(summaries[0].linksSent).toBe(1);
      expect(summaries[0].assistantText).toBe("It costs 45 dollars.");
    });

    it("sends the same URL once per turn and keeps a markdown label", async () => {
      await boot([
        [delta(`See the [pricing page](${URL_A}). Again ${URL_A}.`), done("")],
      ]);
      chat("cost?");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      const content = clientPayloads().filter(
        (p) => p.type === "assistant_content",
      );
      expect(content).toHaveLength(1);
      expect(content[0].content).toEqual({
        kind: "link",
        url: URL_A,
        label: "pricing page",
      });
      expect("spoken" in content[0]).toBe(false);
      expect(allText()).not.toContain("http");
    });

    it("requireToolSource drops a URL that no tool returned and keeps one that a tool did", async () => {
      await boot(
        [
          [done("", [call("c1", "search_docs", { query: "price" })])],
          [delta(`Price: ${URL_A} and also ${URL_B}.`), done("")],
        ],
        {
          config: { links: { requireToolSource: true } },
          options: { tools: [docsTool(`1. Pricing — ${URL_A} (id: pricing)`)] },
        },
      );
      say("price?");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      const urls = clientPayloads()
        .filter((p) => p.type === "assistant_content")
        .map((p) => (p.content as Msg).url);
      expect(urls).toEqual([URL_A]);
      expect(allText()).not.toContain("http");
      expect(summaries[0]).toMatchObject({ linksSent: 1, linksDropped: 1 });
    });

    describe("bare domains", () => {
      const hostText = (): string => allText();

      it("requireToolSource does not offer a bare domain that no tool returned", async () => {
        await boot(
          [[delta("See voicethere.dev/pricing for plans."), done("")]],
          { config: { links: { requireToolSource: true } } },
        );
        say("price?");
        await vi.waitFor(() => expect(summaries).toHaveLength(1));
        expect(
          clientPayloads().filter((p) => p.type === "assistant_content"),
        ).toEqual([]);
        expect(summaries[0]).toMatchObject({ linksDropped: 1 });
        expect(hostText()).toContain("voicethere.dev");
        expect(hostText()).not.toContain("/pricing");
      });

      for (const [label, result] of [
        [
          "its https url",
          "1. Pricing - https://voicethere.dev/pricing (id: pricing)",
        ],
        [
          "its text as written",
          "1. Pricing - voicethere.dev/pricing (id: pricing)",
        ],
      ] as const) {
        it(`requireToolSource offers a bare domain once when a tool result holds ${label}`, async () => {
          await boot(
            [
              [done("", [call("c1", "search_docs", { query: "price" })])],
              [delta("See voicethere.dev/pricing for plans."), done("")],
            ],
            {
              config: { links: { requireToolSource: true } },
              options: { tools: [docsTool(result)] },
            },
          );
          say("price?");
          await vi.waitFor(() => expect(summaries).toHaveLength(1));
          const content = clientPayloads().filter(
            (p) => p.type === "assistant_content",
          );
          expect(content).toHaveLength(1);
          expect(content[0].content).toEqual({
            kind: "link",
            url: "https://voicethere.dev/pricing",
            label: "voicethere.dev",
          });
          expect(summaries[0]).toMatchObject({ linksSent: 1 });
          expect(hostText()).toContain("voicethere.dev");
          expect(hostText()).not.toContain("/pricing");
        });
      }

      it("mode off leaves a bare domain in the text as written", async () => {
        await boot([[delta("See voicethere.dev/pricing now."), done("")]], {
          config: { links: { mode: "off" } },
        });
        say("hi");
        await vi.waitFor(() => expect(summaries).toHaveLength(1));
        expect(
          clientPayloads().filter((p) => p.type === "assistant_content"),
        ).toEqual([]);
        expect(hostText()).toContain("voicethere.dev/pricing");
      });
    });

    it("never sends an http URL", async () => {
      await boot([[delta("Old page: http://example.com/x. Bye."), done("")]]);
      say("hi");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      expect(
        clientPayloads().filter((p) => p.type === "assistant_content"),
      ).toEqual([]);
      expect(allText()).not.toContain("http");
      expect(summaries[0].linksDropped).toBe(1);
    });

    it("caps links per turn", async () => {
      const urls = [1, 2, 3].map(
        (n) => `https://app.voicethere.dev/docs/p${n}`,
      );
      await boot([[delta(`Pages ${urls.join(" , ")} .`), done("")]], {
        config: { links: { maxPerTurn: 2 } },
      });
      say("pages?");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      expect(
        clientPayloads().filter((p) => p.type === "assistant_content"),
      ).toHaveLength(2);
      expect(summaries[0]).toMatchObject({ linksSent: 2, linksDropped: 1 });
    });

    it("mode off leaves the reply text as written", async () => {
      await boot([[delta(`See ${URL_A} now.`), done("")]], {
        config: { links: { mode: "off" } },
      });
      say("hi");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      expect(
        speaks()
          .map((m) => m.text)
          .join(" "),
      ).toContain(URL_A);
      expect(
        clientPayloads().filter((p) => p.type === "assistant_content"),
      ).toEqual([]);
    });

    it("ctx.sendContent sends an https link and rejects http", async () => {
      const errors: unknown[] = [];
      await boot([[delta("Here you go."), done("Here you go.")]], {
        options: {
          hooks: {
            onAssistantText: (text, ctx) => {
              expect(
                ctx.sendContent({
                  kind: "link",
                  url: URL_B,
                  label: " Agents ",
                }),
              ).toBe(true);
              expect(ctx.sendContent({ kind: "link", url: URL_B })).toBe(false);
              try {
                ctx.sendContent({ kind: "link", url: "http://example.com" });
              } catch (err) {
                errors.push((err as { code?: string }).code);
              }
              return text;
            },
          },
        },
      });
      chat("links?");
      await vi.waitFor(() => expect(summaries).toHaveLength(1));
      const content = clientPayloads().filter(
        (p) => p.type === "assistant_content",
      );
      expect(content.map((p) => p.content)).toEqual([
        { kind: "link", url: URL_B, label: "Agents" },
      ]);
      expect(errors).toEqual(["INVALID_CONTENT"]);
    });
  });

  describe("failedReplies", () => {
    const fail = (): Step[] => [
      { fail: new LlmProviderError("LLM_RATE_LIMITED", "slow", 429) },
    ];
    const ok = (): Step[] => [delta("Fine."), done("Fine.")];
    const MESSAGE = "Goodbye, the assistant is unavailable.";
    const FALLBACK = "Sorry, something went wrong. Please try again.";
    const disconnects = () => sent("disconnect_client");

    async function turn(text: string, n: number) {
      say(text);
      await vi.waitFor(() => expect(summaries).toHaveLength(n));
    }

    it("3 failures in a row: the message is spoken once, then one disconnect with reason llm_failed_replies", async () => {
      await boot([fail()], {
        config: { failedReplies: { closeAfter: 3, message: MESSAGE } },
      });
      await turn("a", 1);
      await turn("b", 2);
      expect(disconnects()).toHaveLength(0);
      say("c");
      await vi.waitFor(() => expect(speaks().length).toBe(3));
      expect(speaks().map((m) => m.text)).toEqual([
        FALLBACK,
        FALLBACK,
        MESSAGE,
      ]);
      expect(disconnects()).toHaveLength(0);
      const last = speaks()[2];
      speakResult(last.requestId, last.turnId);
      await vi.waitFor(() => expect(disconnects()).toHaveLength(1));
      expect(disconnects()[0]).toMatchObject({
        sessionId: SESSION,
        reason: "llm_failed_replies",
      });
      expect(
        clientPayloads().filter((p) => p.text === MESSAGE).length,
      ).toBeGreaterThan(0);
      // No further turn starts on a closing session.
      say("d");
      await new Promise((r) => setTimeout(r, 20));
      expect(summaries).toHaveLength(3);
      expect(disconnects()).toHaveLength(1);
    });

    it("fail, success, fail, fail: no close at closeAfter 3", async () => {
      await boot([fail(), ok(), fail(), fail()], {
        config: { failedReplies: { closeAfter: 3, message: MESSAGE } },
      });
      for (let i = 1; i <= 4; i += 1) {
        await turn(`m${i}`, i);
      }
      expect(summaries.map((x) => x.status)).toEqual([
        "failed",
        "completed",
        "failed",
        "failed",
      ]);
      expect(speaks().some((m) => m.text === MESSAGE)).toBe(false);
      expect(disconnects()).toHaveLength(0);
    });

    it("absent failedReplies never closes", async () => {
      await boot([fail()]);
      for (let i = 1; i <= 5; i += 1) {
        await turn(`m${i}`, i);
      }
      expect(disconnects()).toHaveLength(0);
      expect(speaks().every((m) => m.text === FALLBACK)).toBe(true);
    });

    it("uses the default message when none is configured", async () => {
      await boot([fail()], { config: { failedReplies: { closeAfter: 1 } } });
      say("a");
      await vi.waitFor(() => expect(speaks()).toHaveLength(1));
      expect(speaks()[0].text).toBe(
        "Sorry, I can't answer right now. Please try again later.",
      );
      speakResult(speaks()[0].requestId, speaks()[0].turnId);
      await vi.waitFor(() => expect(disconnects()).toHaveLength(1));
    });

    it("the speech wait is bounded: speech never completes, disconnect after FAIL_CLOSE_SPEAK_WAIT_MS", async () => {
      vi.useFakeTimers();
      await boot([fail()], {
        config: { failedReplies: { closeAfter: 1, message: MESSAGE } },
      });
      say("a");
      await vi.waitFor(() => expect(speaks()).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(FAIL_CLOSE_SPEAK_WAIT_MS - 1_000);
      expect(disconnects()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(disconnects()).toHaveLength(1);
      expect(disconnects()[0]).toMatchObject({ reason: "llm_failed_replies" });
      const row = sent("log").find(
        (m) => m.message === "closing call after failed replies",
      );
      expect(row).toBeDefined();
    });
  });
});
