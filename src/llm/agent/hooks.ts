import type { LlmMessage } from "../types.js";

export interface TurnContext {
  sessionId: string;
  turnId: string;
  inputText: string;
  source: "voice" | "chat";
  signal: AbortSignal;
  /** Speak within this turn (same turnId), split into sentences. */
  speak(text: string, opts?: { interruptible?: boolean }): void;
}

export interface TurnSummary {
  turnId: string;
  status: "completed" | "interrupted" | "cancelled" | "failed" | "discarded";
  assistantText: string;
  toolCalls: { name: string; isError: boolean; ms: number }[];
  llmCalls: number;
  firstTokenMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  errorCode?: string;
}

type MaybePromise<T> = T | Promise<T>;

export interface LlmAgentHooks {
  onBeforeLlmCall?(
    messages: LlmMessage[],
    ctx: TurnContext,
  ): MaybePromise<LlmMessage[] | void>;
  /** Return null or an empty string to drop the sentence. */
  onAssistantText?(
    text: string,
    ctx: TurnContext,
  ): MaybePromise<string | null | void>;
  onToolCall?(
    call: { name: string; args: unknown },
    ctx: TurnContext,
  ): MaybePromise<{ result: string; isError?: boolean } | void>;
  onToolResult?(
    r: { name: string; args: unknown; result: string; isError: boolean },
    ctx: TurnContext,
  ): MaybePromise<string | void>;
  onTurnEnd?(summary: TurnSummary, ctx: TurnContext): MaybePromise<void>;
  respond?(
    ctx: TurnContext,
    next: () => Promise<TurnSummary>,
  ): Promise<TurnSummary | void>;
}
