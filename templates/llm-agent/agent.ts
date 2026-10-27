import { defineAgent } from "@voicethere/agent";
import { createLlmAgent } from "@voicethere/agent/llm";
import { openai } from "@voicethere/agent/llm/openai";
import config from "./voicethere.llm.json";
import systemPrompt from "./prompt.md";
import { tools } from "./tools";
import { hooks } from "./hooks";
import about from "./knowledge/about.md";

// The template runs on OpenRouter, which is served by the openai module, so
// switching between openai and openrouter needs no import change. Only the
// provider you import here is bundled. To use another provider, change
// "provider" in voicethere.llm.json and import its module instead:
//   anthropic → import { anthropic } from "@voicethere/agent/llm/anthropic";
//   gemini    → import { gemini } from "@voicethere/agent/llm/gemini";
//
// Knowledge (RAG) is off. To turn it on, set knowledge.store in
// voicethere.llm.json to "redis" (needs Project Redis) or "supabase" (see the
// README for the SQL). Add Markdown files under knowledge/, import each one
// above and list it in documents below. The embeddings provider module (openai)
// is already imported and registered in providers.
defineAgent(
  createLlmAgent({
    config,
    systemPrompt,
    tools,
    hooks,
    providers: [openai],
    knowledge: { documents: [{ id: "about", title: "About", text: about }] },
  }),
);
