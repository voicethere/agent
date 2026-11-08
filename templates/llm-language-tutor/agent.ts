import { defineAgent } from "@voicethere/agent";
import { createLlmAgent } from "@voicethere/agent/llm";
import { openai } from "@voicethere/agent/llm/openai";
import config from "./voicethere.llm.json";
import systemPrompt from "./prompt.md";
import lessons from "./knowledge/lessons.md";

// Needs Project Redis enabled (the lessons are indexed there at start) and the
// project secret AGENT_OPENROUTER_API_KEY, which serves both the chat model
// and the embeddings. To teach another language, change prompt.md and the
// project's voice language (see /docs/spoken-language), then replace the
// lessons in knowledge/lessons.md.
defineAgent(
  createLlmAgent({
    config,
    systemPrompt,
    providers: [openai],
    knowledge: {
      documents: [{ id: "lessons", title: "Lessons", text: lessons }],
    },
  }),
);
