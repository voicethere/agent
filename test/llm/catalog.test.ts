import { describe, expect, it } from "vitest";
import { LLM_PROVIDERS, resolveModel } from "../../src/llm/catalog.js";

describe("llm catalog", () => {
  it("resolveModel uses the catalog default", () => {
    expect(resolveModel("openai")).toBe("gpt-4o-mini");
    expect(resolveModel("anthropic", "  ")).toBe("claude-haiku-5-5");
    expect(resolveModel("openai", " gpt-x ")).toBe("gpt-x");
    expect(LLM_PROVIDERS.gemini.apiKeyEnv).toBe("AGENT_GEMINI_API_KEY");
  });

  it("resolveModel requires a model for gemini and openrouter", () => {
    expect(() => resolveModel("gemini")).toThrow(
      "model is required for Google Gemini",
    );
    expect(() => resolveModel("openrouter", "")).toThrow(
      "model is required for OpenRouter",
    );
    expect(resolveModel("gemini", "gemini-x")).toBe("gemini-x");
  });
});
