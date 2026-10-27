export { createLlmProvider, createLlmEmbedder } from "./providers.js";
export {
  withEmbedBounds,
  DEFAULT_EMBEDDING_DIMS,
  DEFAULT_EMBEDDING_MODEL,
} from "./bounded-embedder.js";
export type { EmbedBounds } from "./bounded-embedder.js";
export type { LlmProviderConfig } from "./providers.js";
export { LLM_PROVIDERS, resolveModel } from "./catalog.js";
export { withStreamBounds, toLlmError } from "./bounded-provider.js";
export type { StreamBounds } from "./bounded-provider.js";
export { LlmProviderError } from "./types.js";
export type {
  EmbeddingsRequest,
  EmbeddingsResult,
  LlmEmbedder,
  LlmErrorCode,
  LlmProviderModule,
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
  ToolCallLogOptions,
  ToolCallResult,
} from "./mcp/index.js";
export { secretValuesFromEnv } from "./agent/redact.js";
export type { ToolCallLogMode } from "./agent/redact.js";
export { createLlmAgent } from "./agent/create-llm-agent.js";
export type { CreateLlmAgentOptions } from "./agent/create-llm-agent.js";
export { defineTool } from "./agent/define-tool.js";
export {
  LLM_AGENT_CONFIG_DEFAULTS,
  LLM_AGENT_CONFIG_JSON_SCHEMA,
  validateLlmAgentConfig,
} from "./agent/config.js";
export type {
  LlmAgentConfig,
  LlmAgentConfigError,
  LlmAgentConfigResult,
  LlmAgentFillerSituation,
  LlmAgentFillers,
  LlmAgentGreeting,
  LlmAgentKnowledgeConfig,
  LlmAgentKnowledgeEmbeddings,
  LlmAgentMcpAuth,
  LlmAgentMcpSource,
  LlmAgentServiceSource,
  LlmAgentToolFiller,
  LlmAgentToolSource,
  LlmAgentToolsConfig,
} from "./agent/config.js";
export { CALL_AGENT_PROMPT_GUIDANCE } from "./agent/prompt-guidance.js";
export { SentenceSplitter } from "./agent/sentence-splitter.js";
export { ConversationHistory } from "./agent/history.js";
export type { LlmAgentHooks, TurnContext, TurnSummary } from "./agent/hooks.js";
export {
  chunkMarkdown,
  createRedisKnowledgeBase,
  createSupabaseKnowledgeBase,
  KnowledgeIndexError,
  searchKnowledgeTool,
} from "./knowledge/index.js";
export type {
  ChunkOptions,
  IndexReport,
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgeIndexErrorCode,
  KnowledgeLimits,
  KnowledgeLogger,
  KnowledgeRedisClient,
  MarkdownChunk,
  RedisKnowledgeBaseOptions,
  SearchKnowledgeToolOptions,
  SupabaseKnowledgeBaseOptions,
  SupabaseKnowledgeCacheOptions,
} from "./knowledge/index.js";
