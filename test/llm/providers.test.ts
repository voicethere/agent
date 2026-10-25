import { describe, expect, it } from "vitest";

import { openai } from "../../src/llm/openai.js";
import { createLlmProvider } from "../../src/llm/providers.js";

describe("createLlmProvider", () => {
  it("throws LLM_BAD_REQUEST naming the module subpath when the provider is not registered", () => {
    let caught: (Error & { code?: string }) | undefined;
    try {
      createLlmProvider({ provider: "gemini", apiKey: "k" }, [openai]);
    } catch (e) {
      caught = e as Error & { code?: string };
    }
    expect(caught?.code).toBe("LLM_BAD_REQUEST");
    expect(caught?.message).toContain("@voicethere/agent/llm/gemini");
  });

  it("empty API key is LLM_AUTH_FAILED", () => {
    expect(() =>
      createLlmProvider({ provider: "openai", apiKey: "" }, [openai]),
    ).toThrow(/API key is empty/);
  });
});
