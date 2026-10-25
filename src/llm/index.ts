import { createAnthropicProvider } from "./anthropic-provider.js";
import { withStreamBounds } from "./bounded-provider.js";
import { createGeminiProvider } from "./gemini-provider.js";
import { createOpenAiCompatibleProvider } from "./openai-provider.js";
import { LlmProviderError } from "./types.js";
import type { LlmProvider, LlmProviderId } from "./types.js";

export interface LlmProviderConfig {
  provider: LlmProviderId;
  apiKey: string;
  baseUrl?: string;
  bounds?: Parameters<typeof withStreamBounds>[1];
}

export function createLlmProvider(config: LlmProviderConfig): LlmProvider {
  if (!config.apiKey) {
    throw new LlmProviderError("LLM_AUTH_FAILED", "API key is empty");
  }
  const { apiKey, baseUrl } = config;
  let inner: LlmProvider;
  switch (config.provider) {
    case "openai":
    case "openrouter":
      inner = createOpenAiCompatibleProvider({
        id: config.provider,
        apiKey,
        baseUrl,
      });
      break;
    case "anthropic":
      inner = createAnthropicProvider({ apiKey, baseUrl });
      break;
    case "gemini":
      inner = createGeminiProvider({ apiKey, baseUrl });
      break;
    default:
      throw new LlmProviderError(
        "LLM_BAD_REQUEST",
        `unknown provider ${String(config.provider)}`,
      );
  }
  return withStreamBounds(inner, config.bounds);
}

export { LLM_PROVIDERS, resolveModel } from "./catalog.js";
export { withStreamBounds, toLlmError } from "./bounded-provider.js";
export type { StreamBounds } from "./bounded-provider.js";
export { LlmProviderError } from "./types.js";
export type {
  LlmErrorCode,
  LlmMessage,
  LlmProvider,
  LlmProviderId,
  LlmRequest,
  LlmStopReason,
  LlmStreamEvent,
  LlmToolCall,
  LlmToolResult,
  LlmToolSpec,
} from "./types.js";
export {
  MAX_RESULT_BYTES,
  MAX_TOOLS,
  McpToolSource,
  ToolNameConflictError,
  ToolRegistry,
} from "./mcp/index.js";
export type {
  CustomTool,
  McpCallResult,
  McpLogFn,
  McpSourceStatus,
  McpToolInfo,
  McpToolSourceOptions,
  RegisteredTool,
  ToolCallContext,
  ToolCallResult,
} from "./mcp/index.js";
