import { defineAgent } from "@voicethere/agent";
import { createLlmAgent } from "@voicethere/agent/llm";
import { openai } from "@voicethere/agent/llm/openai";
import config from "./voicethere.llm.json";
import systemPrompt from "./prompt.md";
import { tools } from "./tools";
import { hooks, wrapHandlers } from "./hooks";

// Same agent as llm-agent, plus end-user identity: the ticket tools in tools.ts
// show up only for a verified user, and hooks.ts loads that user's open tickets
// and earlier conversations into the model's context. wrapHandlers adds the
// session handlers (start, login mid-call, end) around the LLM agent's own.
//
// To use another provider, change "provider" in voicethere.llm.json and import
// its module instead:
//   anthropic → import { anthropic } from "@voicethere/agent/llm/anthropic";
//   gemini    → import { gemini } from "@voicethere/agent/llm/gemini";
defineAgent(
  wrapHandlers(
    createLlmAgent({
      config,
      systemPrompt,
      tools,
      hooks,
      endUserTools: true,
      providers: [openai],
    }),
  ),
);
