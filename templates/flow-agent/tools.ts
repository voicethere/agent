import type { CustomTool } from "@voicethere/agent/llm";

// Custom tools that `llm` nodes can offer (list their names in the node's
// "tools" field). Build each one with defineTool from "@voicethere/agent/llm".
export const tools: CustomTool[] = [];
