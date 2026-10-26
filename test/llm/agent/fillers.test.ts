import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineTool } from "../../../src/llm/agent/define-tool.js";
import { CALL_AGENT_PROMPT_GUIDANCE } from "../../../src/llm/agent/prompt-guidance.js";
import { validateLlmAgentConfig } from "../../../src/llm/agent/config.js";
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
};

const THINK = ["Hmm.", "Okay.", "Mm-hm.", "Right."];
const CALL = ["Let me check that for you.", "One moment, I'll look that up."];
const WAIT = ["Still checking, one moment.", "Almost there."];
const FILLERS = {
  thinking: { phrases: THINK, afterMs: 1500 },
  toolCall: { phrases: CALL },
  toolWait: { phrases: WAIT, afterMs: 4000 },
};
const ALL = [...THINK, ...CALL, ...WAIT];

describe("llm fillers", () => {
  let capture: Capture;
  const summaries: TurnSummary[] = [];
  let lastTurnId = "";

  beforeEach(() => {
    resetAgentIpcStateForTests();
    process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = "false";
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    capture = installProcessMessageCapture();
    summaries.length = 0;
  });

  const gates: ReturnType<typeof deferred>[] = [];
  const mk = () => {
    const d = deferred();
    gates.push(d);
    return d;
  };

  afterEach(async () => {
    for (const g of gates) g.resolve();
    gates.length = 0;
    await vi.advanceTimersByTimeAsync(0).catch(() => {});
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 30));
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
  const texts = () => speaks().map((m) => m.text);

  async function boot(
    scripts: Step[][],
    over: {
      config?: Record<string, unknown>;
      options?: Partial<CreateLlmAgentOptions>;
    } = {},
  ) {
    const fake = fakeProvider(scripts);
    const handlers = createLlmAgent({
      config: {
        ...BASE_CONFIG,
        speech: { coalesceMs: 0 },
        fillers: FILLERS,
        ...over.config,
      },
      systemPrompt: "You are a test agent.",
      provider: fake.provider,
      env: () => ({ AGENT_TEST_KEY: "secret-value" }),
      // Read the clock per call so fake timers drive it.
      now: () => Date.now(),
      ...over.options,
      hooks: {
        onTurnEnd: (s) => {
          summaries.push(s);
        },
        onBeforeLlmCall: (_m, ctx) => {
          lastTurnId = ctx.turnId;
        },
      },
    });
    defineAgent(handlers);
    capture.emit({
      type: "session_start",
      sessionId: SESSION,
      env: { SESSION_ID: SESSION },
      speakControlAvailable: true,
    });
    await vi.waitFor(() => expect(sent("session_start_ack")).toHaveLength(1));
    const startLogs = sent("log").map((m) => String(m.message));
    capture.send.mockClear();
    return { ...fake, handlers, startLogs };
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
  const slowTool = (gate: { promise: Promise<void> }) =>
    defineTool({
      name: "slow",
      description: "slow",
      inputSchema: { type: "object" },
      handler: async () => {
        await gate.promise;
        return "ok";
      },
    });

  const ack = (i: number) =>
    capture.emit({
      type: "speak_result",
      sessionId: SESSION,
      requestId: speaks()[i].requestId,
      turnId: speaks()[i].turnId,
      status: "played",
      playedMs: 100,
    });
  const toolStep = (): Step[] => [done("", [call("c", "slow")])];

  it("thinking filler fires after afterMs", async () => {
    const gate = mk();
    await boot([[{ gate: gate.promise }, delta("Answer."), done("Answer.")]]);
    vi.useFakeTimers();
    say("hi");
    await vi.advanceTimersByTimeAsync(1400);
    expect(speaks()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(speaks()).toHaveLength(1);
    expect(THINK).toContain(texts()[0]);
    gate.resolve();
    await vi.waitFor(() => expect(texts()).toHaveLength(2));
    expect(texts()[1]).toBe("Answer.");
  });

  it("no thinking filler when the first sentence comes at 1400 ms", async () => {
    const gate = mk();
    await boot([[{ gate: gate.promise }, delta("Quick."), done("Quick.")]]);
    vi.useFakeTimers();
    say("hi");
    await vi.advanceTimersByTimeAsync(1400);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(texts()).toEqual(["Quick."]));
    await vi.advanceTimersByTimeAsync(5000);
    expect(texts()).toEqual(["Quick."]);
  });

  it("toolCall filler fires at once when no speech came before", async () => {
    const tool = mk();
    await boot([toolStep(), [delta("Done."), done("Done.")]], {
      options: { tools: [slowTool(tool)] },
    });
    vi.useFakeTimers();
    say("go");
    await vi.advanceTimersByTimeAsync(10);
    expect(speaks()).toHaveLength(1);
    expect(CALL).toContain(texts()[0]);
    tool.resolve();
  });

  it("toolCall filler is skipped when the model spoke before the tool call", async () => {
    const tool = mk();
    await boot(
      [
        [
          delta("Let me look that up. "),
          done("Let me look that up.", [call("c", "slow")]),
        ],
        [delta("Done."), done("Done.")],
      ],
      { options: { tools: [slowTool(tool)] } },
    );
    vi.useFakeTimers();
    say("go");
    await vi.advanceTimersByTimeAsync(100);
    expect(texts()).toEqual(["Let me look that up."]);
    tool.resolve();
  });

  it("toolCall filler is skipped right after a thinking filler", async () => {
    const gate = mk();
    const tool = mk();
    await boot(
      [
        [{ gate: gate.promise }, ...toolStep()],
        [delta("Done."), done("Done.")],
      ],
      {
        options: { tools: [slowTool(tool)] },
      },
    );
    vi.useFakeTimers();
    say("go");
    await vi.advanceTimersByTimeAsync(1600);
    expect(THINK).toContain(texts()[0]);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(speaks()).toHaveLength(1);
    tool.resolve();
  });

  it("toolWait fires 4000 ms into a slow tool, not for a 3 s tool", async () => {
    const tool = mk();
    await boot([toolStep(), [delta("Done."), done("Done.")]], {
      config: { fillers: { toolWait: FILLERS.toolWait } },
      options: { tools: [slowTool(tool)] },
    });
    vi.useFakeTimers();
    say("go");
    await vi.advanceTimersByTimeAsync(3900);
    expect(speaks()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(WAIT).toContain(texts()[0]);
    tool.resolve();
  });

  it("no toolWait filler for a 3 s tool", async () => {
    const tool = mk();
    await boot([toolStep(), [delta("Done."), done("Done.")]], {
      config: { fillers: { toolWait: FILLERS.toolWait } },
      options: { tools: [slowTool(tool)] },
    });
    vi.useFakeTimers();
    say("go");
    await vi.advanceTimersByTimeAsync(3000);
    tool.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(texts()).toEqual(["Done."]));
    await vi.advanceTimersByTimeAsync(10000);
    expect(texts()).toEqual(["Done."]);
  });

  it("caps: 1 thinking, 1 toolCall, 2 toolWait, 3 in total; no phrase twice in a row", async () => {
    const gate = mk();
    const tool1 = mk();
    const tool2 = mk();
    const tool3 = mk();
    let n = 0;
    const slow = defineTool({
      name: "slow",
      description: "slow",
      inputSchema: { type: "object" },
      handler: async () => {
        n += 1;
        await [tool1, tool2, tool3][n - 1].promise;
        return "ok";
      },
    });
    await boot(
      [
        [{ gate: gate.promise }, ...toolStep()],
        toolStep(),
        toolStep(),
        [delta("Done."), done("Done.")],
      ],
      {
        config: {
          fillers: { ...FILLERS, toolWait: { phrases: WAIT, afterMs: 1000 } },
        },
        options: { tools: [slow], random: () => 0 },
      },
    );
    vi.useFakeTimers();
    say("go");
    await vi.advanceTimersByTimeAsync(1600);
    expect(speaks()).toHaveLength(1); // thinking
    gate.resolve();
    await vi.advanceTimersByTimeAsync(2500); // toolCall skipped (<2 s? no, 2.5s) -> spoken
    await vi.advanceTimersByTimeAsync(30000);
    tool1.resolve();
    await vi.advanceTimersByTimeAsync(30000);
    tool2.resolve();
    await vi.advanceTimersByTimeAsync(30000);
    const fillers = texts().filter((t) => ALL.includes(String(t)));
    expect(fillers.length).toBeLessThanOrEqual(3);
    expect(fillers.filter((t) => THINK.includes(String(t)))).toHaveLength(1);
    expect(
      fillers.filter((t) => CALL.includes(String(t))).length,
    ).toBeLessThanOrEqual(1);
    expect(
      fillers.filter((t) => WAIT.includes(String(t))).length,
    ).toBeLessThanOrEqual(2);
    for (let i = 1; i < fillers.length; i += 1) {
      expect(fillers[i]).not.toBe(fillers[i - 1]);
    }
    tool3.resolve();
  });

  it("does not repeat the previous filler across turns", async () => {
    const g1 = mk();
    const g2 = mk();
    await boot(
      [
        [{ gate: g1.promise }, delta("A."), done("A.")],
        [{ gate: g2.promise }, delta("B."), done("B.")],
      ],
      { options: { random: () => 0 } },
    );
    vi.useFakeTimers();
    say("one");
    await vi.advanceTimersByTimeAsync(1600);
    g1.resolve();
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    say("two");
    await vi.advanceTimersByTimeAsync(1600);
    g2.resolve();
    await vi.waitFor(() => expect(summaries).toHaveLength(2));
    const fillers = texts().filter((t) => THINK.includes(String(t)));
    expect(fillers).toHaveLength(2);
    expect(fillers[0]).not.toBe(fillers[1]);
  });

  it("barge-in cancels the pending filler", async () => {
    const gate = mk();
    await boot([[{ gate: gate.promise }, delta("Late."), done("Late.")]], {
      config: { interruptPolicy: "finish" },
    });
    vi.useFakeTimers();
    say("hi");
    await vi.advanceTimersByTimeAsync(500);
    capture.emit({
      type: "agent_interrupted",
      sessionId: SESSION,
      turnId: lastTurnId,
      replyPlayedMs: 0,
      playedText: "",
      unplayedText: "",
      playedTextExact: true,
      cancelledRequestIds: [],
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(speaks()).toHaveLength(0);
  });

  it("new input aborts the turn and cancels its pending filler", async () => {
    const gate = mk();
    await boot([
      [{ gate: gate.promise }, delta("Old."), done("Old.")],
      [delta("New."), done("New.")],
    ]);
    vi.useFakeTimers();
    say("first");
    await vi.advanceTimersByTimeAsync(500);
    say("second");
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(texts()).toContain("New."));
    await vi.advanceTimersByTimeAsync(5000);
    expect(texts()).toEqual(["New."]);
  });

  it("tools.filler still works alone", async () => {
    const tool = mk();
    await boot([toolStep(), [delta("Done."), done("Done.")]], {
      config: {
        fillers: undefined,
        tools: { filler: { text: "Legacy text.", afterMs: 1500 } },
      },
      options: { tools: [slowTool(tool)] },
    });
    vi.useFakeTimers();
    say("go");
    await vi.advanceTimersByTimeAsync(1600);
    expect(texts()).toEqual(["Legacy text."]);
    tool.resolve();
  });

  it("tools.filler is ignored with a warning when fillers.toolWait is set", async () => {
    const tool = mk();
    const { startLogs } = await boot(
      [toolStep(), [delta("Done."), done("Done.")]],
      {
        config: { tools: { filler: { text: "Legacy text.", afterMs: 500 } } },
        options: { tools: [slowTool(tool)] },
      },
    );
    expect(startLogs.some((m) => m.includes("tools.filler"))).toBe(true);
    vi.useFakeTimers();
    say("go");
    await vi.advanceTimersByTimeAsync(2000);
    expect(texts()).not.toContain("Legacy text.");
    tool.resolve();
  });

  it("filler text never reaches the provider on the next turn", async () => {
    const gate = mk();
    const { requests } = await boot([
      [{ gate: gate.promise }, delta("Answer."), done("Answer.")],
      [delta("Next."), done("Next.")],
    ]);
    vi.useFakeTimers();
    say("one");
    await vi.advanceTimersByTimeAsync(1600);
    const filler = String(texts()[0]);
    gate.resolve();
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    say("two");
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(JSON.stringify(requests[1].messages)).not.toContain(filler);
    expect(summaries[0].assistantText).toBe("Answer.");
  });

  it("chat-only turn without speakChatReplies gets no filler", async () => {
    const gate = mk();
    await boot([[{ gate: gate.promise }, delta("Text."), done("Text.")]], {
      config: { speakChatReplies: false },
    });
    vi.useFakeTimers();
    chat("hello");
    await vi.advanceTimersByTimeAsync(5000);
    expect(speaks()).toHaveLength(0);
    expect(
      sent("send_to_client").some((m) => JSON.stringify(m).includes("Hmm")),
    ).toBe(false);
  });
});

describe("speech coalescing", () => {
  let capture: Capture;
  const summaries: TurnSummary[] = [];
  const gates: ReturnType<typeof deferred>[] = [];
  const mk = () => {
    const d = deferred();
    gates.push(d);
    return d;
  };
  let lastTurnId = "";

  beforeEach(() => {
    resetAgentIpcStateForTests();
    process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = "false";
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    capture = installProcessMessageCapture();
    summaries.length = 0;
  });
  afterEach(async () => {
    for (const g of gates) g.resolve();
    gates.length = 0;
    await vi.advanceTimersByTimeAsync(0).catch(() => {});
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 30));
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
  const texts = () => speaks().map((m) => m.text);

  async function boot(
    scripts: Step[][],
    over: {
      config?: Record<string, unknown>;
      tools?: CreateLlmAgentOptions["tools"];
    } = {},
  ) {
    const fake = fakeProvider(scripts);
    const handlers = createLlmAgent({
      config: { ...BASE_CONFIG, ...over.config },
      systemPrompt: "x",
      provider: fake.provider,
      env: () => ({ AGENT_TEST_KEY: "k" }),
      tools: over.tools,
      hooks: {
        onTurnEnd: (s) => {
          summaries.push(s);
        },
        onBeforeLlmCall: (_m, ctx) => {
          lastTurnId = ctx.turnId;
        },
      },
    });
    defineAgent(handlers);
    capture.emit({
      type: "session_start",
      sessionId: SESSION,
      env: { SESSION_ID: SESSION },
      speakControlAvailable: true,
    });
    await vi.waitFor(() => expect(sent("session_start_ack")).toHaveLength(1));
    capture.send.mockClear();
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
  const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const delay = (g: { promise: Promise<void> }): Step => ({ gate: g.promise });

  it("two sentences 86 ms apart then stream end: one speak with both", async () => {
    const g = mk();
    await boot(
      [
        [
          delta("That is kind. "),
          delay(g),
          delta("How can I help?"),
          done("That is kind. How can I help?"),
        ],
      ],
      {
        config: { speech: undefined },
      },
    );
    vi.useFakeTimers();
    say("hi");
    await wait(86);
    g.resolve();
    await wait(0);
    await vi.waitFor(() => expect(summaries).toHaveLength(1));
    expect(texts()).toEqual(["That is kind. How can I help?"]);
  });

  it("sentences 300 ms apart are two speaks", async () => {
    const g = mk();
    await boot(
      [
        [
          delta("First one. "),
          delay(g),
          delta("Second one."),
          done("First one. Second one."),
        ],
      ],
      {
        config: { speech: undefined },
      },
    );
    vi.useFakeTimers();
    say("hi");
    await wait(300);
    expect(texts()).toEqual(["First one."]);
    g.resolve();
    await vi.waitFor(() =>
      expect(texts()).toEqual(["First one.", "Second one."]),
    );
  });

  it("stream end flushes at once, without waiting for the window", async () => {
    await boot([[delta("Only one."), done("Only one.")]], {
      config: { speech: { coalesceMs: 1000 } },
    });
    vi.useFakeTimers();
    say("hi");
    await vi.waitFor(() => expect(texts()).toEqual(["Only one."]));
  });

  it("flushes when the buffer reaches 400 chars", async () => {
    const g = mk();
    const long = `${"word ".repeat(40).trim()}. `;
    await boot(
      [
        [
          delta(long),
          delta(long),
          delta(long),
          delta(long),
          delay(g),
          done("x"),
        ],
      ],
      {
        config: { speech: { coalesceMs: 1000 } },
      },
    );
    vi.useFakeTimers();
    say("hi");
    await wait(10);
    expect(speaks().length).toBeGreaterThanOrEqual(1);
    expect(String(texts()[0]).length).toBeGreaterThanOrEqual(400);
  });

  it("a tool call flushes pending text before the tool runs", async () => {
    const tool = mk();
    const order: string[] = [];
    const slow = defineTool({
      name: "slow",
      description: "slow",
      inputSchema: { type: "object" },
      handler: async () => {
        order.push(`tool after ${speaks().length} speaks`);
        await tool.promise;
        return "ok";
      },
    });
    await boot(
      [
        [delta("Looking. "), done("Looking.", [call("c", "slow")])],
        [delta("Done."), done("Done.")],
      ],
      { config: { speech: { coalesceMs: 1000 } }, tools: [slow] },
    );
    vi.useFakeTimers();
    say("go");
    await wait(10);
    expect(order).toEqual(["tool after 1 speaks"]);
    expect(texts()).toEqual(["Looking."]);
    tool.resolve();
  });

  it("barge-in drops the buffer", async () => {
    const g = mk();
    await boot([[delta("Buffered. "), delay(g), done("Buffered.")]], {
      config: { speech: { coalesceMs: 500 } },
    });
    vi.useFakeTimers();
    say("hi");
    await wait(100);
    capture.emit({
      type: "agent_interrupted",
      sessionId: SESSION,
      turnId: lastTurnId,
      replyPlayedMs: 0,
      playedText: "",
      unplayedText: "Buffered.",
      playedTextExact: true,
      cancelledRequestIds: [],
    });
    await wait(2000);
    expect(speaks()).toHaveLength(0);
  });

  it("coalesceMs 0 speaks every sentence on its own", async () => {
    await boot([[delta("One. Two. Three."), done("One. Two. Three.")]], {
      config: { speech: { coalesceMs: 0 } },
    });
    say("hi");
    await vi.waitFor(() => expect(texts()).toEqual(["One.", "Two.", "Three."]));
  });

  it("assistant_delta stays per sentence and immediate", async () => {
    const g = mk();
    await boot(
      [[delta("One. "), delta("Two. "), delay(g), done("One. Two.")]],
      {
        config: { speech: { coalesceMs: 1000 } },
      },
    );
    vi.useFakeTimers();
    chat("hi");
    await wait(10);
    const deltas = sent("send_to_client")
      .map((m) => m.payload as Msg)
      .filter((p) => p.type === "assistant_delta")
      .map((p) => p.text);
    expect(deltas).toEqual(["One.", "Two."]);
    expect(speaks()).toHaveLength(0);
  });

  it("a buffered sentence cancels the thinking filler", async () => {
    const g = mk();
    await boot([[delta("Reply. "), delay(g), done("Reply.")]], {
      config: {
        speech: { coalesceMs: 1000 },
        fillers: { thinking: { phrases: ["Hmm."], afterMs: 1500 } },
      },
    });
    vi.useFakeTimers();
    say("hi");
    await wait(3000);
    expect(texts()).not.toContain("Hmm.");
  });
});

describe("fillers config", () => {
  const base = {
    version: 1,
    provider: "openai",
    apiKeySecret: "AGENT_OPENAI_API_KEY",
  };
  const errs = (extra: Record<string, unknown>) => {
    const r = validateLlmAgentConfig({ ...base, ...extra });
    if (r.ok) throw new Error("expected invalid");
    return r.errors;
  };

  it("parses a valid block and trims phrases", () => {
    const r = validateLlmAgentConfig({
      ...base,
      fillers: {
        thinking: { phrases: [" Hmm. ", "Okay."], afterMs: 1500 },
        toolCall: { phrases: ["Let me check."] },
        toolWait: { phrases: ["Almost there."], afterMs: 4000 },
        interruptible: false,
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.fillers).toEqual({
        thinking: { phrases: ["Hmm.", "Okay."], afterMs: 1500 },
        toolCall: { phrases: ["Let me check."] },
        toolWait: { phrases: ["Almost there."], afterMs: 4000 },
        interruptible: false,
      });
      expect(r.warnings).toEqual([]);
    }
  });

  it("empty phrases turn a situation off without an error", () => {
    expect(
      validateLlmAgentConfig({
        ...base,
        fillers: { thinking: { phrases: [], afterMs: 800 } },
      }).ok,
    ).toBe(true);
  });

  it("names the field path of an empty phrase", () => {
    expect(errs({ fillers: { thinking: { phrases: ["Ok.", "  "] } } })).toEqual(
      [expect.objectContaining({ path: "fillers.thinking.phrases[1]" })],
    );
  });

  it("thinking phrases are at most 60 characters", () => {
    const e = errs({ fillers: { thinking: { phrases: ["x".repeat(61)] } } });
    expect(e[0]).toEqual({
      path: "fillers.thinking.phrases[0]",
      message: "must be at most 60 characters",
    });
  });

  it("toolCall phrases are at most 120 characters", () => {
    expect(
      errs({ fillers: { toolCall: { phrases: ["x".repeat(121)] } } })[0].path,
    ).toBe("fillers.toolCall.phrases[0]");
  });

  it("rejects 21 phrases", () => {
    const phrases = Array.from({ length: 21 }, (_, i) => `P${i}.`);
    expect(errs({ fillers: { toolWait: { phrases } } })[0].path).toBe(
      "fillers.toolWait.phrases",
    );
  });

  it("afterMs ranges", () => {
    expect(
      errs({ fillers: { thinking: { phrases: ["a"], afterMs: 100 } } })[0].path,
    ).toBe("fillers.thinking.afterMs");
    expect(
      errs({ fillers: { toolWait: { phrases: ["a"], afterMs: 500 } } })[0].path,
    ).toBe("fillers.toolWait.afterMs");
    expect(
      errs({ fillers: { toolWait: { phrases: ["a"], afterMs: 30001 } } })[0]
        .path,
    ).toBe("fillers.toolWait.afterMs");
  });

  it("toolCall has no afterMs; unknown fields are rejected", () => {
    expect(
      errs({ fillers: { toolCall: { phrases: ["a"], afterMs: 5 } } })[0].path,
    ).toBe("fillers.toolCall.afterMs");
    expect(errs({ fillers: { extra: 1 } })[0].path).toBe("fillers.extra");
  });

  it("warns when tools.filler is set next to fillers.toolWait", () => {
    const r = validateLlmAgentConfig({
      ...base,
      fillers: { toolWait: { phrases: ["Ok."] } },
      tools: { filler: { text: "x" } },
    });
    expect(r.ok && r.warnings[0].path).toBe("tools.filler");
  });

  it("no warning when only thinking is set", () => {
    const r = validateLlmAgentConfig({
      ...base,
      fillers: { thinking: { phrases: ["Ok."] } },
      tools: { filler: { text: "x" } },
    });
    expect(r.ok && r.warnings).toEqual([]);
  });

  it("speech.coalesceMs range", () => {
    expect(
      validateLlmAgentConfig({ ...base, speech: { coalesceMs: 0 } }).ok,
    ).toBe(true);
    expect(
      validateLlmAgentConfig({ ...base, speech: { coalesceMs: 1000 } }).ok,
    ).toBe(true);
    expect(errs({ speech: { coalesceMs: 1001 } })[0].path).toBe(
      "speech.coalesceMs",
    );
    expect(errs({ speech: { coalesceMs: -1 } })[0].path).toBe(
      "speech.coalesceMs",
    );
    expect(errs({ speech: { x: 1 } })[0].path).toBe("speech.x");
  });
});

describe("llm-agent template fillers", () => {
  it("template config validates and has fillers", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
    const config = JSON.parse(
      readFileSync(
        join(root, "templates/llm-agent/voicethere.llm.json"),
        "utf8",
      ),
    );
    const r = validateLlmAgentConfig(config);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.fillers).toEqual({
        thinking: {
          phrases: ["Hmm.", "Okay.", "Mm-hm.", "Right."],
          afterMs: 1500,
        },
        toolCall: {
          phrases: [
            "Let me check that for you.",
            "One moment, I'll look that up.",
          ],
        },
        toolWait: {
          phrases: ["Still checking, one moment.", "Almost there."],
          afterMs: 4000,
        },
        interruptible: true,
      });
      expect(r.warnings).toEqual([]);
    }
  });

  it("prompt.md has the Voice call section matching the exported guidance", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
    const prompt = readFileSync(
      join(root, "templates/llm-agent/prompt.md"),
      "utf8",
    );
    expect(prompt).toContain("## Voice call");
    expect(prompt).toContain(CALL_AGENT_PROMPT_GUIDANCE);
  });
});
