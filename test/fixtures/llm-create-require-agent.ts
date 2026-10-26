/**
 * Bundle fixture: the LLM agent (its MCP tool source imports `createRequire` from
 * "node:module") plus an entry that imports `createRequire` itself. Both are hoisted
 * to the bundle top level next to the bundle banner.
 */
import { createRequire } from "node:module";

import { defineAgent } from "../../src/index.js";
import { createLlmAgent } from "../../src/llm/index.js";
import type { LlmProviderModule } from "../../src/llm/index.js";

const scripted: LlmProviderModule = {
  ids: ["openai"],
  create: () => ({
    id: "openai",
    async *stream() {
      yield { type: "done", stopReason: "end", text: "", toolCalls: [] };
    },
  }),
};

export const entryRequire = createRequire(import.meta.url);

defineAgent(
  createLlmAgent({
    config: {
      version: 1,
      provider: "openai",
      model: "scripted",
      apiKeySecret: "AGENT_OPENAI_API_KEY",
      greeting: { text: "Ready.", interruptible: true },
    },
    systemPrompt: "Fixture.",
    providers: [scripted],
  }),
);
