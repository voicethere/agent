import { afterEach, describe, expect, it } from "vitest";
import { createGeminiProvider } from "../../src/llm/gemini-provider.js";
import type { LlmRequest } from "../../src/llm/types.js";
import { collect, sseData, startMock, type MockServer } from "./mock-server.js";

const cand = (parts: unknown[], finishReason?: string) => ({
  candidates: [
    {
      content: { role: "model", parts },
      ...(finishReason ? { finishReason } : {}),
    },
  ],
});

const TEXT_SSE =
  sseData(cand([{ text: "Hel" }])) +
  sseData({
    ...cand([{ text: "lo" }], "STOP"),
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
  });

const TOOL_SSE = sseData({
  ...cand(
    [{ functionCall: { name: "get_time", args: { tz: "UTC" } } }],
    "STOP",
  ),
  usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3 },
});

const base: LlmRequest = {
  model: "test-model",
  system: "be brief",
  messages: [{ role: "user", text: "hi" }],
  tools: [],
};

describe("gemini adapter", () => {
  let mock: MockServer | undefined;
  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });

  it("streams text deltas and ends with stop reason end", async () => {
    mock = await startMock([{ sse: TEXT_SSE }]);
    const p = createGeminiProvider({ apiKey: "k", baseUrl: mock.baseUrl });
    const events = await collect(p.stream(base));
    expect(
      events.filter((e) => e.type === "text_delta").map((e: any) => e.text),
    ).toEqual(["Hel", "lo"]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      stopReason: "end",
      text: "Hello",
      toolCalls: [],
      usage: { inputTokens: 4, outputTokens: 2 },
    });
    expect(mock.requests[0].url).toContain("test-model:streamGenerateContent");
    expect(mock.requests[0].body.systemInstruction).toBeDefined();
  });

  it("maps finishReason MAX_TOKENS and reads thoughtsTokenCount", async () => {
    const sse = sseData({
      ...cand([{ text: "Part" }], "MAX_TOKENS"),
      usageMetadata: {
        promptTokenCount: 4,
        candidatesTokenCount: 80,
        thoughtsTokenCount: 220,
      },
    });
    mock = await startMock([{ sse }]);
    const p = createGeminiProvider({ apiKey: "k", baseUrl: mock.baseUrl });
    const events = await collect(p.stream(base));
    expect(events.at(-1)).toMatchObject({
      type: "done",
      stopReason: "max_tokens",
      text: "Part",
      usage: { inputTokens: 4, outputTokens: 80, reasoningTokens: 220 },
    });
  });

  it("assembles a tool call with parsed input", async () => {
    mock = await startMock([{ sse: TOOL_SSE }]);
    const p = createGeminiProvider({ apiKey: "k", baseUrl: mock.baseUrl });
    const events = await collect(
      p.stream({
        ...base,
        tools: [
          {
            name: "get_time",
            description: "time",
            inputSchema: { type: "object" },
          },
        ],
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "done",
      stopReason: "tool_calls",
      toolCalls: [{ id: "gemini-0", name: "get_time", input: { tz: "UTC" } }],
    });
    expect(
      mock.requests[0].body.tools[0].functionDeclarations[0]
        .parametersJsonSchema,
    ).toEqual({ type: "object" });
  });

  it("sends function calling mode ANY only when asked and tools exist", async () => {
    mock = await startMock([
      { sse: TOOL_SSE },
      { sse: TOOL_SSE },
      { sse: TOOL_SSE },
    ]);
    const p = createGeminiProvider({ apiKey: "k", baseUrl: mock.baseUrl });
    const tools = [
      {
        name: "get_time",
        description: "time",
        inputSchema: { type: "object" },
      },
    ];
    await collect(p.stream({ ...base, tools, toolChoice: "required" }));
    await collect(p.stream({ ...base, tools }));
    await collect(p.stream({ ...base, toolChoice: "required" }));
    expect(mock.requests[0].body.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY" },
    });
    expect(mock.requests[1].body).not.toHaveProperty("toolConfig");
    expect(mock.requests[2].body).not.toHaveProperty("toolConfig");
  });

  it("replays an assistant tool turn and tool results in the provider's format", async () => {
    mock = await startMock([{ sse: TEXT_SSE }]);
    const p = createGeminiProvider({ apiKey: "k", baseUrl: mock.baseUrl });
    const parts = [{ functionCall: { name: "get_time", args: { tz: "UTC" } } }];
    await collect(
      p.stream({
        ...base,
        messages: [
          { role: "user", text: "time?" },
          {
            role: "assistant",
            text: "",
            toolCalls: [
              { id: "gemini-0", name: "get_time", input: { tz: "UTC" } },
            ],
            providerState: parts,
          },
          {
            role: "tool",
            results: [
              { callId: "gemini-0", name: "get_time", content: "12:00" },
              { callId: "gemini-1", name: "x", content: "boom", isError: true },
            ],
          },
        ],
      }),
    );
    const contents = mock.requests[0].body.contents;
    expect(contents[1]).toEqual({ role: "model", parts });
    expect(contents[2].role).toBe("user");
    expect(contents[2].parts.map((p: any) => p.functionResponse)).toEqual([
      { id: "gemini-0", name: "get_time", response: { output: "12:00" } },
      { id: "gemini-1", name: "x", response: { error: "boom" } },
    ]);
  });
});
