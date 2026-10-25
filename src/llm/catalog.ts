import { LlmProviderError, type LlmProviderId } from "./types.js";

export const LLM_PROVIDERS: Record<
  LlmProviderId,
  { title: string; defaultModel?: string; apiKeyEnv: string; docsUrl: string }
> = {
  openai: {
    title: "OpenAI",
    defaultModel: "gpt-4o-mini",
    apiKeyEnv: "AGENT_OPENAI_API_KEY",
    docsUrl: "https://platform.openai.com/docs/api-reference/chat",
  },
  anthropic: {
    title: "Anthropic",
    defaultModel: "claude-haiku-5-5",
    apiKeyEnv: "AGENT_ANTHROPIC_API_KEY",
    docsUrl: "https://docs.anthropic.com/en/api/messages",
  },
  gemini: {
    title: "Google Gemini",
    apiKeyEnv: "AGENT_GEMINI_API_KEY",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
  },
  openrouter: {
    title: "OpenRouter",
    apiKeyEnv: "AGENT_OPENROUTER_API_KEY",
    docsUrl: "https://openrouter.ai/docs/api-reference/overview",
  },
};

export function resolveModel(provider: LlmProviderId, model?: string): string {
  const chosen = model?.trim();
  if (chosen) return chosen;
  const entry = LLM_PROVIDERS[provider];
  if (entry.defaultModel) return entry.defaultModel;
  throw new LlmProviderError(
    "LLM_BAD_REQUEST",
    `model is required for ${entry.title}`,
  );
}
