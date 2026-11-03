import { ROUTE_TOOL_NAME, buildClassifyCall } from "./core/route.js";
import type { FlowClassifyCall } from "./core/effects.js";
import type { LlmMessage, LlmProvider } from "../llm/types.js";

export interface ClassifyResult {
  path: string;
  tokens?: { input?: number; output?: number };
}

/** Classifier effect: one forced `choose_path` tool call on `provider`. */
export function createClassifier(
  provider: LlmProvider,
): (req: FlowClassifyCall, signal: AbortSignal) => Promise<ClassifyResult> {
  return async (req, signal) => {
    const prompt = buildClassifyCall(req.paths, req.input, req.history);
    const messages: LlmMessage[] = [
      ...prompt.history.map((h) => ({ role: h.role, text: h.text })),
      { role: "user", text: prompt.user },
    ];
    let path = "none";
    let tokens: ClassifyResult["tokens"];
    for await (const ev of provider.stream({
      model: req.model.model,
      system: prompt.system,
      messages,
      tools: [prompt.tool],
      toolChoice: { name: ROUTE_TOOL_NAME },
      temperature: 0,
      maxOutputTokens: 200,
      signal,
    })) {
      if (ev.type !== "done") continue;
      const call = ev.toolCalls.find((c) => c.name === ROUTE_TOOL_NAME);
      const input = call?.input as { path?: unknown } | undefined;
      if (input && typeof input.path === "string") path = input.path;
      if (ev.usage)
        tokens = {
          input: ev.usage.inputTokens,
          output: ev.usage.outputTokens,
        };
    }
    return { path, ...(tokens ? { tokens } : {}) };
  };
}
