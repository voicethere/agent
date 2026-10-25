import { createGeminiProvider } from "./gemini-provider.js";
import type { LlmProviderModule } from "./types.js";

export { createGeminiProvider };

/** Serves the `gemini` provider. */
export const gemini: LlmProviderModule = {
  ids: ["gemini"],
  create: ({ apiKey, baseUrl }) => createGeminiProvider({ apiKey, baseUrl }),
};
