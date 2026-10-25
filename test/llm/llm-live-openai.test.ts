import { describe, expect, it } from "vitest";
import { createLlmProvider } from "../../src/llm/index.js";
import { collect } from "./mock-server.js";

describe.skipIf(process.env.LLM_LIVE_OPENAI !== "1")("live OpenAI", () => {
  const provider = () =>
    createLlmProvider({
      provider: "openai",
      apiKey: process.env.OPENAI_API_KEY ?? "",
    });

  it("live: OpenAI streams a short reply", async () => {
    const events = await collect(
      provider().stream({
        model: "gpt-4o-mini",
        system: "Reply with the single word OK.",
        messages: [{ role: "user", text: "Say OK." }],
        tools: [],
        maxOutputTokens: 40,
      }),
    );
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") expect(done.text.length).toBeGreaterThan(0);
  }, 30_000);

  it("live: OpenAI calls a tool", async () => {
    const events = await collect(
      provider().stream({
        model: "gpt-4o-mini",
        system: "Use the tool when asked.",
        messages: [{ role: "user", text: "Call get_time." }],
        tools: [
          {
            name: "get_time",
            description: "Returns the current time.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        maxOutputTokens: 40,
      }),
    );
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", stopReason: "tool_calls" });
    if (done?.type === "done") expect(done.toolCalls[0]?.name).toBe("get_time");
  }, 30_000);
});
