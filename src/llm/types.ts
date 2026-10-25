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

export type LlmErrorCode =
  | "LLM_PROVIDER_ERROR"
  | "LLM_RATE_LIMITED"
  | "LLM_AUTH_FAILED"
  | "LLM_TIMEOUT"
  | "LLM_ABORTED"
  | "LLM_BAD_REQUEST";

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
