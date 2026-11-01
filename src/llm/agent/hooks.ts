import type { LlmMessage, LlmStopReason } from "../types.js";

/**
 * Structured content sent to the client next to the reply text, as an
 * `assistant_content` message. Only `link` exists today; clients ignore kinds
 * they do not know.
 */
export type AgentContent = { kind: "link"; url: string; label?: string };

export interface TurnContext {
  sessionId: string;
  turnId: string;
  inputText: string;
  source: "voice" | "chat";
  signal: AbortSignal;
  /** Speak within this turn (same turnId), split into sentences. */
  speak(text: string, opts?: { interruptible?: boolean }): void;
  /**
   * Send structured content in this turn (same turnId) as an
   * `assistant_content` message. Links must be https; a URL already sent in
   * this turn is not sent again, and `links.maxPerTurn` applies. Returns
   * whether the message was sent. Throws on invalid content. In `onTurnEnd`
   * the turn is over: content is still validated, but nothing is sent and the
   * call returns false.
   */
  sendContent(content: AgentContent): boolean;
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
  /** Hidden thinking tokens (part of `outputTokens`), when the provider reports them. */
  reasoningTokens?: number;
  /** Stop reason of the last LLM round (`max_tokens`: the output cap cut the reply). */
  stopReason?: LlmStopReason;
  errorCode?: string;
  /** `assistant_content` link messages sent in this turn. */
  linksSent?: number;
  /** Links removed from the reply but not sent (http, not from a tool result, over the cap). */
  linksDropped?: number;
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
