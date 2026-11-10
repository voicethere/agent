import { defineAgent } from "@voicethere/agent";
import { createLlmAgent } from "@voicethere/agent/llm";
import { openai } from "@voicethere/agent/llm/openai";
import config from "./voicethere.llm.json";
import systemPrompt from "./prompt.md";
import { languageSwitchAgent } from "./language";

// The runner owns the language switch: project auto-switch detects the new
// language, warms its speech models, swaps STT and voice and replays the
// utterance. This agent never calls setVoiceLanguage. It only tells the LLM
// which language the caller speaks now (language.ts), so the reply comes in
// that language, and reports the language to the client.
//
// Needs the project secret AGENT_OPENROUTER_API_KEY and the project settings
// described in README.md (auto-switch on, VoiceThere speech on both sides).
defineAgent(
  languageSwitchAgent((hooks) =>
    createLlmAgent({
      config,
      systemPrompt,
      providers: [openai],
      hooks,
    }),
  ),
);
