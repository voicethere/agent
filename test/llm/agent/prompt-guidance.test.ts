import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CALL_AGENT_PROMPT_GUIDANCE } from "../../../src/llm/agent/prompt-guidance.js";

const templatePrompts = ["llm-agent", "llm-mcp-service"].map((name) => ({
  name,
  text: readFileSync(
    new URL(`../../../templates/${name}/prompt.md`, import.meta.url),
    "utf8",
  ),
}));

describe("prompt guidance does not ask for speech before a tool call", () => {
  it("CALL_AGENT_PROMPT_GUIDANCE keeps the no-silence rule and has no pre-tool sentence", () => {
    expect(CALL_AGENT_PROMPT_GUIDANCE).toContain(
      "Always answer right away; never leave the caller in silence.",
    );
    expect(CALL_AGENT_PROMPT_GUIDANCE).not.toMatch(/Before you call a tool/i);
    expect(CALL_AGENT_PROMPT_GUIDANCE).not.toContain(
      "Let me check that for you",
    );
  });

  for (const { name, text } of templatePrompts) {
    it(`template ${name} prompt has no pre-tool sentence`, () => {
      expect(text).toContain("Always answer right away");
      expect(text).not.toMatch(/Before you call a tool/i);
      expect(text).not.toContain("Let me check that for you");
    });
  }
});
