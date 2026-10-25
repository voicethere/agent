import { createAnthropicProvider } from "./anthropic-provider.js";
import type { LlmProviderModule } from "./types.js";

export { createAnthropicProvider };

/** Serves the `anthropic` provider. */
export const anthropic: LlmProviderModule = {
  ids: ["anthropic"],
  create: ({ apiKey, baseUrl }) => createAnthropicProvider({ apiKey, baseUrl }),
};
