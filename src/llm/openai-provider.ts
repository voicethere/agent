import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type {
  EmbeddingsRequest,
  EmbeddingsResult,
  LlmEmbedder,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmStopReason,
  LlmStreamEvent,
  LlmToolCall,
} from "./types.js";

export interface OpenAiCompatibleConfig {
  id: "openai" | "openrouter";
  apiKey: string;
  baseUrl?: string;
}

function toMessages(
  system: string,
  messages: LlmMessage[],
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [
    { role: "system", content: system },
  ];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text });
    } else if (m.role === "assistant") {
      const calls = m.toolCalls ?? [];
      out.push({
        role: "assistant",
        content: m.text || null,
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: {
                  name: c.name,
                  arguments: JSON.stringify(c.input ?? {}),
                },
              })),
            }
          : {}),
      });
    } else {
      for (const r of m.results) {
        out.push({
          role: "tool",
          tool_call_id: r.callId,
          content: r.isError ? `ERROR: ${r.content}` : r.content,
        });
      }
    }
  }
  return out;
}

function mapFinish(reason: string | null | undefined): LlmStopReason {
  switch (reason) {
    case "stop":
      return "end";
    case "tool_calls":
      return "tool_calls";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

function parseArgs(raw: string): unknown {
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

export function createOpenAiCompatibleProvider(
  config: OpenAiCompatibleConfig,
): LlmProvider {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL:
      config.baseUrl ??
      (config.id === "openrouter" ? "https://openrouter.ai/api/v1" : undefined),
    maxRetries: 0,
  });
  return {
    id: config.id,
    async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
      const tools: ChatCompletionTool[] = req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
      const params: ChatCompletionCreateParamsStreaming = {
        model: req.model,
        messages: toMessages(req.system, req.messages),
        stream: true,
        stream_options: { include_usage: true },
        ...(tools.length > 0 ? { tools } : {}),
        ...(req.temperature !== undefined
          ? { temperature: req.temperature }
          : {}),
        ...(req.maxOutputTokens !== undefined
          ? config.id === "openai"
            ? { max_completion_tokens: req.maxOutputTokens }
            : { max_tokens: req.maxOutputTokens }
          : {}),
      };
      const stream = await client.chat.completions.create(params, {
        signal: req.signal,
      });
      let text = "";
      let finish: string | null | undefined;
      let usage: { inputTokens?: number; outputTokens?: number } | undefined;
      const acc = new Map<number, { id: string; name: string; args: string }>();
      for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          };
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (delta?.content) {
          text += delta.content;
          yield { type: "text_delta", text: delta.content };
        }
        for (const tc of delta?.tool_calls ?? []) {
          const cur = acc.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          acc.set(tc.index, cur);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      const toolCalls: LlmToolCall[] = [...acc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, c]) => ({ id: c.id, name: c.name, input: parseArgs(c.args) }));
      yield {
        type: "done",
        stopReason: mapFinish(finish),
        text,
        toolCalls,
        ...(usage ? { usage } : {}),
      };
    },
  };
}

/**
 * Embeddings through the OpenAI SDK's typed `client.embeddings.create`.
 * OpenRouter documents a compatible `POST /embeddings` on its base URL
 * (https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request):
 * request `model`, `input` (string array), `dimensions`, `encoding_format`;
 * response `data[].embedding`, `data[].index`, `usage.prompt_tokens`.
 */
export function createOpenAiCompatibleEmbedder(
  config: OpenAiCompatibleConfig,
): LlmEmbedder {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL:
      config.baseUrl ??
      (config.id === "openrouter" ? "https://openrouter.ai/api/v1" : undefined),
    maxRetries: 0,
  });
  return {
    id: config.id,
    async embed(req: EmbeddingsRequest): Promise<EmbeddingsResult> {
      const res = await client.embeddings.create(
        {
          model: req.model,
          input: req.inputs,
          encoding_format: "float",
          ...(req.dimensions ? { dimensions: req.dimensions } : {}),
        },
        { signal: req.signal },
      );
      const ordered = [...res.data].sort((a, b) => a.index - b.index);
      const vectors = ordered.map((d) => d.embedding);
      return {
        vectors,
        model: res.model ?? req.model,
        dims: vectors[0]?.length ?? 0,
        ...(res.usage?.prompt_tokens !== undefined
          ? { inputTokens: res.usage.prompt_tokens }
          : {}),
      };
    },
  };
}
