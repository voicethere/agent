import type { LlmAgentHooks } from "@voicethere/agent/llm";

export const hooks: LlmAgentHooks = {};

// Example: rewrite or drop a sentence before it is spoken.
//
// export const hooks: LlmAgentHooks = {
//   onAssistantText: (text) => text.replace(/\*+/g, ""),
// };
//
// Example: take over a turn, then fall back to the model.
//
// export const hooks: LlmAgentHooks = {
//   respond: async (ctx, next) => {
//     if (/^(bye|goodbye)\b/i.test(ctx.inputText)) {
//       ctx.speak("Goodbye!");
//       return;
//     }
//     return next();
//   },
// };
