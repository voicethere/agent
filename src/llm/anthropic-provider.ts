import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  ContentBlockParam,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type {
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmStopReason,
  LlmStreamEvent,
  LlmToolCall,
} from "./types.js";

export interface AnthropicConfig {
  apiKey: string;
  baseUrl?: string;
}

function toMessages(messages: LlmMessage[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text });
    } else if (m.role === "assistant") {
      if (m.providerState !== undefined) {
        out.push({
          role: "assistant",
          content: m.providerState as MessageParam["content"],
        });
      } else {
        const blocks: ContentBlockParam[] = [];
        if (m.text) blocks.push({ type: "text", text: m.text });
        for (const c of m.toolCalls ?? []) {
          blocks.push({
            type: "tool_use",
            id: c.id,
            name: c.name,
            input: c.input ?? {},
          });
        }
        out.push({ role: "assistant", content: blocks });
      }
    } else {
      out.push({
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.callId,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
    }
  }
  return out;
}

function mapStop(reason: string | null | undefined): LlmStopReason {
  switch (reason) {
    case "end_turn":
      return "end";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

export function createAnthropicProvider(config: AnthropicConfig): LlmProvider {
  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    maxRetries: 0,
  });
  return {
    id: "anthropic",
    async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
      const tools: Tool[] = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Tool["input_schema"],
      }));
      const stream = client.messages.stream(
        {
          model: req.model,
          max_tokens: req.maxOutputTokens ?? 1024,
          system: req.system,
          messages: toMessages(req.messages),
          ...(tools.length > 0 ? { tools } : {}),
          ...(req.temperature !== undefined
            ? { temperature: req.temperature }
            : {}),
          output_config: { effort: "low" },
        },
        { signal: req.signal },
      );
      for await (const ev of stream) {
        if (
          ev.type === "content_block_delta" &&
          ev.delta.type === "text_delta" &&
          ev.delta.text
        ) {
          yield { type: "text_delta", text: ev.delta.text };
        }
      }
      const message = await stream.finalMessage();
      const content = message.content as ContentBlock[];
      let text = "";
      const toolCalls: LlmToolCall[] = [];
      for (const b of content) {
        if (b.type === "text") text += b.text;
        else if (b.type === "tool_use") {
          toolCalls.push({ id: b.id, name: b.name, input: b.input });
        }
      }
      yield {
        type: "done",
        stopReason: mapStop(message.stop_reason),
        text,
        toolCalls,
        providerState: message.content,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        },
      };
    },
  };
}
