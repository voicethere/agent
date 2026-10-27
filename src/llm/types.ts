export type LlmProviderId = "openai" | "anthropic" | "gemini" | "openrouter";

/** `inputSchema` is a JSON Schema object. */
export interface LlmToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface LlmToolResult {
  callId: string;
  name: string;
  content: string;
  isError?: boolean;
}

/**
 * `providerState` is whatever the adapter needs to replay that assistant turn
 * exactly (Anthropic: the final message `content`; Gemini: the model `parts`).
 * OpenAI and OpenRouter leave it undefined and rebuild from text + toolCalls.
 */
export type LlmMessage =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      toolCalls?: LlmToolCall[];
      providerState?: unknown;
    }
  | { role: "tool"; results: LlmToolResult[] };

export type LlmStopReason =
  "end" | "tool_calls" | "max_tokens" | "refusal" | "other";

export type LlmStreamEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "done";
      stopReason: LlmStopReason;
      text: string;
      toolCalls: LlmToolCall[];
      providerState?: unknown;
      usage?: { inputTokens?: number; outputTokens?: number };
    };

export interface LlmRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: LlmToolSpec[];
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly id: LlmProviderId;
  stream(req: LlmRequest): AsyncIterable<LlmStreamEvent>;
}

export interface EmbeddingsRequest {
  model: string;
  inputs: string[];
  /** Output vector length; passed to the provider only when set. */
  dimensions?: number;
  signal?: AbortSignal;
}

export interface EmbeddingsResult {
  /** One vector per input, in input order. Vectors are L2-normalized (unit length), so cosine and inner product agree. */
  vectors: number[][];
  model: string;
  dims: number;
  /** Prompt tokens, when the provider reports them. */
  inputTokens?: number;
}

export interface LlmEmbedder {
  readonly id: LlmProviderId;
  embed(req: EmbeddingsRequest): Promise<EmbeddingsResult>;
}

export type LlmErrorCode =
  | "LLM_PROVIDER_ERROR"
  | "LLM_RATE_LIMITED"
  | "LLM_AUTH_FAILED"
  | "LLM_TIMEOUT"
  | "LLM_ABORTED"
  | "LLM_BAD_REQUEST"
  | "LLM_EMBEDDINGS_UNSUPPORTED";

export class LlmProviderError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmProviderError";
  }
}

/** One provider SDK adapter. Import it from its own subpath so a bundle carries only the SDKs it uses. */
export interface LlmProviderModule {
  /** Provider ids this module serves (`openai` module serves `openai` and `openrouter`). */
  readonly ids: readonly LlmProviderId[];
  create(opts: {
    id: LlmProviderId;
    apiKey: string;
    baseUrl?: string;
  }): LlmProvider;
  /** Present only when the provider publishes an embeddings API. */
  createEmbedder?(opts: {
    id: LlmProviderId;
    apiKey: string;
    baseUrl?: string;
  }): LlmEmbedder;
}
