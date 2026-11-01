import { afterEach, describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../../src/llm/anthropic-provider.js";
import type { LlmRequest } from "../../src/llm/types.js";
import {
  collect,
  sseEvent,
  startMock,
  type MockServer,
} from "./mock-server.js";

const start = (content: unknown[] = []) =>
  sseEvent("message_start", {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "m",
      content,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 1 },
    },
  });
const stop = (reason: string, out: number) =>
  sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: reason, stop_sequence: null },
    usage: { output_tokens: out },
  }) + sseEvent("message_stop", { type: "message_stop" });

const TEXT_SSE =
  start() +
  sseEvent("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }) +
  sseEvent("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Hel" },
  }) +
  sseEvent("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "lo" },
  }) +
  sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
  stop("end_turn", 5);

const TOOL_SSE =
  start() +
  sseEvent("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "tool_use",
      id: "toolu_1",
      name: "get_time",
      input: {},
    },
  }) +
  sseEvent("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"tz":' },
  }) +
  sseEvent("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '"UTC"}' },
  }) +
  sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
  stop("tool_use", 9);

const base: LlmRequest = {
  model: "test-model",
  system: "be brief",
  messages: [{ role: "user", text: "hi" }],
  tools: [],
};

describe("anthropic adapter", () => {
  let mock: MockServer | undefined;
  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });

  it("streams text deltas and ends with stop reason end", async () => {
    mock = await startMock([{ sse: TEXT_SSE }]);
    const p = createAnthropicProvider({ apiKey: "k", baseUrl: mock.baseUrl });
    const events = await collect(p.stream(base));
    expect(
      events.filter((e) => e.type === "text_delta").map((e: any) => e.text),
    ).toEqual(["Hel", "lo"]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      stopReason: "end",
      text: "Hello",
      toolCalls: [],
      usage: { inputTokens: 11, outputTokens: 5 },
    });
    const body = mock.requests[0].body;
    expect(body.system).toBe("be brief");
    expect(body.max_tokens).toBe(1024);
    expect(body.output_config).toEqual({ effort: "low" });
  });

  it("maps stop_reason max_tokens and reads output_tokens_details.thinking_tokens", async () => {
    const sse =
      start() +
      sseEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }) +
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Part" },
      }) +
      sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
      sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "max_tokens", stop_sequence: null },
        usage: {
          output_tokens: 300,
          output_tokens_details: { thinking_tokens: 210 },
        },
      }) +
      sseEvent("message_stop", { type: "message_stop" });
    mock = await startMock([{ sse }]);
    const p = createAnthropicProvider({ apiKey: "k", baseUrl: mock.baseUrl });
    const events = await collect(p.stream(base));
    expect(events.at(-1)).toMatchObject({
      type: "done",
      stopReason: "max_tokens",
      text: "Part",
      usage: { inputTokens: 11, outputTokens: 300, reasoningTokens: 210 },
    });
  });

  it("assembles a tool call with parsed input", async () => {
    mock = await startMock([{ sse: TOOL_SSE }]);
    const p = createAnthropicProvider({ apiKey: "k", baseUrl: mock.baseUrl });
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
      toolCalls: [{ id: "toolu_1", name: "get_time", input: { tz: "UTC" } }],
    });
    expect(mock.requests[0].body.tools[0]).toEqual({
      name: "get_time",
      description: "time",
      input_schema: { type: "object" },
    });
  });

  it("sends tool_choice any only when asked and tools exist", async () => {
    mock = await startMock([
      { sse: TOOL_SSE },
      { sse: TOOL_SSE },
      { sse: TOOL_SSE },
    ]);
    const p = createAnthropicProvider({ apiKey: "k", baseUrl: mock.baseUrl });
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
    expect(mock.requests[0].body.tool_choice).toEqual({ type: "any" });
    expect(mock.requests[1].body).not.toHaveProperty("tool_choice");
    expect(mock.requests[2].body).not.toHaveProperty("tool_choice");
  });

  it("replays an assistant tool turn and tool results in the provider's format", async () => {
    mock = await startMock([{ sse: TEXT_SSE }]);
    const p = createAnthropicProvider({ apiKey: "k", baseUrl: mock.baseUrl });
    const content = [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "get_time",
        input: { tz: "UTC" },
      },
    ];
    await collect(
      p.stream({
        ...base,
        messages: [
          { role: "user", text: "time?" },
          {
            role: "assistant",
            text: "",
            toolCalls: [
              { id: "toolu_1", name: "get_time", input: { tz: "UTC" } },
            ],
            providerState: content,
          },
          {
            role: "tool",
            results: [
              { callId: "toolu_1", name: "get_time", content: "12:00" },
              { callId: "toolu_2", name: "x", content: "boom", isError: true },
            ],
          },
        ],
      }),
    );
    const msgs = mock.requests[0].body.messages;
    expect(msgs[1]).toEqual({ role: "assistant", content });
    expect(msgs[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "12:00" },
        {
          type: "tool_result",
          tool_use_id: "toolu_2",
          content: "boom",
          is_error: true,
        },
      ],
    });
  });
});
