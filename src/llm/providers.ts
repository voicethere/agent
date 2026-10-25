import { withStreamBounds } from "./bounded-provider.js";
import { LlmProviderError } from "./types.js";
import type { LlmProvider, LlmProviderId, LlmProviderModule } from "./types.js";

export interface LlmProviderConfig {
  provider: LlmProviderId;
  apiKey: string;
  baseUrl?: string;
  bounds?: Parameters<typeof withStreamBounds>[1];
}

/** Subpath of `@voicethere/agent/llm/` that serves a provider id. */
export function moduleSubpath(
  id: LlmProviderId,
): "openai" | "anthropic" | "gemini" {
  switch (id) {
    case "openai":
    case "openrouter":
      return "openai";
    case "anthropic":
      return "anthropic";
    case "gemini":
      return "gemini";
  }
}

export function createLlmProvider(
  config: LlmProviderConfig,
  modules: readonly LlmProviderModule[],
): LlmProvider {
  if (!config.apiKey) {
    throw new LlmProviderError("LLM_AUTH_FAILED", "API key is empty");
  }
  const mod = modules.find((m) => m.ids.includes(config.provider));
  if (!mod) {
    throw new LlmProviderError(
      "LLM_BAD_REQUEST",
      `provider ${String(config.provider)} is not registered; import it from @voicethere/agent/llm/${moduleSubpath(config.provider)} and pass it in providers`,
    );
  }
  const inner = mod.create({
    id: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });
  return withStreamBounds(inner, config.bounds);
}
