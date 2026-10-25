import { defineAgent } from "@voicethere/agent";
import { createLlmAgent } from "@voicethere/agent/llm";
import { openai } from "@voicethere/agent/llm/openai";
import config from "./voicethere.llm.json";
import systemPrompt from "./prompt.md";
import { tools } from "./tools";
import { hooks } from "./hooks";

// Only the provider you import here is bundled. To switch provider, change
// "provider" in voicethere.llm.json and import its module instead:
//   anthropic → import { anthropic } from "@voicethere/agent/llm/anthropic";
//   gemini    → import { gemini } from "@voicethere/agent/llm/gemini";
//   openrouter uses the openai module.
defineAgent(
  createLlmAgent({ config, systemPrompt, tools, hooks, providers: [openai] }),
);
