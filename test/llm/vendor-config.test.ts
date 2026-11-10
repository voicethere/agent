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

const base: LlmRequest = {
  model: "test-model",
  system: "s",
  messages: [{ role: "user", text: "hi" }],
  tools: [],
  temperature: 0.9,
};

const OPENAI_SSE =
  sseData({
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }],
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

describe("vendorConfig reaches the provider request", () => {
  let mock: MockServer | undefined;
  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });

  for (const id of ["openai", "openrouter"] as const) {
    it(`${id} sends the keys as given; the agent's own value wins`, async () => {
      mock = await startMock([{ sse: OPENAI_SSE }]);
      const p = createOpenAiCompatibleProvider({
        id,
        apiKey: "k",
        baseUrl: mock.baseUrl,
      });
      await collect(
        p.stream({
          ...base,
          vendorConfig: { top_p: 0.3, user: "u-1", temperature: 0.1 },
        }),
      );
      const body = mock.requests[0].body;
      expect(body.top_p).toBe(0.3);
      expect(body.user).toBe("u-1");
      expect(body.temperature).toBe(0.9);
    });
  }

  it("anthropic sends the keys as given; the agent's own value wins", async () => {
    mock = await startMock([{ sse: ANTHROPIC_SSE }]);
    const p = createAnthropicProvider({ apiKey: "k", baseUrl: mock.baseUrl });
    await collect(
      p.stream({
        ...base,
        vendorConfig: {
          top_k: 5,
          metadata: { user_id: "u-1" },
          temperature: 0.1,
        },
      }),
    );
    const body = mock.requests[0].body;
    expect(body.top_k).toBe(5);
    expect(body.metadata).toEqual({ user_id: "u-1" });
    expect(body.temperature).toBe(0.9);
  });

  it("gemini sends GenerateContentConfig keys; the agent's own value wins; unknown keys are dropped by the SDK", async () => {
    mock = await startMock([{ sse: GEMINI_SSE }]);
    const p = createGeminiProvider({ apiKey: "k", baseUrl: mock.baseUrl });
    await collect(
      p.stream({
        ...base,
        vendorConfig: { topP: 0.3, temperature: 0.1, notAGeminiKey: 1 },
      }),
    );
    const body = mock.requests[0].body;
    expect(body.generationConfig.topP).toBe(0.3);
    expect(body.generationConfig.temperature).toBe(0.9);
    expect(JSON.stringify(body)).not.toContain("notAGeminiKey");
  });
});
