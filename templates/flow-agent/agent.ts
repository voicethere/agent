import { defineAgent } from "@voicethere/agent";
import { createFlowAgent } from "@voicethere/agent/flow";
import { openai } from "@voicethere/agent/llm/openai";
import flow from "./voicethere.flow.json";
import { tools } from "./tools";

// The template runs on OpenRouter, which is served by the openai module, so
// switching between openai and openrouter needs no import change. Only the
// provider you import here is bundled. To use another provider, change
// "provider" in the "models" block of voicethere.flow.json and import its
// module instead:
//   anthropic → import { anthropic } from "@voicethere/agent/llm/anthropic";
//   gemini    → import { gemini } from "@voicethere/agent/llm/gemini";
defineAgent(createFlowAgent({ flow, tools, providers: [openai] }));
