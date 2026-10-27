import {
  createOpenAiCompatibleEmbedder,
  createOpenAiCompatibleProvider,
} from "./openai-provider.js";
import type { LlmProviderModule } from "./types.js";

export { createOpenAiCompatibleEmbedder, createOpenAiCompatibleProvider };

/** Serves the `openai` and `openrouter` providers. */
export const openai: LlmProviderModule = {
  ids: ["openai", "openrouter"],
  create: ({ id, apiKey, baseUrl }) =>
    createOpenAiCompatibleProvider({
      id: id as "openai" | "openrouter",
      apiKey,
      baseUrl,
    }),
  createEmbedder: ({ id, apiKey, baseUrl }) =>
    createOpenAiCompatibleEmbedder({
      id: id as "openai" | "openrouter",
      apiKey,
      baseUrl,
    }),
};
