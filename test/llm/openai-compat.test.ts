import { afterEach, describe, expect, it } from "vitest";
import { createOpenAiCompatibleProvider } from "../../src/llm/openai-provider.js";
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
