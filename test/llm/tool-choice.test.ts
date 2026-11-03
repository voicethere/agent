import { afterEach, describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../../src/llm/anthropic-provider.js";
import { createGeminiProvider } from "../../src/llm/gemini-provider.js";
import { createOpenAiCompatibleProvider } from "../../src/llm/openai-provider.js";
import type { LlmRequest } from "../../src/llm/types.js";
import {
  collect,
  sseData,
  sseEvent,
  startMock,
  type MockServer,
} from "./mock-server.js";

const tools = [
  {
    name: "choose_path",
    description: "pick",
    inputSchema: { type: "object" },
  },
];
const base: LlmRequest = {
  model: "test-model",
  system: "s",
  messages: [{ role: "user", text: "hi" }],
  tools,
};

const OPENAI_SSE =
  sseData({
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "ok" },
        finish_reason: null,
      },
    ],
  }) +
  sseData({
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  }) +
  "data: [DONE]\n\n";

const ANTHROPIC_SSE =
  sseEvent("message_start", {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "m",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }) +
  sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  }) +
  sseEvent("message_stop", { type: "message_stop" });

const GEMINI_SSE = sseData({
  candidates: [
    {
      content: { role: "model", parts: [{ text: "ok" }] },
      finishReason: "STOP",
    },
  ],
});

describe("toolChoice { name }", () => {
  let mock: MockServer | undefined;
  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });

  for (const id of ["openai", "openrouter"] as const) {
    it(`${id} sends tool_choice {type:"function",function:{name}}`, async () => {
      mock = await startMock([{ sse: OPENAI_SSE }, { sse: OPENAI_SSE }]);
      const p = createOpenAiCompatibleProvider({
        id,
        apiKey: "k",
        baseUrl: mock.baseUrl,
      });
      await collect(p.stream({ ...base, toolChoice: { name: "choose_path" } }));
      await collect(p.stream(base));
      expect(mock.requests[0].body.tool_choice).toEqual({
        type: "function",
        function: { name: "choose_path" },
      });
      expect(mock.requests[1].body).not.toHaveProperty("tool_choice");
    });
  }

  it("anthropic sends tool_choice {type:'tool',name}", async () => {
    mock = await startMock([{ sse: ANTHROPIC_SSE }, { sse: ANTHROPIC_SSE }]);
    const p = createAnthropicProvider({ apiKey: "k", baseUrl: mock.baseUrl });
    await collect(p.stream({ ...base, toolChoice: { name: "choose_path" } }));
    await collect(p.stream(base));
    expect(mock.requests[0].body.tool_choice).toEqual({
      type: "tool",
      name: "choose_path",
    });
    expect(mock.requests[1].body).not.toHaveProperty("tool_choice");
  });

  it("gemini sends functionCallingConfig ANY with allowedFunctionNames", async () => {
    mock = await startMock([{ sse: GEMINI_SSE }, { sse: GEMINI_SSE }]);
    const p = createGeminiProvider({ apiKey: "k", baseUrl: mock.baseUrl });
    await collect(p.stream({ ...base, toolChoice: { name: "choose_path" } }));
    await collect(p.stream(base));
    expect(mock.requests[0].body.toolConfig).toEqual({
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: ["choose_path"],
      },
    });
    expect(mock.requests[1].body).not.toHaveProperty("toolConfig");
  });
});
