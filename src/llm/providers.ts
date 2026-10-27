import { withStreamBounds } from "./bounded-provider.js";
import { withEmbedBounds } from "./bounded-embedder.js";
import type { EmbedBounds } from "./bounded-embedder.js";
import { LlmProviderError } from "./types.js";
import type {
  LlmEmbedder,
  LlmProvider,
  LlmProviderId,
  LlmProviderModule,
} from "./types.js";

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

export function createLlmEmbedder(
  config: LlmProviderConfig & { embedBounds?: EmbedBounds },
  modules: readonly LlmProviderModule[],
): LlmEmbedder {
  if (config.provider === "anthropic") {
    throw new LlmProviderError(
      "LLM_EMBEDDINGS_UNSUPPORTED",
      "anthropic has no embeddings API; use openai or gemini for embeddings",
    );
  }
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
  if (!mod.createEmbedder) {
    throw new LlmProviderError(
      "LLM_EMBEDDINGS_UNSUPPORTED",
      `${config.provider} has no documented embeddings API`,
    );
  }
  const inner = mod.createEmbedder({
    id: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });
  return withEmbedBounds(inner, config.embedBounds);
}
