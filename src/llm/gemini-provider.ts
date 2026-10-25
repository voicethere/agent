import { GoogleGenAI } from "@google/genai";
import type { Content, Part } from "@google/genai";
import type {
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmStopReason,
  LlmStreamEvent,
  LlmToolCall,
} from "./types.js";

export interface GeminiConfig {
  apiKey: string;
  baseUrl?: string;
}

function toContents(messages: LlmMessage[]): Content[] {
  const out: Content[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", parts: [{ text: m.text }] });
    } else if (m.role === "assistant") {
      const parts: Part[] = (m.providerState as Part[] | undefined) ?? [
        ...(m.text ? [{ text: m.text }] : []),
        ...(m.toolCalls ?? []).map((c) => ({
          functionCall: {
            id: c.id,
            name: c.name,
            args: (c.input ?? {}) as Record<string, unknown>,
          },
        })),
      ];
      out.push({ role: "model", parts });
    } else {
      out.push({
        role: "user",
        parts: m.results.map((r) => ({
          functionResponse: {
            id: r.callId,
            name: r.name,
            response: r.isError ? { error: r.content } : { output: r.content },
          },
        })),
      });
    }
  }
  return out;
}

function mapFinish(
  reason: string | undefined,
  hasCalls: boolean,
): LlmStopReason {
  switch (reason) {
    case "STOP":
      return hasCalls ? "tool_calls" : "end";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
      return "refusal";
    default:
      return hasCalls ? "tool_calls" : "other";
  }
}

export function createGeminiProvider(config: GeminiConfig): LlmProvider {
  const ai = new GoogleGenAI({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { httpOptions: { baseUrl: config.baseUrl } } : {}),
  });
  return {
    id: "gemini",
    async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
      const stream = await ai.models.generateContentStream({
        model: req.model,
        contents: toContents(req.messages),
        config: {
          systemInstruction: req.system,
          tools: req.tools.length
            ? [
                {
                  functionDeclarations: req.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parametersJsonSchema: t.inputSchema,
                  })),
                },
              ]
            : undefined,
          temperature: req.temperature,
          maxOutputTokens: req.maxOutputTokens,
          abortSignal: req.signal,
        },
      });
      let text = "";
      const parts: Part[] = [];
      const toolCalls: LlmToolCall[] = [];
      let finish: string | undefined;
      let usage: { inputTokens?: number; outputTokens?: number } | undefined;
      for await (const chunk of stream) {
        const cand = chunk.candidates?.[0];
        for (const p of cand?.content?.parts ?? []) {
          parts.push(p);
          if (p.functionCall) {
            toolCalls.push({
              id: p.functionCall.id ?? `gemini-${toolCalls.length}`,
              name: p.functionCall.name ?? "",
              input: p.functionCall.args ?? {},
            });
          } else if (typeof p.text === "string" && p.text && !p.thought) {
            text += p.text;
            yield { type: "text_delta", text: p.text };
          }
        }
        if (cand?.finishReason) finish = cand.finishReason;
        if (chunk.usageMetadata) {
          usage = {
            inputTokens: chunk.usageMetadata.promptTokenCount,
            outputTokens: chunk.usageMetadata.candidatesTokenCount,
          };
        }
      }
      yield {
        type: "done",
        stopReason: mapFinish(finish, toolCalls.length > 0),
        text,
        toolCalls,
        providerState: parts,
        ...(usage ? { usage } : {}),
      };
    },
  };
}
