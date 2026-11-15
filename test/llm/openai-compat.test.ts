import { afterEach, describe, expect, it } from "vitest";
import {
  buildChatCompletionParams,
  createOpenAiCompatibleProvider,
} from "../../src/llm/openai-provider.js";
import type { LlmRequest } from "../../src/llm/types.js";
import { collect, sseData, startMock, type MockServer } from "./mock-server.js";

const chunk = (delta: object, finish: string | null = null, extra = {}) =>
  sseData({
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  });

const TEXT_SSE =
  chunk({ role: "assistant", content: "Hel" }) +
  chunk({ content: "lo" }) +
  chunk({}, "stop") +
  sseData({
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [],
    usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
  }) +
  "data: [DONE]\n\n";

const TOOL_SSE =
  chunk({
    role: "assistant",
    tool_calls: [
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "get_time", arguments: "" },
      },
    ],
  }) +
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"tz":' } }] }) +
  chunk({ tool_calls: [{ index: 0, function: { arguments: '"UTC"}' } }] }) +
  chunk({}, "tool_calls") +
  "data: [DONE]\n\n";

const base: LlmRequest = {
  model: "test-model",
  system: "be brief",
  messages: [{ role: "user", text: "hi" }],
  tools: [],
};

for (const id of ["openai", "openrouter"] as const) {
  describe(`${id} adapter`, () => {
    let mock: MockServer | undefined;
    afterEach(async () => {
      await mock?.close();
      mock = undefined;
    });

    it("streams text deltas and ends with stop reason end", async () => {
      mock = await startMock([{ sse: TEXT_SSE }]);
      const p = createOpenAiCompatibleProvider({
        id,
        apiKey: "k",
        baseUrl: mock.baseUrl,
      });
      const events = await collect(p.stream({ ...base, maxOutputTokens: 50 }));
      expect(events.filter((e) => e.type === "text_delta")).toEqual([
        { type: "text_delta", text: "Hel" },
        { type: "text_delta", text: "lo" },
      ]);
      expect(events.at(-1)).toMatchObject({
        type: "done",
        stopReason: "end",
        text: "Hello",
        toolCalls: [],
        usage: { inputTokens: 7, outputTokens: 2 },
      });
      const body = mock.requests[0].body;
      expect(body.stream).toBe(true);
      expect(body.messages[0]).toEqual({ role: "system", content: "be brief" });
      expect(
        id === "openai" ? body.max_completion_tokens : body.max_tokens,
      ).toBe(50);
    });

    it("maps finish_reason length to max_tokens and reads reasoning_tokens", async () => {
      const sse =
        chunk({ role: "assistant", content: "Part" }) +
        chunk({}, "length") +
        sseData({
          id: "c1",
          object: "chat.completion.chunk",
          created: 1,
          model: "m",
          choices: [],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 300,
            total_tokens: 307,
            completion_tokens_details: { reasoning_tokens: 228 },
          },
        }) +
        "data: [DONE]\n\n";
      mock = await startMock([{ sse }]);
      const p = createOpenAiCompatibleProvider({
        id,
        apiKey: "k",
        baseUrl: mock.baseUrl,
      });
      const events = await collect(p.stream({ ...base, maxOutputTokens: 300 }));
      expect(events.at(-1)).toMatchObject({
        type: "done",
        stopReason: "max_tokens",
        text: "Part",
        usage: { inputTokens: 7, outputTokens: 300, reasoningTokens: 228 },
      });
    });

    it("leaves reasoningTokens unset when usage has no completion_tokens_details", async () => {
      mock = await startMock([{ sse: TEXT_SSE }]);
      const p = createOpenAiCompatibleProvider({
        id,
        apiKey: "k",
        baseUrl: mock.baseUrl,
      });
      const events = await collect(p.stream(base));
      const done = events.at(-1);
      expect(done?.type === "done" ? done.usage : undefined).toEqual({
        inputTokens: 7,
        outputTokens: 2,
      });
    });

    it("assembles a tool call with parsed input", async () => {
      mock = await startMock([{ sse: TOOL_SSE }]);
      const p = createOpenAiCompatibleProvider({
        id,
        apiKey: "k",
        baseUrl: mock.baseUrl,
      });
      const events = await collect(
        p.stream({
          ...base,
          tools: [
            {
              name: "get_time",
              description: "time",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        }),
      );
      expect(events.at(-1)).toMatchObject({
        type: "done",
        stopReason: "tool_calls",
        toolCalls: [{ id: "call_1", name: "get_time", input: { tz: "UTC" } }],
      });
      expect(mock.requests[0].body.tools[0]).toEqual({
        type: "function",
        function: {
          name: "get_time",
          description: "time",
          parameters: { type: "object", properties: {} },
        },
      });
    });

    it("sends tool_choice required only when asked and tools exist", async () => {
      mock = await startMock([
        { sse: TOOL_SSE },
        { sse: TOOL_SSE },
        { sse: TOOL_SSE },
      ]);
      const p = createOpenAiCompatibleProvider({
        id,
        apiKey: "k",
        baseUrl: mock.baseUrl,
      });
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
      expect(mock.requests[0].body.tool_choice).toBe("required");
      expect(mock.requests[1].body).not.toHaveProperty("tool_choice");
      expect(mock.requests[2].body).not.toHaveProperty("tool_choice");
    });

    it("replays an assistant tool turn and tool results in the provider's format", async () => {
      mock = await startMock([{ sse: TEXT_SSE }]);
      const p = createOpenAiCompatibleProvider({
        id,
        apiKey: "k",
        baseUrl: mock.baseUrl,
      });
      await collect(
        p.stream({
          ...base,
          messages: [
            { role: "user", text: "time?" },
            {
              role: "assistant",
              text: "",
              toolCalls: [
                { id: "call_1", name: "get_time", input: { tz: "UTC" } },
              ],
            },
            {
              role: "tool",
              results: [
                { callId: "call_1", name: "get_time", content: "12:00" },
                { callId: "call_2", name: "x", content: "boom", isError: true },
              ],
            },
          ],
        }),
      );
      const msgs = mock.requests[0].body.messages;
      expect(msgs[2]).toEqual({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_time", arguments: '{"tz":"UTC"}' },
          },
        ],
      });
      expect(msgs[3]).toEqual({
        role: "tool",
        tool_call_id: "call_1",
        content: "12:00",
      });
      expect(msgs[4]).toEqual({
        role: "tool",
        tool_call_id: "call_2",
        content: "ERROR: boom",
      });
    });
  });
}

describe("buildChatCompletionParams", () => {
  const tool = {
    name: "get_time",
    description: "time",
    inputSchema: { type: "object", properties: {} },
  };
  const asRecord = (p: unknown) => p as Record<string, unknown>;

  it("maps toolChoice required with tools to tool_choice required", () => {
    const p = asRecord(
      buildChatCompletionParams(
        { ...base, tools: [tool], toolChoice: "required" },
        "openrouter",
      ),
    );
    expect(p.tool_choice).toBe("required");
    expect(p.tools).toHaveLength(1);
  });

  it("maps toolChoice {name} to a function choice", () => {
    const p = asRecord(
      buildChatCompletionParams(
        { ...base, tools: [tool], toolChoice: { name: "get_time" } },
        "openrouter",
      ),
    );
    expect(p.tool_choice).toEqual({
      type: "function",
      function: { name: "get_time" },
    });
  });

  it("omits tools and tool_choice when there are no tools", () => {
    const p = asRecord(
      buildChatCompletionParams(
        { ...base, toolChoice: "required" },
        "openrouter",
      ),
    );
    expect(p).not.toHaveProperty("tools");
    expect(p).not.toHaveProperty("tool_choice");
  });

  it("uses max_tokens for openrouter and max_completion_tokens for openai", () => {
    const or = asRecord(
      buildChatCompletionParams({ ...base, maxOutputTokens: 50 }, "openrouter"),
    );
    const oa = asRecord(
      buildChatCompletionParams({ ...base, maxOutputTokens: 50 }, "openai"),
    );
    expect(or.max_tokens).toBe(50);
    expect(or).not.toHaveProperty("max_completion_tokens");
    expect(oa.max_completion_tokens).toBe(50);
    expect(oa).not.toHaveProperty("max_tokens");
  });

  it("maps assistant tool calls and tool results, prefixing ERROR: on isError", () => {
    const p = buildChatCompletionParams(
      {
        ...base,
        tools: [tool],
        messages: [
          { role: "user", text: "time?" },
          {
            role: "assistant",
            text: "",
            toolCalls: [{ id: "c1", name: "get_time", input: { tz: "UTC" } }],
          },
          {
            role: "tool",
            results: [
              { callId: "c1", name: "get_time", content: "12:00" },
              {
                callId: "c2",
                name: "get_time",
                content: "boom",
                isError: true,
              },
            ],
          },
        ],
      },
      "openrouter",
    );
    const m = p.messages as unknown as Array<Record<string, unknown>>;
    expect(m[2]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "get_time", arguments: '{"tz":"UTC"}' },
        },
      ],
    });
    expect(m[3]).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "12:00",
    });
    expect(m[4]).toEqual({
      role: "tool",
      tool_call_id: "c2",
      content: "ERROR: boom",
    });
  });
});
