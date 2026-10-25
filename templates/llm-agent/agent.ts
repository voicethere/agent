import { defineAgent } from "@voicethere/agent";
import { createLlmAgent } from "@voicethere/agent/llm";
import config from "./voicethere.llm.json";
import systemPrompt from "./prompt.md";
import { tools } from "./tools";
import { hooks } from "./hooks";

defineAgent(createLlmAgent({ config, systemPrompt, tools, hooks }));
