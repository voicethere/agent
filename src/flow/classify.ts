import { ROUTE_TOOL_NAME, buildClassifyCall } from "./core/route.js";
import type { FlowClassifyCall } from "./core/effects.js";
import {
  LlmProviderError,
  type LlmMessage,
  type LlmProvider,
} from "../llm/types.js";

export interface ClassifyResult {
  path: string;
  tokens?: { input?: number; output?: number };
}

/**
 * Classifier effect: one forced `choose_path` tool call on `provider`.
 * Resolves with a path id from `req.paths` or `"none"` (only when the model
 * chose `none` explicitly). A reply with no `choose_path` call, or with a path
 * outside the enum, rejects with `LlmProviderError` code `LLM_CLASSIFIER_NO_CALL`
 * so the route takes `onError`.
 */
export function createClassifier(
  provider: LlmProvider,
): (req: FlowClassifyCall, signal: AbortSignal) => Promise<ClassifyResult> {
  return async (req, signal) => {
    const prompt = buildClassifyCall(req.paths, req.input, req.history);
    const messages: LlmMessage[] = [
      ...prompt.history.map((h) => ({ role: h.role, text: h.text })),
      { role: "user", text: prompt.user },
    ];
    const allowed = new Set([...req.paths.map((p) => p.id), "none"]);
    let path: string | undefined;
    let sawCall = false;
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
      if (call) sawCall = true;
      if (input && typeof input.path === "string" && allowed.has(input.path))
        path = input.path;
      if (ev.usage)
        tokens = {
          input: ev.usage.inputTokens,
          output: ev.usage.outputTokens,
        };
    }
    if (path === undefined)
      throw new LlmProviderError(
        "LLM_CLASSIFIER_NO_CALL",
        !sawCall
          ? `classifier returned no ${ROUTE_TOOL_NAME} call`
          : "classifier returned a path outside the enum",
      );
    return { path, ...(tokens ? { tokens } : {}) };
  };
}
