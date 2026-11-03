import { describe, expect, it } from "vitest";
import type { FlowLlmCall, FlowLlmEvent } from "../../src/flow/core/index.js";
import { runLlmNode } from "../../src/flow/llm-node.js";
import { ToolRegistry } from "../../src/llm/mcp/tool-registry.js";
import type {
  LlmProvider,
  LlmRequest,
  LlmStreamEvent,
} from "../../src/llm/types.js";

type Round = LlmStreamEvent[] | "hang";

function scripted(rounds: Round[]): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  let n = 0;
  return {
    id: "openai",
    requests,
    async *stream(req) {
      requests.push(
        structuredClone({ ...req, signal: undefined }) as LlmRequest,
      );
      const round = rounds[Math.min(n, rounds.length - 1)]!;
      n += 1;
      if (round === "hang") {
        await new Promise<void>((resolve) => {
          req.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return;
      }
      for (const ev of round) yield ev;
    },
  };
}

const done = (
  text: string,
  extra: Partial<Extract<LlmStreamEvent, { type: "done" }>> = {},
): LlmStreamEvent => ({
  type: "done",
  stopReason: "end",
  text,
  toolCalls: [],
  ...extra,
});

const model = {
  provider: "openai",
  model: "m",
  apiKeySecret: "AGENT_K",
} as const;

function call(extra: Partial<FlowLlmCall> = {}): FlowLlmCall {
  return {
    model,
    system: "sys",
    messages: [{ role: "user", text: "hi" }],
    tools: "none",
    speak: true,
    ...extra,
  };
}

async function collect(
  provider: LlmProvider,
  registry: ToolRegistry | undefined,
  c: FlowLlmCall,
  o: Partial<Parameters<typeof runLlmNode>[4]> = {},
): Promise<FlowLlmEvent[]> {
  const out: FlowLlmEvent[] = [];
  const ctl = new AbortController();
  for await (const ev of runLlmNode(provider, registry, c, ctl.signal, {
    sessionId: "s1",
    ...o,
  }))
    out.push(ev);
  return out;
}

function registryWith(names: string[], calls: string[] = []): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of names)
    reg.addCustomTool({
      name,
      description: name,
      inputSchema: { type: "object" },
      handler: async () => {
        calls.push(name);
        return `result of ${name}`;
      },
    });
  return reg;
}

describe("runLlmNode", () => {
  it("splits the stream into sentences and ends with done and token usage", async () => {
    const p = scripted([
      [
        { type: "text_delta", text: "First one. Seco" },
        { type: "text_delta", text: "nd one." },
        done("First one. Second one.", {
          usage: { inputTokens: 4, outputTokens: 6 },
        }),
      ],
    ]);
    const ev = await collect(p, undefined, call());
    expect(ev).toEqual([
      { type: "sentence", text: "First one." },
      { type: "sentence", text: "Second one." },
      {
        type: "done",
        text: "First one. Second one.",
        tokens: { input: 4, output: 6 },
      },
    ]);
  });

  it("speak false emits no sentences", async () => {
    const p = scripted([
      [{ type: "text_delta", text: "Quiet." }, done("Quiet.")],
    ]);
    const ev = await collect(p, undefined, call({ speak: false }));
    expect(ev).toEqual([{ type: "done", text: "Quiet." }]);
  });

  it("a conversation that starts with the agent gets a caller opener", async () => {
    const p = scripted([[done("ok")]]);
    await collect(
      p,
      undefined,
      call({ messages: [{ role: "assistant", text: "Hello" }] }),
    );
    expect(p.requests[0]!.messages[0]).toEqual({
      role: "user",
      text: "(The call has started.)",
    });
  });

  it("a tool round: child events, then the answer", async () => {
    const calls: string[] = [];
    const reg = registryWith(["lookup"], calls);
    const p = scripted([
      [
        done("", {
          stopReason: "tool_calls",
          toolCalls: [{ id: "c1", name: "lookup", input: {} }],
        }),
      ],
      [{ type: "text_delta", text: "It is 42." }, done("It is 42.")],
    ]);
    const ev = await collect(p, reg, call({ tools: ["lookup"] }));
    expect(calls).toEqual(["lookup"]);
    expect(ev.map((e) => e.type)).toEqual(["tool", "tool", "sentence", "done"]);
    expect(ev[0]).toMatchObject({ name: "lookup", phase: "start" });
    expect(ev[1]).toMatchObject({ name: "lookup", phase: "end" });
    expect((ev[1] as any).error).toBeUndefined();
    const second = p.requests[1]!.messages;
    expect(second.at(-1)).toMatchObject({
      role: "tool",
      results: [{ callId: "c1", name: "lookup", content: "result of lookup" }],
    });
  });

  it('tools "none" sends no tools; "all" sends all; a list sends only the listed', async () => {
    const reg = registryWith(["a", "b"]);
    for (const [tools, expected] of [
      ["none", []],
      ["all", ["a", "b"]],
      [["b", "ghost"], ["b"]],
    ] as const) {
      const p = scripted([[done("x")]]);
      const logs: string[] = [];
      await collect(p, reg, call({ tools: tools as any }), {
        log: (_l, m) => logs.push(m),
      });
      expect(p.requests[0]!.tools.map((t) => t.name).sort()).toEqual([
        ...expected,
      ]);
      if (Array.isArray(tools))
        expect(logs).toEqual(["flow llm tools skipped"]);
    }
  });

  it("a tool the model asks for but was not offered is an error result, not a call", async () => {
    const calls: string[] = [];
    const reg = registryWith(["a", "b"], calls);
    const p = scripted([
      [
        done("", {
          stopReason: "tool_calls",
          toolCalls: [{ id: "c1", name: "b", input: {} }],
        }),
      ],
      [done("fine")],
    ]);
    const ev = await collect(p, reg, call({ tools: ["a"] }));
    expect(calls).toEqual([]);
    expect(
      ev.find((e) => e.type === "tool" && e.phase === "end"),
    ).toMatchObject({ error: "TOOL_ERROR" });
  });

  it("maxRounds ends the loop even when the model keeps calling tools", async () => {
    const reg = registryWith(["a"]);
    const p = scripted([
      [
        done("t", {
          stopReason: "tool_calls",
          toolCalls: [{ id: "c", name: "a", input: {} }],
        }),
      ],
    ]);
    const ev = await collect(p, reg, call({ tools: "all", maxRounds: 2 }));
    expect(p.requests).toHaveLength(2);
    expect(ev.at(-1)).toMatchObject({ type: "done" });
  });

  it("filler is yielded once, marked, when no sentence arrives in time", async () => {
    const p: LlmProvider = {
      id: "openai",
      async *stream() {
        await new Promise((r) => setTimeout(r, 120));
        yield { type: "text_delta", text: "Answer." };
        yield done("Answer.");
      },
    };
    const ev = await collect(
      p,
      undefined,
      call({ filler: { text: "One moment.", afterMs: 30 } }),
    );
    expect(ev.filter((e) => e.type === "sentence")).toEqual([
      { type: "sentence", text: "One moment.", filler: true },
      { type: "sentence", text: "Answer." },
    ]);
  });

  it("no filler when the first sentence arrives before afterMs", async () => {
    const p = scripted([
      [{ type: "text_delta", text: "Fast." }, done("Fast.")],
    ]);
    const ev = await collect(
      p,
      undefined,
      call({ filler: { text: "One moment.", afterMs: 60 } }),
    );
    expect(ev.filter((e) => e.type === "sentence")).toEqual([
      { type: "sentence", text: "Fast." },
    ]);
  });

  it("a first-token timeout raises the code withStreamBounds uses", async () => {
    const p = scripted(["hang"]);
    await expect(
      collect(p, undefined, call(), { firstTokenTimeoutMs: 40 }),
    ).rejects.toMatchObject({ code: "LLM_TIMEOUT" });
  });

  it("a stream that ends without done is LLM_PROVIDER_ERROR", async () => {
    const p = scripted([[{ type: "text_delta", text: "x" }]]);
    await expect(collect(p, undefined, call())).rejects.toMatchObject({
      code: "LLM_PROVIDER_ERROR",
    });
  });

  it("thinking blocks never reach a sentence or the answer", async () => {
    const p = scripted([
      [
        {
          type: "text_delta",
          text: "<thinking>plan it</thinking>Visible.",
        },
        done("<thinking>plan it</thinking>Visible."),
      ],
    ]);
    const ev = await collect(p, undefined, call());
    expect(ev).toEqual([
      { type: "sentence", text: "Visible." },
      { type: "done", text: "Visible." },
    ]);
  });
});
