import { defineAgent } from "@voicethere/agent";
import { createLlmAgent } from "@voicethere/agent/llm";
import { openai } from "@voicethere/agent/llm/openai";
import config from "./voicethere.llm.json";
import systemPrompt from "./prompt.md";
import { tools } from "./tools";
import { hooks } from "./hooks";

// The template runs on OpenRouter, which is served by the openai module, so
// switching between openai and openrouter needs no import change. To use
// another provider, change "provider" in voicethere.llm.json and import its
// module instead:
//   anthropic → import { anthropic } from "@voicethere/agent/llm/anthropic";
//   gemini    → import { gemini } from "@voicethere/agent/llm/gemini";
//
// The docs come from a project service that runs the docs-rag-mcp image
// (toolSources in voicethere.llm.json), so knowledge (RAG inside the agent)
// stays off.
defineAgent(
  createLlmAgent({
    config,
    systemPrompt,
    tools,
    hooks,
    providers: [openai],
  }),
);
